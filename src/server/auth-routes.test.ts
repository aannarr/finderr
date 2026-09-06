import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { hashToken, isoIn, SESSION_COOKIE } from "../lib/auth";
import { AuthStore, applyAuthSchema } from "../lib/auth-store";
import type { Config } from "../lib/config";
import { loadConfig } from "../lib/config";
import type { FetchLike } from "../lib/plex-auth";
import { utcDayReset, utcDayStart, utcDayStartDaysAgo } from "../lib/request-quota";
import { SiteSettingsStore, siteSettingsSeed } from "../lib/site-settings";
import type { MediaRequest, Store } from "../lib/store";
import { ARR_WEBHOOK_PATH } from "./arr-webhook";
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

/** Every window a route asked the request log to count over, in the order it asked. */
interface CountedWindow {
  userId: string;
  sinceIso: string;
}

/**
 * The slice of `Store` the auth surface actually touches: the request log, and the `kv`
 * the first-run latch persists itself in. The kv is a real Map rather than a no-op, because
 * "the claim never reopens" is a fact about what a WRITE left behind and a stub that forgets
 * would make the test pass for the wrong reason.
 *
 * `countRequestsSince` RECORDS its window and then ignores it. Filtering on `created_at` is
 * SQLite's job and is pinned where the query lives; what belongs here is which window each
 * route ASKS for -- today for a quota, seven days for the people list -- and a stub that also
 * filtered would make those counts depend on the day the suite happens to run.
 */
function fakeStore(counted: CountedWindow[]): Store {
  const kv = new Map<string, string>();
  const own = (userId: string) => [REQUEST_ROW].filter((r) => r.requested_by === userId);
  return {
    listRequests: () => [REQUEST_ROW],
    listRequestsFor: (userId: string) => own(userId),
    countRequestsSince: (userId: string, sinceIso: string) => {
      counted.push({ userId, sinceIso });
      return own(userId).length;
    },
    getKv: (key: string) => kv.get(key) ?? null,
    setKv: (key: string, value: string) => void kv.set(key, value),
  } as unknown as Store;
}

interface Harness {
  auth: AuthStore;
  service: AuthService;
  /** The site defaults, over the fake store's own `kv` -- the same object the routes write. */
  settings: SiteSettingsStore;
  calls: string[];
  logs: string[];
  /** Which windows the routes counted requests over. See `fakeStore`. */
  counted: CountedWindow[];
  call: (path: string, init?: RequestInit & { cookie?: string; bearer?: string }) => Promise<Response>;
}

function harness(opts: { cfg?: Config; fetchImpl?: FetchLike } = {}): Harness {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  const logs: string[] = [];
  const calls: string[] = [];
  const counted: CountedWindow[] = [];
  const cfg = opts.cfg ?? config();
  const store = fakeStore(counted);
  // Over the fake store's kv, so a PATCH through the route and a read through `auth` are the
  // same rows -- which is what makes "a new account follows the site default" assertable.
  const settings = new SiteSettingsStore(store, siteSettingsSeed(cfg));
  const auth = new AuthStore(db, () => settings.read().assistantAllowedByDefault);

  const service = new AuthService({
    auth,
    store,
    cfg,
    settings,
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

  return { auth, service, settings, calls, logs, counted, call };
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

  /**
   * The auth surface answers the same URL differently to every caller -- `/api/auth/state`
   * is `{authenticated:false}` to a stranger and a named account to a session -- and it used
   * to send no `Cache-Control` at all, which leaves an intermediary free to invent its own
   * freshness. `json` now defaults to `no-store` for every route that does not ask for more;
   * this checks the auth routes are actually on that shared helper rather than a second one.
   */
  test("an auth answer is stored by nobody", async () => {
    const res = await h.call("/api/auth/state");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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

  /*
    The arr callback is the ONE public route that changes state, and it has to be: Radarr
    and Sonarr have no cookie and no way to be given one. Left off the list it would answer
    401 to both arrs and look, from their side, exactly like a broken integration -- the
    same silent pairing failure `/api/index-status` had between the two guards above.

    Being public here is not being open: `ArrWebhookService` authenticates every caller with
    its own basic-auth password and refuses everybody when none is configured. That is
    asserted in `./arr-webhook.test.ts`; this only pins the allow-list entry.
  */
  test("the arr webhook is reachable without a session, because an arr has no cookie", () => {
    expect(h.service.publicPaths()).toContain(ARR_WEBHOOK_PATH);
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

/**
 * THE PER-USER SETTINGS, and the three states of the quota field.
 *
 * `undefined`, `null` and a number mean three different things on this PATCH and every other
 * field on it only has two. That is the whole reason `quotaOverride` exists, and reading a
 * malformed value as "absent" would leave an admin looking at a form they believe they just
 * cleared -- so a bad value is a 400 rather than a shrug.
 */
describe("the per-user settings an admin decides", () => {
  const patch = (id: string, body: unknown) =>
    h.call(`/api/admin/users/${id}`, { method: "PATCH", bearer: API_KEY, body: JSON.stringify(body) });

  test("a quota override is set, then cleared back to the site default with null", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });

    expect((await patch(u.id, { quotaPerDay: 3 })).status).toBe(200);
    expect(h.auth.getUser(u.id)?.quotaPerDay).toBe(3);

    expect((await patch(u.id, { quotaPerDay: null })).status).toBe(200);
    expect(h.auth.getUser(u.id)?.quotaPerDay).toBeNull();
  });

  test("zero is a value, not an empty field -- it means unlimited for this person", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    await patch(u.id, { quotaPerDay: 0 });
    expect(h.auth.getUser(u.id)?.quotaPerDay).toBe(0);
  });

  test("a patch that does not mention the quota leaves it alone", async () => {
    // The distinction the whole helper exists for: absent is not the same as null.
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    await patch(u.id, { quotaPerDay: 4 });
    await patch(u.id, { displayName: "Ada Lovelace" });
    expect(h.auth.getUser(u.id)?.quotaPerDay).toBe(4);
  });

  test("a nonsense quota is a 400 and changes nothing", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    await patch(u.id, { quotaPerDay: 2 });
    for (const bad of [-1, 2.5, "3", true]) {
      expect((await patch(u.id, { quotaPerDay: bad })).status).toBe(400);
    }
    expect(h.auth.getUser(u.id)?.quotaPerDay).toBe(2);
  });

  test("the assistant can be turned off for one account and back on", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    expect(h.auth.getUser(u.id)?.assistantAllowed).toBe(true);

    await patch(u.id, { assistantAllowed: false });
    expect(h.auth.getUser(u.id)?.assistantAllowed).toBe(false);

    await patch(u.id, { assistantAllowed: true });
    expect(h.auth.getUser(u.id)?.assistantAllowed).toBe(true);
  });

  test("both settings reach the page that draws them", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    await patch(u.id, { quotaPerDay: 7, assistantAllowed: false });
    const body = (await (await h.call(`/api/admin/users/${u.id}`, { bearer: API_KEY })).json()) as {
      user: { quotaPerDay: number | null; assistantAllowed: boolean };
    };
    expect(body.user).toMatchObject({ quotaPerDay: 7, assistantAllowed: false });
  });
});

/**
 * THE SETTINGS THAT APPLY TO EVERYBODY, and the two things about them that could quietly rot.
 *
 * One: the site quota has to be the one the REQUEST rule and the USER PAGE both read, or an
 * operator lowers a limit and the page goes on quoting the env. Two: `assistantAllowedByDefault`
 * has to reach the next account CREATED, which is the only moment it applies -- the column is
 * NOT NULL, so it is a creation default rather than a fallback, and nothing else would notice.
 */
describe("the site defaults an operator sets", () => {
  const read = () => h.call("/api/admin/settings", { bearer: API_KEY });
  const patch = (body: unknown) =>
    h.call("/api/admin/settings", { method: "PATCH", bearer: API_KEY, body: JSON.stringify(body) });

  test("a signed-in member cannot read them, and gets the admin surface's 404", async () => {
    expect((await h.call("/api/admin/settings", { cookie: signIn("user") })).status).toBe(404);
  });

  test("with nothing saved, they are the env-derived seed", async () => {
    const body = (await (await read()).json()) as { settings: { requestQuotaPerDay: number } };
    expect(body.settings.requestQuotaPerDay).toBe(siteSettingsSeed(config()).requestQuotaPerDay);
  });

  test("a saved quota is what a PATCH answers with and what a later GET returns", async () => {
    const saved = (await (await patch({ requestQuotaPerDay: 4 })).json()) as {
      settings: { requestQuotaPerDay: number };
    };
    expect(saved.settings.requestQuotaPerDay).toBe(4);
    const body = (await (await read()).json()) as { settings: { requestQuotaPerDay: number } };
    expect(body.settings.requestQuotaPerDay).toBe(4);
  });

  /**
   * The join that makes the setting mean anything: a person with NO override of their own is
   * bound by whatever the operator just saved, and `siteLimitPerDay` on their page agrees.
   * These two came from `cfg.requests.quotaPerDay` before this card and would have gone on
   * quoting it while the request route obeyed something else.
   */
  test("it becomes the limit for somebody with no override, on the page and in the rule", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    await patch({ requestQuotaPerDay: 6 });
    const body = (await (await h.call(`/api/admin/users/${u.id}`, { bearer: API_KEY })).json()) as {
      quota: { limitPerDay: number; siteLimitPerDay: number; applies: boolean };
    };
    expect(body.quota).toMatchObject({ limitPerDay: 6, siteLimitPerDay: 6, applies: true });
  });

  test("a person's own override still beats it", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    h.auth.updateUser(u.id, { quotaPerDay: 2 });
    await patch({ requestQuotaPerDay: 6 });
    const body = (await (await h.call(`/api/admin/users/${u.id}`, { bearer: API_KEY })).json()) as {
      quota: { limitPerDay: number; siteLimitPerDay: number };
    };
    expect(body.quota).toMatchObject({ limitPerDay: 2, siteLimitPerDay: 6 });
  });

  test("turning the assistant default off applies to the NEXT account, not to existing ones", async () => {
    const before = h.auth.createUser({ displayName: "Before", role: "user" });
    await patch({ assistantAllowedByDefault: false });
    const after = h.auth.createUser({ displayName: "After", role: "user" });

    expect(h.auth.getUser(after.id)?.assistantAllowed).toBe(false);
    // The surprising half, asserted so nobody "fixes" it into a mass update by accident.
    expect(h.auth.getUser(before.id)?.assistantAllowed).toBe(true);
  });

  test("a nonsense value is a 400 and saves nothing, not even the valid field beside it", async () => {
    await patch({ requestQuotaPerDay: 5 });
    expect((await patch({ requestQuotaPerDay: 2.5, assistantAllowedByDefault: false })).status).toBe(400);
    expect(h.settings.read()).toEqual({ requestQuotaPerDay: 5, assistantAllowedByDefault: true });
  });

  test("a change is logged, because nothing else records who widened everybody's quota", async () => {
    await patch({ requestQuotaPerDay: 9 });
    expect(h.logs.some((l) => l.includes("site settings updated"))).toBe(true);
  });
});

/**
 * REVOKING ONE DEVICE rather than every way in.
 *
 * `/reset` is the blunt instrument and it is for a lost ACCOUNT. These two are for a lost
 * LAPTOP: end that browser's session, or kill that authenticator for good. Both are scoped by
 * the target user in the store's WHERE, so an id belonging to somebody else is a 404 rather
 * than somebody else's row disappearing.
 */
describe("revoking one passkey or one session", () => {
  test("a named credential goes, and the rest stay", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    h.auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0 });
    h.auth.addCredential({ id: "c2", userId: u.id, publicKey: "pk2", counter: 0 });

    const res = await h.call(`/api/admin/users/${u.id}/credentials/c1`, {
      method: "DELETE",
      bearer: API_KEY,
    });
    expect(res.status).toBe(200);
    expect(h.auth.credentialsFor(u.id).map((c) => c.id)).toEqual(["c2"]);
  });

  test("a named session goes, and that browser is signed out", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    const token = h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    const [session] = h.auth.sessionsFor(u.id);

    const res = await h.call(`/api/admin/users/${u.id}/sessions/${session?.idHash}`, {
      method: "DELETE",
      bearer: API_KEY,
    });
    expect(res.status).toBe(200);
    expect(h.auth.readSession(token)).toBeNull();
  });

  test("an id belonging to somebody else is a 404 and their row survives", async () => {
    // The id is a HASH, handed to every reader of the page. Knowing one is not authority
    // over it, and the path saying otherwise must not be believed.
    const a = h.auth.createUser({ displayName: "A", role: "user" });
    const b = h.auth.createUser({ displayName: "B", role: "user" });
    h.auth.addCredential({ id: "c1", userId: b.id, publicKey: "pk", counter: 0 });
    h.auth.createSession({ userId: b.id, expiresAt: isoIn(60_000) });
    const [theirs] = h.auth.sessionsFor(b.id);

    expect(
      (await h.call(`/api/admin/users/${a.id}/credentials/c1`, { method: "DELETE", bearer: API_KEY })).status,
    ).toBe(404);
    expect(
      (
        await h.call(`/api/admin/users/${a.id}/sessions/${theirs?.idHash}`, {
          method: "DELETE",
          bearer: API_KEY,
        })
      ).status,
    ).toBe(404);
    expect(h.auth.credentialsFor(b.id)).toHaveLength(1);
    expect(h.auth.sessionsFor(b.id)).toHaveLength(1);
  });

  test("a non-admin gets 404 from both, like the rest of the admin surface", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    h.auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0 });
    const cookie = signIn("user");

    expect(
      (await h.call(`/api/admin/users/${u.id}/credentials/c1`, { method: "DELETE", cookie })).status,
    ).toBe(404);
    expect(
      (await h.call(`/api/admin/users/${u.id}/sessions/whatever`, { method: "DELETE", cookie })).status,
    ).toBe(404);
    expect(h.auth.credentialsFor(u.id)).toHaveLength(1);
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

/**
 * `GET /api/admin/users/:id` -- the one endpoint the redesigned user page is built on.
 *
 * The properties worth pinning are the ones a later change could quietly lose: that it is
 * closed to a non-admin like the rest of `/api/admin/*`, that it reports the same access
 * facts `/api/auth/me` reports (they are one method now, and this is what would notice them
 * drifting apart again), and that "the quota does not apply" is an answer it SENDS rather
 * than something the page infers.
 */
describe("one person, whole", () => {
  /** A member with a passkey, a session and the one request in the fake log. */
  function member(): { id: string } {
    const u = h.auth.createUser({ id: "u-secret", displayName: "Ada", role: "user" });
    h.auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0, label: "Ada's phone" });
    h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000), userAgent: "Mozilla/5.0 (iPhone)" });
    return u;
  }

  const detailOf = async (id: string) =>
    (await (await h.call(`/api/admin/users/${id}`, { bearer: API_KEY })).json()) as {
      user: { displayName: string };
      credentials: { id: string; label: string | null }[];
      sessions: { id: string; userAgent: string | null; current: boolean }[];
      requests: { tconst: string; requested_by?: string }[];
      quota: {
        limitPerDay: number;
        siteLimitPerDay: number;
        usedToday: number;
        resetsAt: string;
        applies: boolean;
      };
      agentKey: { readOnly: boolean } | null;
    };

  test("identity, every credential, every session and their requests, in one call", async () => {
    const u = member();
    const body = await detailOf(u.id);

    expect(body.user.displayName).toBe("Ada");
    expect(body.credentials.map((c) => c.label)).toEqual(["Ada's phone"]);
    expect(body.sessions.map((s) => s.userAgent)).toEqual(["Mozilla/5.0 (iPhone)"]);
    expect(body.requests.map((r) => r.tconst)).toEqual(["tt0111161"]);
  });

  /*
    Only THEIR rows. The fake log holds one request and it belongs to `u-secret`, so a second
    account must come back with an empty list -- the failure this guards is a page that draws
    the whole house's log under one person's name.
  */
  test("somebody else's requests are not on their page", async () => {
    member();
    const other = h.auth.createUser({ displayName: "Bob", role: "user" });
    expect((await detailOf(other.id)).requests).toEqual([]);
  });

  test("no session is 'this device' when an admin is reading somebody else's page", async () => {
    const u = member();
    expect((await detailOf(u.id)).sessions.every((s) => !s.current)).toBe(true);
  });

  /*
    THE SAME ACCESS FACTS AS `/api/auth/me`, asserted as an equality rather than by listing
    the fields twice. They are built by one method taking whose session is live, and the day
    somebody re-inlines one of them this is what fails.
  */
  test("the access half matches what the person's own /api/auth/me reports", async () => {
    const u = h.auth.createUser({ displayName: "Ada", role: "user" });
    h.auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0, label: "phone" });
    const token = h.auth.createSession({ userId: u.id, expiresAt: isoIn(60_000), userAgent: "iPhone" });
    h.auth.createUser({ displayName: "Root", role: "admin" });

    const mine = (await (await h.call("/api/auth/me", { cookie: `${SESSION_COOKIE}=${token}` })).json()) as {
      credentials: unknown[];
      sessions: { current: boolean }[];
    };
    const theirs = await detailOf(u.id);

    expect(theirs.credentials).toEqual(mine.credentials as typeof theirs.credentials);
    // Same rows, and `current` is the ONE field that legitimately differs: the cookie is
    // theirs on their own page and nobody's on the admin's.
    expect(theirs.sessions.map((s) => ({ ...s, current: true }))).toEqual(
      mine.sessions.map((s) => ({ ...s, current: true })) as typeof theirs.sessions,
    );
    expect(mine.sessions.map((s) => s.current)).toEqual([true]);
  });

  test("an unknown id is a 404, not an empty person", async () => {
    expect((await h.call("/api/admin/users/nobody", { bearer: API_KEY })).status).toBe(404);
  });

  test("an ordinary user cannot read anybody's page, their own included", async () => {
    const u = member();
    const cookie = signIn("user");
    expect((await h.call(`/api/admin/users/${u.id}`, { cookie })).status).toBe(404);
  });

  describe("the quota it reports", () => {
    test("does not apply when no limit is configured -- the default", async () => {
      const u = member();
      const body = await detailOf(u.id);
      expect(body.quota).toEqual({
        limitPerDay: 0,
        siteLimitPerDay: 0,
        usedToday: 1,
        resetsAt: utcDayReset(),
        applies: false,
      });
    });

    /**
     * The override wins, and it is reported as a DIFFERENT field from the site's.
     *
     * Both travel because the editor has to offer "follow the site default (N)" as a real
     * choice, and a page that only saw the effective number could not tell "5 because we said
     * so" from "5 because the site says so" -- so it could not draw the difference, and
     * clearing the override would look like a no-op.
     */
    test("a per-user override replaces the site's, and both are visible", async () => {
      const limited = harness({ cfg: { ...config(), requests: { quotaPerDay: 5 } } });
      const u = limited.auth.createUser({ displayName: "Ada", role: "user" });
      limited.auth.updateUser(u.id, { quotaPerDay: 2 });

      const body = (await (await limited.call(`/api/admin/users/${u.id}`, { bearer: API_KEY })).json()) as {
        quota: { limitPerDay: number; siteLimitPerDay: number; applies: boolean };
        user: { quotaPerDay: number | null };
      };
      expect(body.quota.limitPerDay).toBe(2);
      expect(body.quota.siteLimitPerDay).toBe(5);
      expect(body.quota.applies).toBe(true);
      expect(body.user.quotaPerDay).toBe(2);
    });

    /**
     * ZERO IS AN ANSWER, NOT AN EMPTY FIELD. It means "no limit for this person", and it has
     * to survive the site later capping everybody else -- which is exactly what `??` buys
     * over `||` in `quotaLimitFor`, and what this pins.
     */
    test("an override of zero exempts one person from a site-wide limit", async () => {
      const limited = harness({ cfg: { ...config(), requests: { quotaPerDay: 5 } } });
      const u = limited.auth.createUser({ displayName: "Ada", role: "user" });
      limited.auth.updateUser(u.id, { quotaPerDay: 0 });

      const body = (await (await limited.call(`/api/admin/users/${u.id}`, { bearer: API_KEY })).json()) as {
        quota: { limitPerDay: number; applies: boolean };
      };
      expect(body.quota.limitPerDay).toBe(0);
      expect(body.quota.applies).toBe(false);
    });

    test("applies to a member once a limit is set, and never to an admin", async () => {
      const limited = harness({ cfg: { ...config(), requests: { quotaPerDay: 5 } } });
      const u = limited.auth.createUser({ id: "u-secret", displayName: "Ada", role: "user" });
      const boss = limited.auth.createUser({ displayName: "Root", role: "admin" });
      const applies = async (id: string) =>
        (
          (await (await limited.call(`/api/admin/users/${id}`, { bearer: API_KEY })).json()) as {
            quota: { applies: boolean };
          }
        ).quota.applies;

      expect(await applies(u.id)).toBe(true);
      expect(await applies(boss.id)).toBe(false);
    });

    test("counts against TODAY, not against some other window", async () => {
      const u = member();
      await detailOf(u.id);
      expect(h.counted).toEqual([{ userId: u.id, sinceIso: utcDayStart() }]);
    });
  });

  /*
    Present or absent. Only the sha256 is stored, so there is no token to leak -- but the
    HASH is in the row, and this is what stops it being spread into an admin's JSON by a
    later hand reaching for `agentKeyFor` directly.
  */
  test("an agent key is reported as existing, never as a credential", async () => {
    const u = member();
    expect((await detailOf(u.id)).agentKey).toBeNull();

    const { token } = h.auth.putAgentKey({ userId: u.id, readOnly: true });
    const body = await detailOf(u.id);
    expect(body.agentKey?.readOnly).toBe(true);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(hashToken(token));
  });
});

describe("the people list", () => {
  test("counts each person's requests over the last seven UTC days, today included", async () => {
    h.auth.createUser({ id: "u-secret", displayName: "Ada", role: "user" });
    const body = (await (await h.call("/api/admin/users", { bearer: API_KEY })).json()) as {
      users: { displayName: string; requestsThisWeek: number }[];
    };
    expect(body.users.map((u) => [u.displayName, u.requestsThisWeek])).toEqual([["Ada", 1]]);
    expect(h.counted).toEqual([{ userId: "u-secret", sinceIso: utcDayStartDaysAgo(6) }]);
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
    // SOMEBODY ALREADY HAS AN ACCOUNT, and that is now part of the scenario rather than
    // scenery. A server with none is in its first-run window, where a tokenless sign-up is
    // the admin claim and is SUPPOSED to succeed -- see the first-run describe below. This
    // test is about the ordinary server, where an uninvited stranger gets nothing.
    p.auth.createUser({ displayName: "Somebody", role: "admin" });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(403);
    expect(p.auth.userCount()).toBe(1);
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

  /*
    THE THIRD BRANCH: with `plex.openSignup` on, access to our server is sufficient on its
    own and no invite is minted for anybody. `config.test.ts` owns whether the flag may be
    live at all; these own what the route does once it is.
  */
  describe("open signup for our own Plex server's users", () => {
    /** A server that has opted in, with somebody already on it so first-run is shut. */
    function openSignupHarness(opts: {
      machineIds: string[];
      openSignup?: boolean;
      machineId?: string | undefined;
    }) {
      const cfg = config();
      cfg.plex = { ...cfg.plex, openSignup: opts.openSignup ?? true, machineIdentifier: opts.machineId };
      const p = harness({
        cfg,
        fetchImpl: plexFetch({ token: "plex-token", accountId: "999", machineIds: opts.machineIds }),
      });
      p.auth.createUser({ displayName: "Somebody", role: "admin" });
      return p;
    }

    /** Begin and finish in one step, since no test here needs anything in between. */
    async function signIn(p: Harness): Promise<Response> {
      const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
        pinId: string;
      };
      return p.call("/api/auth/plex/finish", {
        method: "POST",
        body: JSON.stringify({ pinId: begin.pinId }),
      });
    }

    /*
      THE FENCE, at the route rather than at the boot. `loadConfig` refuses this combination
      outright -- config.test.ts proves it -- but this harness builds a Config by hand and
      never calls `validate`, which is exactly the position a future caller could end up in.
      A flag with no server to check against must open NOTHING.
    */
    test("the flag with no machine identifier opens no door at all", async () => {
      const p = openSignupHarness({ machineIds: ["our-server"], machineId: undefined });
      expect((await signIn(p)).status).toBe(403);
      expect(p.auth.userCount()).toBe(1);
    });

    test("an account shared our server signs itself in, with no invite anywhere", async () => {
      const p = openSignupHarness({ machineIds: ["our-server"], machineId: "our-server" });
      const res = await signIn(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("fdr_sid=");
      const user = p.auth.getUserByPlexId("999");
      // Always `user`. The open door is not a way to become an admin of a process holding
      // the Radarr and Sonarr keys.
      expect(user?.role).toBe("user");
      expect(user?.displayName).toBe("guest");
      expect(p.auth.listInvites()).toHaveLength(0);
    });

    test("it does not bypass gate two -- a stranger's Plex account is still refused", async () => {
      const p = openSignupHarness({ machineIds: ["someone-elses"], machineId: "our-server" });
      expect((await signIn(p)).status).toBe(403);
      expect(p.auth.userCount()).toBe(1);
    });

    /*
      A carried invite still decides the role, so an admin invite is not quietly downgraded
      by the door being open. The open branch is the FALLBACK, never the rule.
    */
    test("a live invite still wins, and keeps its own role", async () => {
      const cfg = config();
      cfg.plex = { ...cfg.plex, openSignup: true, machineIdentifier: "our-server" };
      const p = harness({
        cfg,
        fetchImpl: plexFetch({ token: "plex-token", accountId: "999", machineIds: ["our-server"] }),
      });
      p.auth.createUser({ displayName: "Somebody", role: "admin" });
      const { token } = p.auth.createInvite({
        role: "admin",
        displayName: "Deputy",
        expiresAt: isoIn(60_000),
      });
      const begin = (await (
        await p.call("/api/auth/plex/begin", { method: "POST", body: JSON.stringify({ token }) })
      ).json()) as { pinId: string };

      const res = await p.call("/api/auth/plex/finish", {
        method: "POST",
        body: JSON.stringify({ pinId: begin.pinId }),
      });
      expect(res.status).toBe(200);
      const user = p.auth.getUserByPlexId("999");
      expect(user?.role).toBe("admin");
      expect(user?.displayName).toBe("Deputy");
      expect(p.auth.getInvite(hashToken(token))?.redeemedBy).toBe(user?.id);
    });

    /*
      An EXPIRED link is not a revocation while the door is open -- the same person could
      have signed in without ever having a link -- so it falls through to the open branch
      and gets the ordinary `user` role rather than a 403 that would depend on which page
      they happened to arrive from. Disabling the row is what revokes; see plex-auth.ts.
    */
    test("a dead invite falls through to the open door, as a plain user", async () => {
      const cfg = config();
      cfg.plex = { ...cfg.plex, openSignup: true, machineIdentifier: "our-server" };
      const p = harness({
        cfg,
        fetchImpl: plexFetch({ token: "plex-token", accountId: "999", machineIds: ["our-server"] }),
      });
      p.auth.createUser({ displayName: "Somebody", role: "admin" });
      const { token } = p.auth.createInvite({
        role: "admin",
        displayName: "Deputy",
        expiresAt: isoIn(-60_000),
      });
      const begin = (await (
        await p.call("/api/auth/plex/begin", { method: "POST", body: JSON.stringify({ token }) })
      ).json()) as { pinId: string };

      const res = await p.call("/api/auth/plex/finish", {
        method: "POST",
        body: JSON.stringify({ pinId: begin.pinId }),
      });
      expect(res.status).toBe(200);
      expect(p.auth.getUserByPlexId("999")?.role).toBe("user");
      expect(p.auth.getInvite(hashToken(token))?.redeemedBy).toBeNull();
    });
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

/*
  The first visitor to a server with no accounts becomes its admin, and then nobody else
  ever can. These are the ROUTE-level halves of that; `../lib/first-run.test.ts` owns the
  latch itself.
*/
describe("the first-run admin claim", () => {
  test("with no accounts the sign-in state offers setup", async () => {
    const body = (await (await h.call("/api/auth/state")).json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: false, plex: false, setup: true });
  });

  /*
    ABSENT, not `false`. The field says "this server has no accounts", and on every server
    that does have them the honest answer is to say nothing at all -- see the state route.
  */
  test("the moment an account exists the field is gone entirely", async () => {
    h.auth.createUser({ displayName: "somebody", role: "admin" });
    const body = (await (await h.call("/api/auth/state")).json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: false, plex: false });
  });

  test("a tokenless passkey sign-up is authorised by an ADMIN invite minted for it", async () => {
    const res = await h.call("/api/auth/passkey/register/begin", {
      method: "POST",
      body: JSON.stringify({ displayName: "First" }),
    });
    expect(res.status).toBe(200);
    const claims = h.auth.listInvites();
    expect(claims).toHaveLength(1);
    expect(claims[0].role).toBe("admin");
    expect(claims[0].createdBy).toBe("first-run");
  });

  /*
    ONE claim, however many people are looking at the page. Two invites would be two admins,
    because each would be redeemable once; sharing a single row makes `claimInvite` -- one
    UPDATE, decided by SQLite -- the thing that picks the winner.
  */
  test("two visitors racing the door share one invite, so only one of them can win", async () => {
    const begin = () => h.call("/api/auth/passkey/register/begin", { method: "POST", body: "{}" });
    expect((await begin()).status).toBe(200);
    expect((await begin()).status).toBe(200);
    expect(h.auth.listInvites()).toHaveLength(1);
  });

  test("Plex is the other door, and it creates the admin outright", async () => {
    const p = harness({
      fetchImpl: async (url) => {
        if (url.includes("/pins?strong=true"))
          return Response.json({ id: 1682300520, code: "abc123", expiresIn: 1800 });
        if (url.includes("/pins/")) return Response.json({ authToken: "plex-token" });
        if (url.endsWith("/user")) return Response.json({ id: "999", username: "first" });
        return new Response("{}", { status: 404 });
      },
    });
    const begin = (await (await p.call("/api/auth/plex/begin", { method: "POST" })).json()) as {
      pinId: string;
    };
    const res = await p.call("/api/auth/plex/finish", {
      method: "POST",
      body: JSON.stringify({ pinId: begin.pinId }),
    });
    expect(res.status).toBe(200);
    expect(p.auth.getUserByPlexId("999")?.role).toBe("admin");
  });

  /*
    THE RULE THE WHOLE DESIGN EXISTS FOR. `userCount() === 0` is true both on a fresh
    install and on a server whose only admin was just deleted, and reopening the door on the
    second is how a stranger inherits the Radarr, Sonarr and Plex credentials.
  */
  test("deleting the last user does NOT reopen it", async () => {
    const u = h.auth.createUser({ displayName: "Only", role: "admin" });
    // Reading the state is what latches the door shut -- the same read the sign-in page does.
    await h.call("/api/auth/state");
    h.auth.deleteUser(u.id);
    expect(h.auth.userCount()).toBe(0);

    const body = (await (await h.call("/api/auth/state")).json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: false, plex: false });
    const res = await h.call("/api/auth/passkey/register/begin", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "that did not work" });
  });

  test("a closed door is the SAME refusal every other anonymous failure gives", async () => {
    h.auth.createUser({ displayName: "somebody", role: "admin" });
    const claim = await h.call("/api/auth/passkey/register/begin", { method: "POST", body: "{}" });
    const deadInvite = await h.call("/api/auth/passkey/register/begin", {
      method: "POST",
      body: JSON.stringify({ token: "nope" }),
    });
    expect(claim.status).toBe(deadInvite.status);
    expect(await claim.json()).toEqual(await deadInvite.json());
  });

  test("an abandoned claim is revoked once an account exists by any other route", async () => {
    await h.call("/api/auth/passkey/register/begin", { method: "POST", body: "{}" });
    expect(h.auth.listInvites()).toHaveLength(1);
    // The operator used the bootstrap invite from the log instead, so the claim is orphaned:
    // an admin invitation whose window has closed has no business outliving it.
    h.auth.createUser({ displayName: "Operator", role: "admin" });
    await h.call("/api/auth/state");
    expect(h.auth.listInvites()).toHaveLength(0);
  });

  test("it is rate limited on the same limiter as the rest of the auth surface", async () => {
    const limited = harness({ cfg: config({ authRatePerMinute: 1 }) });
    const claim = () => limited.call("/api/auth/passkey/register/begin", { method: "POST", body: "{}" });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(429);
  });

  /*
    `FINDERR_NO_AUTH` creates its account before anything can be first to the page -- at boot
    in the server, and on the first request here. So the mode whose whole point is that
    everybody is already signed in never has a claimable window at all.
  */
  test("FINDERR_NO_AUTH short-circuits it, because its account already exists", async () => {
    const dev = harness({ cfg: config({ noAuth: true }) });
    const body = (await (await dev.call("/api/auth/state")).json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: true, user: expect.objectContaining({ role: "admin" }) });
    expect(dev.service.firstRun.open()).toBe(false);
  });

  test("the bootstrap invite still works while the door is open -- two doors, not one", async () => {
    const { token } = h.auth.createInvite({
      role: "admin",
      displayName: "admin",
      createdBy: "bootstrap",
      expiresAt: isoIn(60_000),
    });
    const res = await h.call(`/api/auth/invite?token=${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, displayName: "admin" });
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
