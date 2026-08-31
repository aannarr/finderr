import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { hashToken, isoIn, SESSION_COOKIE } from "../lib/auth";
import { AUTH_SCHEMA, AuthStore } from "../lib/auth-store";
import type { Config } from "../lib/config";
import { loadConfig } from "../lib/config";
import type { FetchLike } from "../lib/plex-auth";
import type { MediaRequest, Store } from "../lib/store";
import { AuthService, withAuth } from "./auth-routes";
import { INDEX_GATE_PUBLIC_PATHS } from "./index-build";

const API_KEY = "test-system-key-0123456789abcdef";

function config(over: Partial<Config["auth"]> = {}): Config {
  const base = loadConfig();
  return {
    ...base,
    plex: { ...base.plex, enabled: true, productName: "finderr-test" },
    auth: {
      ...base.auth,
      rpId: "localhost",
      origins: ["http://localhost:7979"],
      adminApiKey: API_KEY,
      ...over,
    },
  };
}

/** One request row, so the admin-visibility test has something to look at. */
const REQUEST_ROW = {
  id: 1,
  tconst: "tt0111161",
  title: "The Shawshank Redemption",
  year: 1994,
  kind: "movie",
  service: "radarr",
  status: "queued",
  arr_id: null,
  error: null,
  created_at: "2026-08-31T00:00:00.000Z",
  updated_at: "2026-08-31T00:00:00.000Z",
  search_attempts: 0,
  seasons: null,
  requested_by: "u-secret",
} as unknown as MediaRequest;

function fakeStore(): Store {
  return { listRequests: () => [REQUEST_ROW] } as unknown as Store;
}

interface Harness {
  auth: AuthStore;
  service: AuthService;
  calls: string[];
  logs: string[];
  call: (path: string, init?: RequestInit & { cookie?: string; bearer?: string }) => Promise<Response>;
}

function harness(opts: { cfg?: Config; fetchImpl?: FetchLike } = {}): Harness {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  db.run(AUTH_SCHEMA);
  const auth = new AuthStore(db);
  const logs: string[] = [];
  const calls: string[] = [];
  const cfg = opts.cfg ?? config();

  const service = new AuthService({
    auth,
    store: fakeStore(),
    cfg,
    log: (m) => logs.push(m),
    fetchImpl:
      opts.fetchImpl ??
      (async (url) => {
        calls.push(url);
        return new Response("{}", { status: 500 });
      }),
    addressOf: () => "10.0.0.1",
  });

  // The real table shape: app routes plus auth routes, all behind the one guard.
  const routes = withAuth(
    {
      "/api/health": () => new Response(JSON.stringify({ ok: true })),
      // Shaped like the real one: on a server that HAS an index it is this constant, which
      // is what the progress page reads to know it may reload.
      "/api/index-status": () => new Response(JSON.stringify({ ready: true, build: null })),
      "/api/search": () => new Response(JSON.stringify({ hits: [] })),
      "/api/requests": {
        GET: (req: Request) => {
          const role = service.principal(req)?.role ?? null;
          return new Response(
            JSON.stringify({
              requests: [REQUEST_ROW].map((r) => (role === "admin" ? r : { ...r, requested_by: undefined })),
            }),
          );
        },
      },
      ...service.routes(),
    },
    { authService: service, publicPaths: service.publicPaths() },
  ) as Record<string, unknown>;

  const call: Harness["call"] = async (path, init = {}) => {
    const url = new URL(path, "http://localhost:7979");
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    const req = new Request(url, { ...init, headers });

    // The matching Bun does for us: exact path first, then a pattern with `:params`.
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
    // The params Bun would have parsed, taken from the pattern rather than from the tail --
    // `/api/admin/users/:id/reset` has its parameter in the MIDDLE.
    const params: Record<string, string> = {};
    pattern.split("/").forEach((seg, i) => {
      if (seg.startsWith(":")) params[seg.slice(1)] = got[i] ?? "";
    });
    return (await (handler as (r: unknown) => Promise<Response> | Response)(
      Object.assign(req, { params }),
    )) as Response;
  };

  return { auth, service, calls, logs, call };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** A signed-in cookie for a fresh user of the given role. */
function signIn(role: "admin" | "user" = "user"): string {
  const u = h.auth.createUser({ displayName: role, role });
  const token = h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
  return `${SESSION_COOKIE}=${token}`;
}

describe("the guard closes everything by default", () => {
  test("an anonymous caller gets 401 from a private route", async () => {
    expect((await h.call("/api/search?q=x")).status).toBe(401);
    expect((await h.call("/api/requests")).status).toBe(401);
  });

  test("a 401 is JSON, never a redirect -- the caller is JavaScript", async () => {
    const res = await h.call("/api/search?q=x");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not signed in" });
  });

  test("health stays open, because the container probe has no cookie", async () => {
    expect((await h.call("/api/health")).status).toBe(200);
  });

  test("the sign-in ceremonies stay open", async () => {
    expect((await h.call("/api/auth/state")).status).toBe(200);
    expect((await h.call("/api/auth/passkey/login/begin", { method: "POST" })).status).toBe(200);
  });

  /*
    THE TWO GUARDS MUST AGREE, and this is the assertion that was missing.

    `withIndexGate` refuses routes while there is no INDEX; `withAuth` refuses routes to
    callers with no SESSION. They are different questions with different allow-lists, and
    `/api/index-status` was exempted from the first and not the second -- so the progress
    page an anonymous visitor sees during a FIRST INSTALL polled an endpoint that answered
    401 and never learned the index was ready. On a first install there are no users at all,
    so every visitor is anonymous by construction: the exact case the feature exists for was
    the one case it could not serve.

    Asserted as a RELATIONSHIP rather than as a second hand-written list, so a third route
    opened to the index gate cannot repeat this by being forgotten here.
  */
  test("every path the INDEX gate opens is also open to an anonymous caller", () => {
    const open = INDEX_GATE_PUBLIC_PATHS;
    const sessionless = new Set(h.service.publicPaths());
    expect(open.length).toBeGreaterThan(0);
    for (const path of open) {
      expect({ path, publiclyReachable: sessionless.has(path) }).toEqual({
        path,
        publiclyReachable: true,
      });
    }
  });

  test("/api/index-status answers an anonymous caller, because a first install has no users", async () => {
    const res = await h.call("/api/index-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, build: null });
  });

  test("a signed-in caller passes", async () => {
    expect((await h.call("/api/search?q=x", { cookie: signIn() })).status).toBe(200);
  });

  /*
    The point of wrapping the table rather than each handler: a route added later is
    private by having been added.
  */
  test("a route nobody thought about is private without anybody remembering", async () => {
    const guarded = withAuth(
      { "/api/brand-new": () => new Response("secret") },
      { authService: h.service, publicPaths: h.service.publicPaths() },
    );
    const handler = guarded["/api/brand-new"] as (r: Request) => Response;
    expect(handler(new Request("http://localhost/api/brand-new")).status).toBe(401);
  });
});

describe("the anonymous state endpoint discloses nothing", () => {
  test("it does not say how many users exist or what this is", async () => {
    h.auth.createUser({ displayName: "somebody", role: "admin" });
    const body = (await (await h.call("/api/auth/state")).json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: false, plex: false });
  });

  test("signed in, it names only the caller", async () => {
    const body = (await (await h.call("/api/auth/state", { cookie: signIn() })).json()) as {
      authenticated: boolean;
      user: { displayName: string };
    };
    expect(body.authenticated).toBe(true);
    expect(body.user.displayName).toBe("user");
  });
});

describe("invites", () => {
  test("a live invite answers ok; a dead one is a bare 404 either way", async () => {
    const { token } = h.auth.createInvite({ role: "user", displayName: "Guest", expiresAt: isoIn(60_000) });
    const good = await h.call(`/api/auth/invite?token=${token}`);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, displayName: "Guest" });

    const bad = await h.call("/api/auth/invite?token=not-a-real-token");
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ ok: false });
  });

  test("a redeemed invite is indistinguishable from one that never existed", async () => {
    const { token } = h.auth.createInvite({ role: "user", expiresAt: isoIn(60_000) });
    h.auth.claimInvite(hashToken(token));
    const res = await h.call(`/api/auth/invite?token=${token}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false });
  });

  test("registering against a dead invite refuses with the one generic message", async () => {
    const res = await h.call("/api/auth/passkey/register/begin", {
      method: "POST",
      body: JSON.stringify({ token: "nope" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "that did not work" });
  });
});

describe("the system API key", () => {
  test("it mints an invite without being a person", async () => {
    const res = await h.call("/api/admin/invites", {
      method: "POST",
      bearer: API_KEY,
      body: JSON.stringify({ role: "user", displayName: "Guest" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string; role: string };
    expect(body.role).toBe("user");
    expect(body.url).toBe(`http://localhost:7979/invite/${body.token}`);
    expect(h.auth.getInvite(hashToken(body.token))?.createdBy).toBe("api-key");
  });

  test("a wrong key is refused, and the admin API looks like it is not there", async () => {
    const res = await h.call("/api/admin/invites", { bearer: "wrong-key-wrong-key-wrong-key" });
    expect(res.status).toBe(401);
  });

  test("an ordinary user gets 404 rather than 403 -- the admin API does not announce itself", async () => {
    const res = await h.call("/api/admin/invites", { cookie: signIn("user") });
    expect(res.status).toBe(404);
  });

  test("listing invites returns hashes, never live tokens", async () => {
    const { token } = h.auth.createInvite({ role: "user", expiresAt: isoIn(60_000) });
    const body = (await (await h.call("/api/admin/invites", { bearer: API_KEY })).json()) as {
      invites: { id: string }[];
    };
    expect(body.invites[0]?.id).toBe(hashToken(token));
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test("the admin API is unreachable when no key is configured", async () => {
    const noKey = harness({ cfg: config({ adminApiKey: undefined }) });
    expect((await noKey.call("/api/admin/invites", { bearer: API_KEY })).status).toBe(401);
  });
});

describe("resetting an account is the passkey answer to a forced password reset", () => {
  test("every credential and session is revoked and a fresh invite comes back", async () => {
    const u = h.auth.createUser({ displayName: "Guest", role: "user", plexId: "42" });
    h.auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0 });
    h.auth.addCredential({ id: "c2", userId: u.id, publicKey: "pk2", counter: 0 });
    h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });

    const res = await h.call(`/api/admin/users/${u.id}/reset`, { method: "POST", bearer: API_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: { credentials: number; sessions: number }; token: string };

    expect(body.revoked).toEqual({ credentials: 2, sessions: 1 });
    expect(h.auth.credentialsFor(u.id)).toHaveLength(0);
    expect(h.auth.sessionsFor(u.id)).toHaveLength(0);
    expect(h.auth.getUser(u.id)?.plexId).toBeNull();
    // The account survives -- a reset is not a delete, and their request history stays.
    expect(h.auth.getUser(u.id)?.displayName).toBe("Guest");
    expect(h.auth.getInvite(hashToken(body.token))?.role).toBe("user");
  });
});

describe("the last admin cannot lock everybody out", () => {
  test("demoting the only admin is refused", async () => {
    const a = h.auth.createUser({ displayName: "A", role: "admin" });
    const res = await h.call(`/api/admin/users/${a.id}`, {
      method: "PATCH",
      bearer: API_KEY,
      body: JSON.stringify({ role: "user" }),
    });
    expect(res.status).toBe(409);
    expect(h.auth.getUser(a.id)?.role).toBe("admin");
  });

  test("deleting the only admin is refused", async () => {
    const a = h.auth.createUser({ displayName: "A", role: "admin" });
    expect((await h.call(`/api/admin/users/${a.id}`, { method: "DELETE", bearer: API_KEY })).status).toBe(
      409,
    );
  });

  test("with two admins, one may go", async () => {
    h.auth.createUser({ displayName: "A", role: "admin" });
    const b = h.auth.createUser({ displayName: "B", role: "admin" });
    expect((await h.call(`/api/admin/users/${b.id}`, { method: "DELETE", bearer: API_KEY })).status).toBe(
      200,
    );
  });

  test("disabling a user kills their live sessions immediately", async () => {
    h.auth.createUser({ displayName: "A", role: "admin" });
    const u = h.auth.createUser({ displayName: "B", role: "user" });
    const token = h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    await h.call(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      bearer: API_KEY,
      body: JSON.stringify({ disabled: true }),
    });
    expect(h.auth.readSession(token)).toBeNull();
  });
});

describe("who requested what", () => {
  test("an admin sees the attribution", async () => {
    const body = (await (await h.call("/api/admin/requests", { bearer: API_KEY })).json()) as {
      requests: { requested_by: string }[];
    };
    expect(body.requests[0]?.requested_by).toBe("u-secret");
  });

  /*
    aannarr, 2026-08-31: only admins know and can SEE who requested what, and that fact must
    not leak to a normal user. The route is not merely undrawn for them -- it is not there.
  */
  test("an ordinary user cannot reach the attributed log at all", async () => {
    expect((await h.call("/api/admin/requests", { cookie: signIn("user") })).status).toBe(404);
  });
});

describe("sign out", () => {
  test("the session row is destroyed, not just the cookie", async () => {
    const u = h.auth.createUser({ displayName: "A", role: "user" });
    const token = h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    const res = await h.call("/api/auth/logout", {
      method: "POST",
      cookie: `${SESSION_COOKIE}=${token}`,
    });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(h.auth.readSession(token)).toBeNull();
  });
});

describe("rate limiting the anonymous surface", () => {
  test("the invite lookup is capped, so a token cannot be hammered", async () => {
    const tight = harness({ cfg: config({ authRatePerMinute: 3 }) });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await tight.call("/api/auth/invite?token=guess")).status);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });

  test("a refusal carries Retry-After rather than leaving the client to guess", async () => {
    const tight = harness({ cfg: config({ authRatePerMinute: 1 }) });
    await tight.call("/api/auth/invite?token=guess");
    const res = await tight.call("/api/auth/invite?token=guess");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  /*
    THE BUG THIS PINS, and it arrived by deployment rather than by a code change.

    `trustProxy` was a hardcoded `false` with a comment saying to turn it on once a proxy
    was in front. Caddy went in front on 2026-08-31. Behind a proxy every request carries
    the PROXY's socket address, so all of these callers land in one bucket and the first
    abuser locks out everybody -- a limiter that cannot tell an attacker from a user is
    worse than none, because it looks like it is working.

    Both directions are asserted, because turning it on without a proxy is the opposite
    failure: the header is client-controlled, so an attacker mints a fresh identity per
    request and the limiter never fires at all.
  */
  test("behind a proxy, two clients get two buckets rather than sharing one", async () => {
    const h = harness({ cfg: config({ authRatePerMinute: 1, trustProxy: true }) });
    const from = (ip: string) =>
      h.call("/api/auth/invite?token=guess", { headers: { "x-forwarded-for": ip } });

    expect((await from("203.0.113.1")).status).toBe(404);
    // A different client. Shares the proxy's socket address, so this is 429 without the fix.
    expect((await from("203.0.113.2")).status).toBe(404);
    // Same client again: now it is genuinely over its own limit.
    expect((await from("203.0.113.1")).status).toBe(429);
  });

  test("with no proxy the header is ignored, so it cannot mint fresh identities", async () => {
    const h = harness({ cfg: config({ authRatePerMinute: 1, trustProxy: false }) });
    const from = (ip: string) =>
      h.call("/api/auth/invite?token=guess", { headers: { "x-forwarded-for": ip } });

    expect((await from("203.0.113.1")).status).toBe(404);
    // A forged header must NOT buy a second bucket -- the socket address is the only
    // honest answer when nothing trustworthy is in front.
    expect((await from("203.0.113.2")).status).toBe(429);
  });
});

describe("signing in with Plex", () => {
  /** A plex.tv that approves instantly, for the account and server we tell it about. */
  function plexFetch(opts: { token?: string | null; accountId?: string; machineIds?: string[] }): FetchLike {
    return async (url) => {
      if (url.includes("/pins?strong=true"))
        return Response.json({ id: 1682300520, code: "abc123", expiresIn: 1800 });
      if (url.includes("/pins/")) return Response.json({ authToken: opts.token ?? null });
      if (url.endsWith("/user")) return Response.json({ id: opts.accountId ?? "42", username: "guest" });
      if (url.includes("/resources"))
        return Response.json((opts.machineIds ?? []).map((id) => ({ clientIdentifier: id })));
      return new Response("{}", { status: 404 });
    };
  }

  test("begin returns a plex.tv URL whose forwardUrl is OUR configured origin", async () => {
    const p = harness({ fetchImpl: plexFetch({}) });
    const body = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      authUrl: string;
      pinId: string;
    };
    expect(body.pinId).toBe("1682300520");
    expect(body.authUrl).toStartWith("https://app.plex.tv/auth#?");
    expect(decodeURIComponent(body.authUrl)).toContain("forwardUrl=http://localhost:7979/login?plex=");
  });

  test("an unapproved pin is `pending`, which is the ordinary answer while they type", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: null }) });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(await res.json()).toEqual({ pending: true });
  });

  /*
    AUTHORIZATION IS NOT AUTHENTICATION. A Plex account proves somebody has a Plex account.
    aannarr, 2026-08-31: you must be invited.
  */
  test("an unknown Plex account with no invite is refused, however valid its token", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: "plex-token", accountId: "999" }) });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(403);
    expect(p.auth.userCount()).toBe(0);
  });

  test("an invite carried on the PIN creates the account and signs them in", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: "plex-token", accountId: "999" }) });
    const { token } = p.auth.createInvite({ role: "user", displayName: "Guest", expiresAt: isoIn(60_000) });
    const begin = (await (
      await p.call("/api/auth/plex/begin", { method: "POST", body: JSON.stringify({ token }) })
    ).json()) as { pinId: string };

    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("fdr_sid=");
    const user = p.auth.getUserByPlexId("999");
    expect(user?.displayName).toBe("Guest");
    expect(p.auth.getInvite(hashToken(token))?.redeemedBy).toBe(user?.id);
  });

  test("a linked account signs in with no invite at all", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: "plex-token", accountId: "42" }) });
    p.auth.createUser({ displayName: "Known", role: "user", plexId: "42" });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(200);
    expect(p.auth.userCount()).toBe(1);
  });

  test("the machine-identifier gate is a SECOND wall, and it refuses an outsider", async () => {
    const cfg = config();
    cfg.plex = { ...cfg.plex, machineIdentifier: "our-server" };
    const p = harness({
      cfg,
      fetchImpl: plexFetch({ token: "plex-token", accountId: "42", machineIds: ["someone-elses"] }),
    });
    p.auth.createUser({ displayName: "Known", role: "user", plexId: "42" });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(403);
  });

  test("and lets through an account that really does have access to our server", async () => {
    const cfg = config();
    cfg.plex = { ...cfg.plex, machineIdentifier: "our-server" };
    const p = harness({
      cfg,
      fetchImpl: plexFetch({ token: "plex-token", accountId: "42", machineIds: ["our-server"] }),
    });
    p.auth.createUser({ displayName: "Known", role: "user", plexId: "42" });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(200);
  });

  test("a disabled user cannot come back in through Plex", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: "plex-token", accountId: "42" }) });
    const u = p.auth.createUser({ displayName: "Known", role: "user", plexId: "42" });
    p.auth.updateUser(u.id, { disabled: true });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(403);
  });
});

describe("requireAdmin guards app routes that live outside the auth table", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://localhost:7979/api/library/sync", { method: "POST", headers });

  test("anonymous is 401, a user is 404, an admin proceeds", () => {
    expect(h.service.requireAdmin(request())?.status).toBe(401);
    expect(h.service.requireAdmin(request({ cookie: signIn("user") }))?.status).toBe(404);
    expect(h.service.requireAdmin(request({ cookie: signIn("admin") }))).toBeNull();
  });

  test("the system API key proceeds -- an agent may administer", () => {
    expect(h.service.requireAdmin(request({ authorization: `Bearer ${API_KEY}` }))).toBeNull();
  });
});

describe("naming your own passkeys", () => {
  /** Sign in and attach a credential, returning the cookie and the credential id. */
  function withPasskey(label: string | null = null) {
    const u = h.auth.createUser({ displayName: "A", role: "user" });
    h.auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0, label });
    const token = h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    return { cookie: `${SESSION_COOKIE}=${token}`, userId: u.id };
  }

  test("an owner may rename their passkey", async () => {
    const { cookie } = withPasskey("Mac");
    const res = await h.call("/api/auth/credentials/c1", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ label: "work laptop" }),
    });
    expect(res.status).toBe(200);
    expect(h.auth.getCredential("c1")?.label).toBe("work laptop");
  });

  test("anonymous is refused", async () => {
    withPasskey("Mac");
    const res = await h.call("/api/auth/credentials/c1", {
      method: "PATCH",
      body: JSON.stringify({ label: "mine now" }),
    });
    expect(res.status).toBe(401);
    expect(h.auth.getCredential("c1")?.label).toBe("Mac");
  });

  test("somebody else's passkey is a 404, not a rename", async () => {
    // A credential id is not a secret. Holding one must never be authority over it, and the
    // refusal must not confirm that the id exists.
    withPasskey("Mac");
    const res = await h.call("/api/auth/credentials/c1", {
      method: "PATCH",
      cookie: signIn("user"),
      body: JSON.stringify({ label: "stolen" }),
    });
    expect(res.status).toBe(404);
    expect(h.auth.getCredential("c1")?.label).toBe("Mac");
  });

  test("an admin has no special power over somebody else's passkey either", async () => {
    // Admin is about administering finderr, not about wearing another person's identity.
    // "Reset access" is the admin path here, and it revokes rather than renames.
    withPasskey("Mac");
    const res = await h.call("/api/auth/credentials/c1", {
      method: "PATCH",
      cookie: signIn("admin"),
      body: JSON.stringify({ label: "admin was here" }),
    });
    expect(res.status).toBe(404);
    expect(h.auth.getCredential("c1")?.label).toBe("Mac");
  });

  test("a label is capped, so one row cannot render as a wall of text", async () => {
    const { cookie } = withPasskey();
    await h.call("/api/auth/credentials/c1", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ label: "x".repeat(500) }),
    });
    expect(h.auth.getCredential("c1")?.label).toHaveLength(60);
  });

  test("null clears the name", async () => {
    const { cookie } = withPasskey("Mac");
    await h.call("/api/auth/credentials/c1", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ label: null }),
    });
    expect(h.auth.getCredential("c1")?.label).toBeNull();
  });

  test("a non-string label is refused rather than coerced", async () => {
    const { cookie } = withPasskey("Mac");
    const res = await h.call("/api/auth/credentials/c1", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ label: { evil: true } }),
    });
    expect(res.status).toBe(400);
    expect(h.auth.getCredential("c1")?.label).toBe("Mac");
  });
});

describe("connecting and disconnecting Plex from an account you already have", () => {
  function plexFetch(opts: { token?: string | null; accountId?: string; machineIds?: string[] }): FetchLike {
    return async (url) => {
      if (url.includes("/pins?strong=true"))
        return Response.json({ id: 1682300520, code: "abc123", expiresIn: 1800 });
      if (url.includes("/pins/")) return Response.json({ authToken: opts.token ?? null });
      if (url.endsWith("/user")) return Response.json({ id: opts.accountId ?? "42", username: "guest" });
      if (url.includes("/resources"))
        return Response.json((opts.machineIds ?? []).map((id) => ({ clientIdentifier: id })));
      return new Response("{}", { status: 404 });
    };
  }

  /** A signed-in user on a harness whose plex.tv is scripted. */
  function linked(p: Harness) {
    const u = p.auth.createUser({ displayName: "A", role: "user" });
    const token = p.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    return { user: u, cookie: `${SESSION_COOKIE}=${token}` };
  }

  test("begin is refused for an anonymous caller -- there is no account to link to", async () => {
    const p = harness({ fetchImpl: plexFetch({}) });
    const res = await p.call("/api/auth/plex/link/begin", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("begin forwards back to /account, not to the sign-in page", async () => {
    // The caller never stopped being signed in. Landing them on a sign-in screen would read
    // as a failure of the thing that just succeeded.
    const p = harness({ fetchImpl: plexFetch({}) });
    const { cookie } = linked(p);
    const body = (await (await p.call("/api/auth/plex/link/begin", { method: "POST", cookie })).json()) as {
      authUrl: string;
      pinId: string;
    };
    expect(decodeURIComponent(body.authUrl)).toContain("forwardUrl=http://localhost:7979/account?plex=");
  });

  test("an approved pin attaches the Plex account", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: "plex-token", accountId: "77" }) });
    const { user, cookie } = linked(p);
    const begin = (await (await p.call("/api/auth/plex/link/begin", { method: "POST", cookie })).json()) as {
      pinId: string;
    };

    const res = await p.call("/api/auth/plex/link/finish", {
      method: "POST",
      cookie,
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(200);
    expect(p.auth.getUser(user.id)?.plexId).toBe("77");
  });

  test("a pin the user has not approved yet is `pending`", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: null }) });
    const { cookie } = linked(p);
    const begin = (await (await p.call("/api/auth/plex/link/begin", { method: "POST", cookie })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/link/finish", {
      method: "POST",
      cookie,
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(await res.json()).toEqual({ pending: true });
  });

  test("a Plex account already attached to somebody ELSE is refused", async () => {
    // Two users sharing one Plex id would make `getUserByPlexId` a coin flip at sign-in.
    const p = harness({ fetchImpl: plexFetch({ token: "plex-token", accountId: "77" }) });
    const other = p.auth.createUser({ displayName: "B", role: "user" });
    p.auth.linkPlex(other.id, "77", "guest");
    const { user, cookie } = linked(p);

    const begin = (await (await p.call("/api/auth/plex/link/begin", { method: "POST", cookie })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/link/finish", {
      method: "POST",
      cookie,
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(409);
    expect(p.auth.getUser(user.id)?.plexId).toBeNull();
    // The message must not confirm WHOSE it is -- that is a fact about another account.
    expect(JSON.stringify(await res.json())).not.toContain(other.id);
  });

  test("linking over an existing connection is refused rather than silently replacing it", async () => {
    const p = harness({ fetchImpl: plexFetch({ token: "plex-token", accountId: "88" }) });
    const { user, cookie } = linked(p);
    p.auth.linkPlex(user.id, "77", "guest");

    const begin = (await (await p.call("/api/auth/plex/link/begin", { method: "POST", cookie })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/link/finish", {
      method: "POST",
      cookie,
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(409);
    expect(p.auth.getUser(user.id)?.plexId).toBe("77");
  });

  test("disconnecting works while a passkey remains", async () => {
    const p = harness({ fetchImpl: plexFetch({}) });
    const { user, cookie } = linked(p);
    p.auth.linkPlex(user.id, "77", "guest");
    p.auth.addCredential({ id: "c1", userId: user.id, publicKey: "pk", counter: 0 });

    const res = await p.call("/api/auth/plex", { method: "DELETE", cookie });
    expect(res.status).toBe(200);
    expect(p.auth.getUser(user.id)?.plexId).toBeNull();
  });

  /*
    THE SELF-LOCKOUT GUARD, from the other side.

    `DELETE /api/auth/credentials/:id` already refuses to remove a last passkey when there
    is no Plex account. Without the mirror of that rule here, the same user could simply
    disconnect Plex instead and lock themselves out by the other door -- and the undo for
    that is an admin reset.
  */
  test("disconnecting is refused when Plex is the only way back in", async () => {
    const p = harness({ fetchImpl: plexFetch({}) });
    const { user, cookie } = linked(p);
    p.auth.linkPlex(user.id, "77", "guest");

    const res = await p.call("/api/auth/plex", { method: "DELETE", cookie });
    expect(res.status).toBe(409);
    expect(p.auth.getUser(user.id)?.plexId).toBe("77");
    // One of the few refusals a signed-in user is given a real reason for, because it is
    // the only one they can act on -- by adding a passkey first.
    expect((await res.json()) as { error: string }).toEqual({
      error: "that is your only way to sign in",
    });
  });

  test("disconnecting does not sign you out anywhere", async () => {
    // Unlinking is a settings change the caller made deliberately, not a compromise.
    // Ending every session over it would be a punishment rather than a safeguard.
    const p = harness({ fetchImpl: plexFetch({}) });
    const { user, cookie } = linked(p);
    p.auth.linkPlex(user.id, "77", "guest");
    p.auth.addCredential({ id: "c1", userId: user.id, publicKey: "pk", counter: 0 });

    await p.call("/api/auth/plex", { method: "DELETE", cookie });
    expect(p.auth.sessionsFor(user.id)).toHaveLength(1);
    expect((await p.call("/api/auth/me", { cookie })).status).toBe(200);
  });

  test("disconnecting when nothing is connected is a 404", async () => {
    const p = harness({ fetchImpl: plexFetch({}) });
    const { cookie } = linked(p);
    expect((await p.call("/api/auth/plex", { method: "DELETE", cookie })).status).toBe(404);
  });

  test("anonymous cannot disconnect anybody", async () => {
    const p = harness({ fetchImpl: plexFetch({}) });
    expect((await p.call("/api/auth/plex", { method: "DELETE" })).status).toBe(401);
  });
});
