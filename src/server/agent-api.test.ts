/**
 * The agent surface, pinned where it would rot.
 *
 * Three things are worth a test here and the rest is ordinary code: that the manifest
 * cannot advertise a route that does not exist (the promise "always up to date" is
 * otherwise a hope), that a read-only key is refused every write and told about none, and
 * that the guard's refusals are the RIGHT refusals -- a 404 where a 403 would have told an
 * agent's holder whether its owner is an admin.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { hashToken, isoIn, SESSION_COOKIE } from "../lib/auth";
import { AuthStore, applyAuthSchema } from "../lib/auth-store";
import type { Config } from "../lib/config";
import { loadConfig } from "../lib/config";
import { SiteSettingsStore, siteSettingsSeed } from "../lib/site-settings";
import type { Store } from "../lib/store";
import {
  AGENT_KEY_PATH,
  AGENT_MANIFEST_PATH,
  AGENT_OPERATIONS,
  AGENT_WAIT_MS,
  agentBucket,
  agentManifestRoute,
  agentMayCall,
  agentMayReach,
  agentWaitMs,
  bootstrapSnippet,
  renderManifest,
  routeSummaries,
  withAgentApi,
} from "./agent-api";
import { AuthService, withAuth } from "./auth-routes";

function config(over: Partial<Config["auth"]> = {}): Config {
  const base = loadConfig();
  return {
    ...base,
    auth: { ...base.auth, rpId: "localhost", origins: ["http://localhost:7979"], ...over },
  };
}

/**
 * The app routes an agent meets, shaped like the real table: bare handlers, a method table,
 * a parameterised path and an admin route. Every assertion below is about the WRAPPER, so
 * the handlers only have to say they ran.
 */
function appRoutes(): Record<string, unknown> {
  const ok = () => new Response(JSON.stringify({ ran: true }));
  return {
    "/api/health": ok,
    "/api/discover": ok,
    "/api/search": ok,
    "/api/browse": ok,
    "/api/title/:tconst": ok,
    [AGENT_MANIFEST_PATH]: ok,
    "/api/requests": { GET: ok, POST: ok },
    "/api/requests/episode": { POST: ok },
    "/api/admin/users": { GET: ok },
    "/img/t/:tconst": ok,
  };
}

interface Harness {
  auth: AuthStore;
  service: AuthService;
  logs: string[];
  routes: Record<string, unknown>;
  call: (path: string, init?: RequestInit & { cookie?: string; bearer?: string }) => Promise<Response>;
}

function harness(cfg: Config = config()): Harness {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  const auth = new AuthStore(db);
  const logs: string[] = [];

  const kv = new Map<string, string>();
  const service = new AuthService({
    auth,
    store: { listRequests: () => [] } as unknown as Store,
    cfg,
    // Nothing in this file edits a site setting; it is here because the service reads the
    // request quota through it, and an in-memory kv keeps that read off a database.
    settings: new SiteSettingsStore(
      { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => void kv.set(k, v) },
      siteSettingsSeed(cfg),
    ),
    log: (m) => logs.push(m),
    addressOf: () => "10.0.0.1",
  });

  // The real order: the agent guard INSIDE the auth guard, so an anonymous caller is refused
  // for having no credential rather than for exceeding a budget it never had.
  const guarded = withAgentApi(
    { ...appRoutes(), ...service.routes() },
    {
      principal: (req) => service.principal(req),
      limiter: (bucket) => service.agentLimiter(bucket),
      log: (m) => logs.push(m),
    },
  ) as Record<string, unknown>;
  const routes = withAuth(guarded, {
    authService: service,
    publicPaths: service.publicPaths(),
  }) as Record<string, unknown>;

  const call: Harness["call"] = async (path, init = {}) => {
    const url = new URL(path, "http://localhost:7979");
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    const req = new Request(url, { ...init, headers });

    const got = url.pathname.split("/");
    const pattern =
      url.pathname in routes
        ? url.pathname
        : (Object.keys(routes).find((p) => {
            const pat = p.split("/");
            return pat.length === got.length && pat.every((seg, i) => seg.startsWith(":") || seg === got[i]);
          }) ?? "");
    const entry = routes[pattern];
    if (!entry) return new Response("no route", { status: 404 });
    const handler =
      typeof entry === "function"
        ? entry
        : (entry as Record<string, unknown>)[(init.method ?? "GET").toUpperCase()];
    if (typeof handler !== "function") return new Response("no method", { status: 405 });
    const params: Record<string, string> = {};
    pattern.split("/").forEach((seg, i) => {
      if (seg.startsWith(":")) params[seg.slice(1)] = got[i] ?? "";
    });
    return (await (handler as (r: unknown) => Promise<Response> | Response)(
      Object.assign(req, { params }),
    )) as Response;
  };

  return { auth, service, logs, routes: guarded, call };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** A user with an agent key. Returns the plaintext, which exists only here and once. */
function keyFor(opts: { role?: "admin" | "user"; readOnly?: boolean } = {}): {
  userId: string;
  token: string;
} {
  const user = h.auth.createUser({ displayName: "agent owner", role: opts.role ?? "user" });
  const { token } = h.auth.putAgentKey({ userId: user.id, readOnly: opts.readOnly ?? false });
  return { userId: user.id, token };
}

describe("the key authenticates, and carries less than its owner", () => {
  test("a valid key reaches an ordinary route", async () => {
    const { token } = keyFor();
    const res = await h.call("/api/discover", { bearer: token });
    expect(res.status).toBe(200);
  });

  test("only the hash is stored -- the plaintext is not in the row", () => {
    const { userId, token } = keyFor();
    const rows = h.auth.agentKeysFor(userId);
    expect(rows[0]?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  /*
    REPLACES "a rotated key kills the old token in the same statement", 2026-09-07.

    That test defended the upsert on `user_id`: minting overwrote the row, so there was never
    a window where two tokens worked. It was true, and it is exactly the property that made a
    SECOND agent impossible -- two of them shared one credential, so revoking the leaked one
    killed the other. Naming keys is naming several, so the upsert is gone and this is what
    replaced it. The premise moved; the test moves with it.
  */
  test("two keys coexist, and revoking one leaves the other working", async () => {
    const { userId, token: first } = keyFor();
    const made = h.auth.putAgentKey({ userId, name: "second", readOnly: false });

    expect((await h.call("/api/discover", { bearer: first })).status).toBe(200);
    expect((await h.call("/api/discover", { bearer: made.token })).status).toBe(200);
    expect(h.auth.agentKeysFor(userId)).toHaveLength(2);

    h.auth.deleteAgentKey(made.key.id, userId);
    const second = made.token;

    // 401 rather than 403: the revoked token identifies nobody at all now. The other one is
    // untouched, which is the whole reason a person may hold more than one.
    expect((await h.call("/api/discover", { bearer: second })).status).toBe(401);
    expect((await h.call("/api/discover", { bearer: first })).status).toBe(200);
  });

  /** A key is revocable only by its OWNER: an id alone is not authority over the row. */
  test("somebody else's id revokes nothing", async () => {
    const { userId, token } = keyFor();
    const stranger = h.auth.createUser({ displayName: "stranger", role: "user" });
    const mine = h.auth.agentKeysFor(userId)[0];

    expect(h.auth.deleteAgentKey(mine.id, stranger.id)).toBe(false);
    expect((await h.call("/api/discover", { bearer: token })).status).toBe(200);
  });

  test("a revoked key is refused immediately", async () => {
    const { userId, token } = keyFor();
    h.auth.deleteAgentKeysFor(userId);
    expect((await h.call("/api/discover", { bearer: token })).status).toBe(401);
  });

  test("a disabled owner's key stops working, exactly as their session would", async () => {
    const { userId, token } = keyFor();
    h.auth.updateUser(userId, { disabled: true });
    expect((await h.call("/api/discover", { bearer: token })).status).toBe(401);
  });

  /*
    THE POINT OF D2, and the reason it is a test rather than a comment. A leaked admin agent
    key would mint invites and delete accounts; a leaked ordinary one asks for films.
  */
  test("an ADMIN's agent key gets 404 from the admin API, not 403", async () => {
    const { token } = keyFor({ role: "admin" });
    const res = await h.call("/api/admin/users", { bearer: token });
    expect(res.status).toBe(404);
    // 403 would tell the holder that the owner IS an admin. 404 is what an ordinary
    // signed-in user sees, and the admin API does not announce itself.
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("the principal is `user` whatever the owner holds", () => {
    const { token } = keyFor({ role: "admin" });
    const req = new Request("http://localhost:7979/api/discover", {
      headers: { authorization: `Bearer ${token}` },
    });
    const p = h.service.principal(req);
    expect(p?.kind).toBe("agent");
    expect(p?.role).toBe("user");
  });
});

describe("a key cannot manage identity, its own least of all", () => {
  test("the whole /api/auth prefix is closed to an agent key", async () => {
    const { token } = keyFor();
    expect((await h.call("/api/auth/me", { bearer: token })).status).toBe(404);
    expect((await h.call(AGENT_KEY_PATH, { bearer: token })).status).toBe(404);
    expect((await h.call(AGENT_KEY_PATH, { method: "POST", bearer: token })).status).toBe(404);
  });

  test("a person in a browser creates, names, reads and revokes them", async () => {
    const user = h.auth.createUser({ displayName: "person", role: "user" });
    const cookie = `${SESSION_COOKIE}=${h.auth.createSession({ userId: user.id, expiresAt: isoIn(60_000) })}`;

    expect(await (await h.call(AGENT_KEY_PATH, { cookie })).json()).toEqual({ keys: [] });

    const made = (await (
      await h.call(AGENT_KEY_PATH, {
        method: "POST",
        cookie,
        body: JSON.stringify({ name: "home-assistant", readOnly: false }),
      })
    ).json()) as { token: string; snippet: string; key: { id: string; name: string } };

    expect(made.key.name).toBe("home-assistant");
    // The snippet is what a person copies, and it carries the plaintext exactly once.
    expect(made.snippet).toContain(made.token);
    expect(made.snippet).toContain(AGENT_MANIFEST_PATH);

    // Reading it back never returns the token again -- only the sha256 was kept.
    const read = (await (await h.call(AGENT_KEY_PATH, { cookie })).json()) as {
      keys: { id: string; name: string }[];
    };
    expect(JSON.stringify(read)).not.toContain(made.token);
    expect(read.keys).toHaveLength(1);

    /*
      A SECOND key rather than a rotation. This asserted `rotated: true` on the second POST,
      which was the observable half of the upsert -- see the schema comment on `agent_key` for
      why that property was traded away. Two named rows is what replaced it.
    */
    await h.call(AGENT_KEY_PATH, {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "research-bot", readOnly: true }),
    });
    const both = (await (await h.call(AGENT_KEY_PATH, { cookie })).json()) as {
      keys: { name: string }[];
    };
    expect(both.keys.map((k) => k.name).sort()).toEqual(["home-assistant", "research-bot"]);

    // Renaming and revoking are BY ID, and both leave the other key alone.
    expect(
      (
        await h.call(`${AGENT_KEY_PATH}/${made.key.id}`, {
          method: "PATCH",
          cookie,
          body: JSON.stringify({ name: "renamed" }),
        })
      ).status,
    ).toBe(200);

    expect((await h.call(`${AGENT_KEY_PATH}/${made.key.id}`, { method: "DELETE", cookie })).status).toBe(200);
    const left = (await (await h.call(AGENT_KEY_PATH, { cookie })).json()) as { keys: { name: string }[] };
    expect(left.keys.map((k) => k.name)).toEqual(["research-bot"]);
  });

  /** An id is not authority: another account's key is a 404, never a 403 that confirms it. */
  test("somebody else's key id is a 404 from this account", async () => {
    const mine = h.auth.createUser({ displayName: "mine", role: "user" });
    const yours = h.auth.createUser({ displayName: "yours", role: "user" });
    const theirs = h.auth.putAgentKey({ userId: yours.id, readOnly: false });
    const cookie = `${SESSION_COOKIE}=${h.auth.createSession({ userId: mine.id, expiresAt: isoIn(60_000) })}`;

    expect((await h.call(`${AGENT_KEY_PATH}/${theirs.key.id}`, { method: "DELETE", cookie })).status).toBe(
      404,
    );
    expect(h.auth.agentKeysFor(yours.id)).toHaveLength(1);
  });

  test("an anonymous caller gets the ordinary 401, never a hint", async () => {
    expect((await h.call(AGENT_KEY_PATH)).status).toBe(401);
  });
});

describe("read-only means GET and HEAD", () => {
  test("a write is refused with a reason the holder can act on", async () => {
    const { token } = keyFor({ readOnly: true });
    expect((await h.call("/api/search?q=x", { bearer: token })).status).toBe(200);

    const res = await h.call("/api/requests", { method: "POST", bearer: token });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "this agent key is read-only" });
  });

  test("a read-write key may POST", async () => {
    const { token } = keyFor({ readOnly: false });
    expect((await h.call("/api/requests", { method: "POST", bearer: token })).status).toBe(200);
  });

  /*
    Stated as a fact about the METHOD rather than a list of write routes, so a route added
    next month that writes is refused by having a method that writes.
  */
  test("the rule is the method, not a list of routes", () => {
    expect(agentMayCall("GET", { readOnly: true })).toBe(true);
    expect(agentMayCall("head", { readOnly: true })).toBe(true);
    expect(agentMayCall("DELETE", { readOnly: true })).toBe(false);
    expect(agentMayCall("PATCH", { readOnly: true })).toBe(false);
    expect(agentMayCall("DELETE", { readOnly: false })).toBe(true);
  });
});

describe("two buckets, split on what the work costs", () => {
  test("the expensive set is exactly the routes that leave local SQLite", () => {
    expect(agentBucket("/api/search", "GET")).toBe("expensive");
    expect(agentBucket("/api/title/:tconst", "GET")).toBe("expensive");
    expect(agentBucket("/api/requests", "POST")).toBe("expensive");
    // The same path, read rather than written: a list of requests is a local seek.
    expect(agentBucket("/api/requests", "GET")).toBe("cheap");
    expect(agentBucket("/api/discover", "GET")).toBe("cheap");
    expect(agentBucket(AGENT_MANIFEST_PATH, "GET")).toBe("cheap");
  });

  test("exceeding a bucket is 429 with Retry-After, and the other bucket is untouched", async () => {
    const local = harness(config({ agentExpensiveRatePerMinute: 2, agentCheapRatePerMinute: 50 }));
    const user = local.auth.createUser({ displayName: "a", role: "user" });
    const { token } = local.auth.putAgentKey({ userId: user.id, readOnly: false });

    expect((await local.call("/api/search?q=a", { bearer: token })).status).toBe(200);
    expect((await local.call("/api/search?q=b", { bearer: token })).status).toBe(200);

    const refused = await local.call("/api/search?q=c", { bearer: token });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);

    // The cheap bucket has its own budget: one wall does not close the other.
    expect((await local.call("/api/discover", { bearer: token })).status).toBe(200);
  });

  test("the bucket is keyed on the KEY, so two keys do not share a budget", async () => {
    const local = harness(config({ agentExpensiveRatePerMinute: 1 }));
    const mine = local.auth.createUser({ displayName: "a", role: "user" });
    const yours = local.auth.createUser({ displayName: "b", role: "user" });
    const a = local.auth.putAgentKey({ userId: mine.id, readOnly: false }).token;
    const b = local.auth.putAgentKey({ userId: yours.id, readOnly: false }).token;

    expect((await local.call("/api/search?q=a", { bearer: a })).status).toBe(200);
    expect((await local.call("/api/search?q=a", { bearer: a })).status).toBe(429);
    expect((await local.call("/api/search?q=a", { bearer: b })).status).toBe(200);
  });

  test("a browser session pays no agent bucket at all", async () => {
    const local = harness(config({ agentExpensiveRatePerMinute: 1 }));
    const user = local.auth.createUser({ displayName: "person", role: "user" });
    const cookie = `${SESSION_COOKIE}=${local.auth.createSession({ userId: user.id, expiresAt: isoIn(60_000) })}`;
    expect((await local.call("/api/search?q=a", { cookie })).status).toBe(200);
    expect((await local.call("/api/search?q=a", { cookie })).status).toBe(200);
  });
});

describe("the token travels in a header and nowhere else", () => {
  /*
    D3, and the reason this project refused the sketch's `GET /agent/{token}`. A token in a
    URL lands in Caddy's access log, in any proxy in front, in the browser history of anyone
    who pastes it, and in a `Referer`. The same lesson `safeUrl` and `X-Plex-Token` already
    bought here twice.
  */
  test("the same token in a query string authenticates nobody", async () => {
    const { token } = keyFor();
    const res = await h.call(`/api/discover?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  test("nor in a path segment", async () => {
    const { token } = keyFor();
    expect((await h.call(`/api/title/${encodeURIComponent(token)}`)).status).toBe(401);
  });
});

describe("the manifest route answers the key that asked", () => {
  /** The real route, wired to stubs -- no database, no limiter state, no server. */
  function route(over: Partial<Parameters<typeof agentManifestRoute>[0]> = {}) {
    return agentManifestRoute({
      principal: (req) => h.service.principal(req),
      keyFor: (keyId) => h.auth.agentKeyById(keyId),
      limiter: (bucket) => h.service.agentLimiter(bucket),
      origin: () => "https://finderr.example",
      quota: () => ({ limitPerDay: 0, usedToday: 0, resetsAt: "2026-09-03T00:00:00.000Z" }),
      routes: () => h.routes,
      ...over,
    });
  }

  const ask = (headers: Record<string, string> = {}) =>
    new Request(`https://finderr.example${AGENT_MANIFEST_PATH}`, { headers });

  test("a valid key gets markdown, never JSON", async () => {
    const { token } = keyFor();
    const res = route()(ask({ authorization: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    // Uncacheable: `remaining` is true for the instant it was read and no longer.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("# finderr agent API");
  });

  test("a browser session is refused -- it holds no key to describe", () => {
    const user = h.auth.createUser({ displayName: "person", role: "user" });
    const cookie = `${SESSION_COOKIE}=${h.auth.createSession({ userId: user.id, expiresAt: isoIn(60_000) })}`;
    expect(route()(ask({ cookie })).status).toBe(403);
  });

  test("an anonymous caller is refused, and is told nothing", async () => {
    const res = route()(ask());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "this endpoint answers to an agent key" });
  });

  test("the origin is the one the caller reached, not a constant", async () => {
    const { token } = keyFor();
    const md = await route({ origin: () => "http://localhost:7979" })(
      ask({ authorization: `Bearer ${token}` }),
    ).text();
    expect(md).toContain("http://localhost:7979/api/discover");
    expect(md).not.toContain("finderr.example");
  });

  /*
    The document reports the SAME counter the guard spends, through one key derivation. Two
    spellings would make the manifest confidently wrong about a budget it was not reading --
    and an agent pacing itself against a wrong number is worse off than one with no number.
  */
  test("`remaining` reflects calls the guard has actually taken", async () => {
    const local = harness(config({ agentExpensiveRatePerMinute: 10 }));
    const user = local.auth.createUser({ displayName: "a", role: "user" });
    const { token } = local.auth.putAgentKey({ userId: user.id, readOnly: false });
    await local.call("/api/search?q=a", { bearer: token });
    await local.call("/api/search?q=b", { bearer: token });

    const md = await agentManifestRoute({
      principal: (req) => local.service.principal(req),
      keyFor: (id) => local.auth.agentKeyById(id),
      limiter: (bucket) => local.service.agentLimiter(bucket),
      origin: () => "http://localhost:7979",
      quota: () => ({ limitPerDay: 0, usedToday: 0, resetsAt: "2026-09-03T00:00:00.000Z" }),
      routes: () => local.routes,
    })(
      new Request(`http://localhost:7979${AGENT_MANIFEST_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    ).text();

    expect(md).toContain("| `expensive` | 10 | 60s | 8 |");
  });
});

describe("the manifest describes the server it is served from", () => {
  /*
    THE ASSERTION THE WHOLE "SELF-DESCRIBING" CLAIM RESTS ON.

    Without it, "always updated" is a promise rather than a property: an operation could name
    a route that was renamed or deleted, and the document would go on advertising it to
    agents that then get a 404 they cannot explain.
  */
  test("every advertised operation resolves to a real route, and offers that method", () => {
    const table = h.routes;
    for (const op of AGENT_OPERATIONS) {
      expect(table[op.path]).toBeDefined();
      const entry = table[op.path];
      if (entry && typeof entry === "object") {
        expect(Object.keys(entry as Record<string, unknown>)).toContain(op.method);
      }
    }
  });

  test("no advertised operation is on a prefix the guard closes", () => {
    for (const op of AGENT_OPERATIONS) expect(agentMayReach(op.path)).toBe(true);
  });

  test("a read-only key's manifest does not advertise POST /api/requests", () => {
    const view = manifestView({ readOnly: true });
    const md = renderManifest(view);
    expect(md).not.toContain("POST /api/requests");
    expect(md).toContain("GET /api/search");
    expect(md).toContain("READ-ONLY");
  });

  test("a read-write key's manifest does advertise it", () => {
    expect(renderManifest(manifestView({ readOnly: false }))).toContain("POST /api/requests");
  });

  /*
    THE FAILURE THIS CAUGHT WHEN IT WAS FIRST RUN, and the reason the prose is derived.

    The rate-limit paragraph used to NAME the expensive routes in a sentence, and the derived
    "everything else" list carried every method the table declared. Both told a read-only key
    about writes it is refused -- which is the drift a generated document is supposed to be
    incapable of, arriving through the one part of it somebody wrote by hand.
  */
  test("a read-only manifest mentions no write ANYWHERE, prose included", () => {
    const md = renderManifest(manifestView({ readOnly: true }));
    expect(md).not.toMatch(/\bPOST\b/);
    expect(md).not.toMatch(/\bDELETE\b/);
    // The undescribed routes are still listed -- only the methods it cannot call are gone.
    expect(md).toContain("/img/t/:tconst");
    expect(md).not.toContain("/api/requests/episode");
  });

  test("a read-write manifest lists the episode POST it never described", () => {
    expect(renderManifest(manifestView({ readOnly: false }))).toContain("/api/requests/episode");
  });

  test("it states both buckets, their window and what is left", () => {
    const md = renderManifest(manifestView({ readOnly: false }));
    expect(md).toContain("| `cheap` | 120 | 60s | 118 |");
    expect(md).toContain("| `expensive` | 20 | 60s | 20 |");
    // And says the number is a floor, because the limiter is in memory.
    expect(md).toContain("reset when the server restarts");
  });

  test("the daily quota is named SEPARATELY from the per-minute buckets", () => {
    const md = renderManifest(manifestView({ readOnly: false, quotaPerDay: 5, usedToday: 2 }));
    expect(md).toContain("**2 of 5** titles used today");
    // The distinction is the point: both answer 429 and they reset differently.
    expect(md).toContain("A different refusal from the rate limits");
  });

  test("no quota configured says so rather than printing a zero", () => {
    expect(renderManifest(manifestView({ readOnly: false }))).toContain("no daily title quota");
  });

  test("the origin comes from the view, so dev and production render differently", () => {
    const md = renderManifest({ ...manifestView({ readOnly: false }), origin: "https://finderr.example" });
    expect(md).toContain("https://finderr.example/api/discover");
    expect(md).not.toContain("{ORIGIN}");
  });

  test("a route the table has but nobody described still appears", () => {
    const md = renderManifest(manifestView({ readOnly: false }));
    // `/img/t/:tconst` carries no example anywhere in this file. It is listed because it is
    // in the table -- which is what makes a route added later appear by having been added.
    expect(md).toContain("/img/t/:tconst");
  });

  test("nothing behind a closed prefix is ever listed", () => {
    const md = renderManifest(manifestView({ readOnly: false }));
    expect(md).not.toContain("/api/admin/users");
    expect(md).not.toContain(AGENT_KEY_PATH);
  });

  test("the token never appears in a URL anywhere in the document", () => {
    const md = renderManifest(manifestView({ readOnly: false }));
    // Every example authenticates with a header. A path or query token would end up in an
    // access log, a proxy, a browser history and a `Referer`.
    expect(md).not.toMatch(/[?&](token|key|api_key)=/);
    expect(md).toContain("Authorization: Bearer");
  });
});

/** A manifest view over the harness's own route table, so the two cannot disagree. */
function manifestView(opts: { readOnly: boolean; quotaPerDay?: number; usedToday?: number }) {
  return {
    origin: "http://localhost:7979",
    key: { createdAt: "2026-09-02T00:00:00.000Z", lastUsedAt: null, readOnly: opts.readOnly },
    buckets: [
      { bucket: "cheap" as const, limitPerMinute: 120, remaining: 118, windowSeconds: 60 },
      { bucket: "expensive" as const, limitPerMinute: 20, remaining: 20, windowSeconds: 60 },
    ],
    quota: {
      limitPerDay: opts.quotaPerDay ?? 0,
      usedToday: opts.usedToday ?? 0,
      resetsAt: "2026-09-03T00:00:00.000Z",
    },
    reachable: routeSummaries(h.routes),
  };
}

describe("the bootstrap snippet is a pointer plus a credential", () => {
  test("one curl, the live origin, and nothing restated", () => {
    const snippet = bootstrapSnippet("https://finderr.example", "sekrit");
    expect(snippet).toContain(
      `curl -H "Authorization: Bearer sekrit" https://finderr.example${AGENT_MANIFEST_PATH}`,
    );
    // It must not become a second, hand-maintained copy of the API shape. One operation
    // named here is one that goes stale here.
    expect(snippet).not.toContain("/api/search");
    expect(snippet).not.toContain("rate");
  });

  test("the token is in a header, never in the URL", () => {
    const snippet = bootstrapSnippet("https://finderr.example", "sekrit");
    expect(snippet).not.toContain("sekrit@");
    expect(snippet).not.toMatch(/https:\/\/[^\s]*sekrit/);
  });
});

describe("how long a blocking call may wait", () => {
  const wait = (qs: string) => agentWaitMs(new URL(`http://x/api/title/tt1?${qs}`));

  test("no parameter is the measured default", () => {
    expect(agentWaitMs(new URL("http://x/api/title/tt1"))).toBe(AGENT_WAIT_MS.default);
  });

  test("an agent may ask for less", () => {
    expect(wait("wait=500")).toBe(500);
  });

  /*
    The ceiling is the whole reason this is a function. It must stay UNDER the 15s outbound
    provider deadline: an endpoint that gives up after the providers do is an endpoint that
    always gives up first, which is the useless case.
  */
  test("it cannot ask for more than the providers are allowed to take", () => {
    expect(wait("wait=99999")).toBe(AGENT_WAIT_MS.max);
    expect(AGENT_WAIT_MS.max).toBeLessThan(15_000);
  });

  test("nonsense is the default, not a 400 -- the caller wanted ordinary behaviour", () => {
    expect(wait("wait=soon")).toBe(AGENT_WAIT_MS.default);
    expect(wait("wait=-5")).toBe(0);
  });
});

describe("routeSummaries reads the table rather than guessing", () => {
  test("a method table lists its methods; a bare handler answers any", () => {
    const summaries = routeSummaries(appRoutes());
    expect(summaries.find((r) => r.path === "/api/requests")?.methods).toEqual(["GET", "POST"]);
    // Null rather than an invented `["GET"]`: Bun offers a bare handler on every method, and
    // writing one down would be the manifest stating a fact the table never made.
    expect(summaries.find((r) => r.path === "/api/discover")?.methods).toBeNull();
  });
});
