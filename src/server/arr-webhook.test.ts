import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import { type MediaRequest, Store } from "../lib/store";
import { ARR_WEBHOOK_PATH, ArrWebhookService } from "./arr-webhook";

/**
 * The route half: who may call, and which request row an event lands on.
 *
 * A REAL `Store` on a temporary file rather than a stub, because the two things worth
 * proving here -- that the right row moves and that no other row does -- are claims about
 * SQL. The vocabulary and the transition table are covered against object literals in
 * `../lib/arr-webhook.test.ts`; this file does not repeat them.
 */

const PASSWORD = "correct horse battery staple";
const RADARR_MOVIE = { id: 12, title: "Inception", imdbId: "tt1375666" };
const SONARR_SERIES = { id: 77, title: "Severance", imdbId: "tt11280740" };

let dir: string;
let store: Store;
let logged: string[];

/** A service with the defaults every test starts from, and whatever one test overrides. */
function service(
  over: {
    lanOnly?: boolean;
    password?: string;
    ratePerMinute?: number;
    address?: string | null;
    trustProxy?: boolean;
  } = {},
) {
  return new ArrWebhookService({
    store,
    webhook: {
      username: "finderr",
      password: "password" in over ? over.password : PASSWORD,
      lanOnly: over.lanOnly ?? false,
      ratePerMinute: over.ratePerMinute ?? 300,
    },
    trustProxy: over.trustProxy ?? false,
    addressOf: () => ("address" in over ? (over.address ?? null) : "192.168.1.12"),
    log: (m) => logged.push(m),
  });
}

function post(body: unknown, opts: { auth?: string | null; headers?: Record<string, string> } = {}) {
  const auth = "auth" in opts ? opts.auth : `Basic ${btoa(`finderr:${PASSWORD}`)}`;
  return new Request(`http://finderr.example${ARR_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
      ...opts.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A request row in whatever state a test needs, without going through the worker. */
function request(over: Partial<MediaRequest> & Pick<MediaRequest, "tconst">): MediaRequest {
  store.createRequest({
    tconst: over.tconst,
    title: over.title ?? "Inception",
    year: 2010,
    kind: over.kind ?? "movie",
    service: over.service ?? "radarr",
  });
  store.updateRequest(over.tconst, {
    status: over.status ?? "sent",
    arr_id: over.arr_id ?? null,
    error: over.error ?? null,
  });
  return store.getRequest(over.tconst) as MediaRequest;
}

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-webhook-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
  logged = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

describe("who may call", () => {
  /*
    THE DEFAULT IS CLOSED. This route is on `AuthService.publicPaths()` -- it has to be,
    an arr has no cookie -- so an install that never configured a password would otherwise
    be publishing an anonymous writer of its own request log to the internet.
  */
  test("no configured password refuses everybody, including a caller with credentials", async () => {
    const res = await service({ password: undefined }).handle(post({ eventType: "Test" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "that did not work" });
  });

  test("a missing, malformed or wrong credential is one indistinguishable 401", async () => {
    const svc = service();
    const bodies = await Promise.all(
      [
        null,
        "Bearer something",
        "Basic not-base64-at-all",
        `Basic ${btoa("finderr")}`,
        `Basic ${btoa("finderr:wrong")}`,
        `Basic ${btoa(`someone-else:${PASSWORD}`)}`,
      ].map(async (auth) => {
        const res = await svc.handle(post({ eventType: "Test" }, { auth }));
        return { status: res.status, body: await res.json() };
      }),
    );
    for (const got of bodies) expect(got).toEqual({ status: 401, body: { error: "that did not work" } });
  });

  test("a 401 asks for basic auth by name, so an arr's own fields are enough", async () => {
    const res = await service().handle(post({ eventType: "Test" }, { auth: null }));
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="finderr"');
  });

  // A password may legitimately contain a colon; splitting on every one would truncate it
  // and refuse a caller who sent exactly the right secret.
  test("a password containing a colon still matches", async () => {
    const svc = new ArrWebhookService({
      store,
      webhook: { username: "finderr", password: "a:b:c", lanOnly: false, ratePerMinute: 300 },
      trustProxy: false,
      addressOf: () => "192.168.1.12",
      log: (m) => logged.push(m),
    });
    const res = await svc.handle(post({ eventType: "Test" }, { auth: `Basic ${btoa("finderr:a:b:c")}` }));
    expect(res.status).toBe(200);
  });

  test("the right credentials pass", async () => {
    expect((await service().handle(post({ eventType: "Test" }))).status).toBe(200);
  });
});

describe("the private-network second layer", () => {
  test("off by default, so a deployment whose arrs are elsewhere still works", async () => {
    const res = await service({ address: "203.0.113.9" }).handle(post({ eventType: "Test" }));
    expect(res.status).toBe(200);
  });

  test("on, a public source is refused before its credentials are even read", async () => {
    const res = await service({ lanOnly: true, address: "203.0.113.9" }).handle(post({ eventType: "Test" }));
    expect(res.status).toBe(403);
    expect(logged.join("\n")).toContain("not a private address");
  });

  test("on, the LAN passes", async () => {
    const res = await service({ lanOnly: true, address: "192.168.1.12" }).handle(post({ eventType: "Test" }));
    expect(res.status).toBe(200);
  });

  /*
    Behind Caddy every request carries the proxy's own address, so the check has to read
    the source the same way the rate limiter does -- through `trustProxy`. Getting this
    wrong in either direction fails silently: off behind a proxy, every caller looks like
    one private address and the check is worthless.
  */
  test("behind a trusted proxy it reads the forwarded source, not the proxy", async () => {
    const outside = { "x-forwarded-for": "203.0.113.9" };
    const refused = await service({ lanOnly: true, trustProxy: true, address: "192.168.1.240" }).handle(
      post({ eventType: "Test" }, { headers: outside }),
    );
    expect(refused.status).toBe(403);

    const inside = { "x-forwarded-for": "192.168.1.12" };
    const allowed = await service({ lanOnly: true, trustProxy: true, address: "192.168.1.240" }).handle(
      post({ eventType: "Test" }, { headers: inside }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("what an authenticated caller gets back", () => {
  /*
    An arr marks a connection unhealthy on any non-2xx, so "we understood you and there was
    nothing to do" has to be a 200 -- or an operator goes hunting for a broken integration
    that works.
  */
  test("an event finderr ignores is still a 200", async () => {
    const res = await service().handle(post({ eventType: "Rename", series: SONARR_SERIES }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, event: "ignored", tconst: null, status: null });
  });

  test("an event about a title nobody requested is a 200 and no row", async () => {
    const res = await service().handle(post({ eventType: "Grab", movie: RADARR_MOVIE, release: {} }));
    expect(await res.json()).toEqual({ ok: true, event: "grabbed", tconst: null, status: null });
  });

  test("the Test button says so in the log, which is how a connection is confirmed", async () => {
    await service().handle(post({ eventType: "Test", movie: RADARR_MOVIE }));
    expect(logged.join("\n")).toContain("the connection works");
  });

  test("a body that is not an arr payload is the one 400", async () => {
    const svc = service();
    expect((await svc.handle(post("not json at all"))).status).toBe(400);
    expect((await svc.handle(post({ hello: "world" }))).status).toBe(400);
  });

  test("a burst past the limit is refused with a Retry-After", async () => {
    const svc = service({ ratePerMinute: 2 });
    expect((await svc.handle(post({ eventType: "Test" }))).status).toBe(200);
    expect((await svc.handle(post({ eventType: "Test" }))).status).toBe(200);
    const third = await svc.handle(post({ eventType: "Test" }));
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  /*
    The limiter must bite an attacker guessing the password, not only callers who got it
    right -- so it runs BEFORE the credential check rather than after it.
  */
  test("the limit applies to failed attempts too", async () => {
    const svc = service({ ratePerMinute: 1 });
    expect((await svc.handle(post({ eventType: "Test" }, { auth: "Basic bad" }))).status).toBe(401);
    expect((await svc.handle(post({ eventType: "Test" }))).status).toBe(429);
  });
});

describe("which request row an event lands on", () => {
  test("a grab moves the request it names, by IMDb id", async () => {
    request({ tconst: "tt1375666", status: "sent" });
    const res = await service().handle(
      post({ eventType: "Grab", movie: RADARR_MOVIE, release: { quality: "Bluray-1080p" } }),
    );
    expect(await res.json()).toEqual({
      ok: true,
      event: "grabbed",
      tconst: "tt1375666",
      status: "grabbed",
    });
    expect(store.getRequest("tt1375666")?.status).toBe("grabbed");
  });

  test("a title with no IMDb id is found by the arr's own row id", async () => {
    request({ tconst: "tt9999999", status: "sent", arr_id: 12 });
    await service().handle(
      post({ eventType: "Grab", movie: { id: 12, title: "Untracked", imdbId: "" }, release: {} }),
    );
    expect(store.getRequest("tt9999999")?.status).toBe("grabbed");
  });

  /*
    Radarr movie 42 and Sonarr series 42 are unrelated rows. A lookup on the id alone would
    occasionally file an event against somebody else's request.
  */
  test("the arr-id fallback is scoped to the service that sent the event", async () => {
    request({ tconst: "tt0000001", status: "sent", arr_id: 42, service: "radarr" });
    await service().handle(
      post({ eventType: "Grab", series: { id: 42, title: "Something else", imdbId: "" }, release: {} }),
    );
    expect(store.getRequest("tt0000001")?.status).toBe("sent");
  });

  test("an IMDb match from the wrong service is refused rather than written", async () => {
    request({ tconst: "tt1375666", status: "sent", service: "radarr" });
    const res = await service().handle(
      post({ eventType: "Grab", series: { id: 5, title: "Inception", imdbId: "tt1375666" }, release: {} }),
    );
    expect(await res.json()).toMatchObject({ tconst: null, status: null });
    expect(store.getRequest("tt1375666")?.status).toBe("sent");
  });

  test("a blocked import reaches the state no poll can see", async () => {
    request({ tconst: "tt11280740", status: "grabbed", service: "sonarr", kind: "tvSeries" });
    await service().handle(
      post({ eventType: "ManualInteractionRequired", series: SONARR_SERIES, downloadStatus: "Warning" }),
    );
    expect(store.getRequest("tt11280740")?.status).toBe("manual_import");
  });

  test("the import that follows clears it", async () => {
    request({ tconst: "tt11280740", status: "manual_import", service: "sonarr", kind: "tvSeries" });
    await service().handle(post({ eventType: "Download", series: SONARR_SERIES, episodeFiles: [{ id: 1 }] }));
    expect(store.getRequest("tt11280740")?.status).toBe("downloading");
  });

  // A row coming back from `failed` still carries the sanitised reason it failed, and
  // leaving it would put a stale sentence beside a request that is visibly working again.
  test("a status write clears the error that went with the old one", async () => {
    request({ tconst: "tt1375666", status: "failed", error: "Radarr already has that title" });
    await service().handle(post({ eventType: "Grab", movie: RADARR_MOVIE, release: {} }));
    expect(store.getRequest("tt1375666")).toMatchObject({ status: "grabbed", error: null });
  });

  test("an event that moves nothing leaves the row exactly as it was", async () => {
    request({ tconst: "tt1375666", status: "available" });
    const res = await service().handle(
      post({ eventType: "MovieFileDelete", movie: RADARR_MOVIE, deleteReason: "Upgrade" }),
    );
    expect(await res.json()).toEqual({
      ok: true,
      event: "file_removed",
      tconst: "tt1375666",
      status: null,
    });
    expect(store.getRequest("tt1375666")?.status).toBe("available");
  });
});

describe("stats", () => {
  test("received, applied and refused are what tell an operator the connection is live", async () => {
    request({ tconst: "tt1375666", status: "sent" });
    const svc = service();
    await svc.handle(post({ eventType: "Test" }, { auth: "Basic bad" }));
    await svc.handle(post({ eventType: "Rename", movie: RADARR_MOVIE }));
    await svc.handle(post({ eventType: "Grab", movie: RADARR_MOVIE, release: {} }));
    expect(svc.stats()).toEqual({ enabled: true, received: 2, applied: 1, refused: 1 });
  });

  test("no password reads as disabled, which is what a fresh install looks like", () => {
    expect(service({ password: undefined }).stats().enabled).toBe(false);
  });
});
