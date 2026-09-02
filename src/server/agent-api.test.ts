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
import { AUTH_SCHEMA, AuthStore } from "../lib/auth-store";
import type { Config } from "../lib/config";
import { loadConfig } from "../lib/config";
import type { Store } from "../lib/store";
import {
  AGENT_KEY_PATH,
  AGENT_MANIFEST_PATH,
  AGENT_OPERATIONS,
  AGENT_WAIT_MS,
  agentBucket,
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
  db.run(AUTH_SCHEMA);
  const auth = new AuthStore(db);
  const logs: string[] = [];

  const service = new AuthService({
    auth,
    store: { listRequests: () => [] } as unknown as Store,
    cfg,
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
    const row = h.auth.agentKeyFor(userId);
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test("a rotated key kills the old token in the same statement", async () => {
    const { userId, token: first } = keyFor();
    expect((await h.call("/api/discover", { bearer: first })).status).toBe(200);

    const { token: second } = h.auth.putAgentKey({ userId, readOnly: false });
    expect((await h.call("/api/discover", { bearer: second })).status).toBe(200);
    // 401 rather than 403: the old token identifies nobody at all now.
    expect((await h.call("/api/discover", { bearer: first })).status).toBe(401);
    // And there is exactly one key, because the schema cannot express two.
    expect(h.auth.agentKeyCount()).toBe(1);
  });

  test("a revoked key is refused immediately", async () => {
    const { userId, token } = keyFor();
    h.auth.deleteAgentKey(userId);
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

  test("a person in a browser creates, reads and revokes it", async () => {
    const user = h.auth.createUser({ displayName: "person", role: "user" });
    const cookie = `${SESSION_COOKIE}=${h.auth.createSession({ userId: user.id, expiresAt: isoIn(60_000) })}`;

    expect(await (await h.call(AGENT_KEY_PATH, { cookie })).json()).toEqual({ key: null });

    const made = (await (await h.call(AGENT_KEY_PATH, { method: "POST", cookie })).json()) as {
      token: string;
      snippet: string;
      rotated: boolean;
    };
    expect(made.rotated).toBe(false);
    // The snippet is what a person copies, and it carries the plaintext exactly once.
    expect(made.snippet).toContain(made.token);
    expect(made.snippet).toContain(AGENT_MANIFEST_PATH);

    // Reading it back never returns the token again -- only the sha256 was kept.
    const read = await (await h.call(AGENT_KEY_PATH, { cookie })).json();
    expect(JSON.stringify(read)).not.toContain(made.token);

    const again = (await (await h.call(AGENT_KEY_PATH, { method: "POST", cookie })).json()) as {
      rotated: boolean;
    };
    expect(again.rotated).toBe(true);

    expect((await h.call(AGENT_KEY_PATH, { method: "DELETE", cookie })).status).toBe(200);
    expect(await (await h.call(AGENT_KEY_PATH, { cookie })).json()).toEqual({ key: null });
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
