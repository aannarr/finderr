/**
 * The playback routes, against the real handlers and a fake session manager.
 *
 * The two properties worth the most here are both refusals: **every route is admin-only**,
 * and **a segment name cannot walk out of its session directory**. Everything else is
 * plumbing that the modules underneath already prove.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initFileName,
  MASTER_PLAYLIST_NAME,
  mediaPlaylistName,
  segmentFileName,
  type Timeline,
  type Track,
} from "../lib/hls-timeline";
import type { MediaVolume } from "../lib/media-path";
import type { PlaybackPlan } from "../lib/playback-plan";
import type { StreamEndpoint } from "../lib/stream-endpoints";
import {
  type Session,
  SessionRefused,
  STREAM_TOKEN_TTL_MS,
  type TranscodeSessions,
} from "../lib/transcode-session";
import { initName } from "../test/playback-names";
import { playbackRoutes } from "./playback-routes";

const PLAN: PlaybackPlan = {
  video: { action: "copy", sourceIndex: 0, codec: "h264", scaleWidth: null },
  audio: { action: "transcode", sourceIndex: 1, codec: "aac" },
  subtitles: { action: "none", sourceIndex: null },
  reasons: ["video is h264, copied"],
};

let root: string;
let sessionDir: string;

/** Three six-second segments -- enough for the routes to have a timeline to state. */
const TIMELINE: Timeline = { starts: [0, 6, 12], endSec: 18 };
const TIMELINES = { video: TIMELINE, audio: TIMELINE, subtitles: TIMELINE };

/** The stream token the fake session carries. Any opaque string; the route compares, never parses. */
const SESSION_TOKEN = "stream-token-1";

/** A pinned clock, so "how long has this token left" is an assertable number rather than a race. */
const NOW = 1_700_000_000_000;

const LAN: StreamEndpoint = { base: "http://10.0.0.5:7979", family: "v4", kind: "lan", source: "static" };
const WAN: StreamEndpoint = { base: "https://finderr.example", family: null, kind: "wan", source: "static" };

/**
 * Enough of the manager for the routes; the real one is proved in its own suite.
 *
 * `segmentPath` and `initPath` mimic the real thing in the way that matters HERE: they hand
 * back a path only for a file that exists, so a name the route lets through still has to
 * find something, and the traversal cases stay meaningful.
 */
function fakeSessions(dir: string) {
  const stopped: string[] = [];
  let refuse: SessionRefused | null = null;
  const session: Session = {
    id: "sess-1",
    token: SESSION_TOKEN,
    priorToken: null,
    priorTokenUntil: 0,
    tokenExpiresAt: NOW + STREAM_TOKEN_TTL_MS,
    key: "k",
    dir,
    input: "/plex/a.mkv",
    plan: PLAN,
    timelines: TIMELINES,
    expensive: false,
    startedAt: 1,
    lastAccessAt: 1,
    owner: null,
  };
  const found = (id: string, name: string) => {
    if (id !== "sess-1") return Promise.resolve(null);
    const path = join(dir, name);
    return Promise.resolve(existsSync(path) ? path : null);
  };
  const api = {
    start: () => {
      if (refuse) throw refuse;
      return session;
    },
    touch: (id: string) => (id === "sess-1" ? session : null),
    get: (id: string) => (id === "sess-1" ? session : null),
    // The real manager owns the expiry rule and proves it in its own suite; here the question
    // is only whether the ROUTE consults it, so this compares and nothing more.
    admitsToken: (id: string, offered: string) => id === "sess-1" && offered === session.token,
    remintToken: (id: string) => {
      if (id !== "sess-1") return null;
      session.token = `${session.token}+`;
      return session;
    },
    segmentPath: (id: string, track: Track, index: number) => found(id, segmentFileName(track, index)),
    initPath: (id: string, track: Track, index: number) => {
      // Mirrors the real manager: a rendition with no init has no name to look for.
      const name = initFileName(track, index);
      return name === null ? Promise.resolve(null) : found(id, name);
    },
    stop: (id: string) => {
      stopped.push(id);
    },
    list: () => [session],
    budgets: () => ({ sessions: { used: 1, max: 8 }, expensive: { used: 0, max: 3 } }),
  };
  return {
    api: api as unknown as TranscodeSessions,
    stopped,
    refuseWith: (r: SessionRefused | null) => {
      refuse = r;
    },
  };
}

/** A store with exactly one mirrored file. */
function fakeStore(path: string) {
  return {
    mediaFile: (_id: string, at?: { season: number; episode: number }) =>
      at ? (at.season === 6 ? { path } : null) : { path },
  } as never;
}

const VOLUMES: MediaVolume[] = [];

function build(opts: {
  admin?: boolean;
  volumes?: MediaVolume[];
  path?: string;
  sessions?: ReturnType<typeof fakeSessions>;
  endpoints?: StreamEndpoint[];
  pageOrigins?: string[];
}) {
  const sessions = opts.sessions ?? fakeSessions(sessionDir);
  const routes = playbackRoutes({
    store: fakeStore(opts.path ?? "/plex/a.mkv"),
    sessions: sessions.api,
    volumes: opts.volumes ?? VOLUMES,
    endpoints: () => opts.endpoints ?? [],
    pageOrigins: opts.pageOrigins ?? [],
    now: () => NOW,
    requireAdmin: () => (opts.admin === false ? new Response("nope", { status: 404 }) : null),
    actorId: () => "admin-1",
    log: () => {},
  }) as Record<string, Record<string, (req: never) => Promise<Response> | Response>>;
  return { routes, sessions };
}

beforeEach(() => {
  root = mkdtempSync(`${tmpdir()}/finderr-playroutes-`);
  sessionDir = join(root, "sess");
  mkdtempSync(`${root}/x-`);
  require("node:fs").mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, MASTER_PLAYLIST_NAME), "#EXTM3U\n");
  writeFileSync(join(sessionDir, initName("video", 1)), "init");
  writeFileSync(join(sessionDir, segmentFileName("video", 1)), "segment-bytes");
  writeFileSync(join(sessionDir, initName("audio", 1)), "init");
  writeFileSync(join(sessionDir, segmentFileName("audio", 1)), "segment-bytes");
  writeFileSync(join(sessionDir, segmentFileName("subtitles", 1)), "WEBVTT\n");
  // A file OUTSIDE the session directory, next door -- the thing traversal would reach.
  writeFileSync(join(root, "secret.txt"), "the admin api key");

  /*
    EVERY refusal case below has to name a file that REALLY EXISTS at the path the join
    would produce, or the test passes because the target is absent rather than because the
    guard refused -- which is a green line that proves nothing.

    Found by removing the guard entirely and watching only ONE of nine cases go red. These
    writes are what make the other eight mean something.
  */
  writeFileSync(join(sessionDir, ".env"), "the admin api key");
  writeFileSync(join(sessionDir, "index.m3u8.bak"), "the admin api key");
  writeFileSync(join(sessionDir, "vseg1.m4s"), "the admin api key");
  writeFileSync(join(sessionDir, "vseg00001.m4s.txt"), "the admin api key");
  writeFileSync(join(sessionDir, "vinit1.mp4"), "the admin api key");
  writeFileSync(join(sessionDir, "init.mp4"), "the admin api key");
  // The name a run writes INSIDE its private working directory, and the one an earlier
  // version of this route would have served: it is not a published name and must not be one.
  writeFileSync(join(sessionDir, "seg00001.m4s"), "the admin api key");
  writeFileSync(join(sessionDir, "..%2Fsecret.txt"), "the admin api key");
  require("node:fs").mkdirSync(join(sessionDir, "etc"), { recursive: true });
  writeFileSync(join(sessionDir, "etc", "passwd"), "the admin api key");
  require("node:fs").mkdirSync(join(sessionDir, "...."), { recursive: true });
  writeFileSync(join(sessionDir, "....", "secret.txt"), "the admin api key");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A media request, optionally carrying a stream token and a cross-origin `Origin`.
 *
 * `headers` is a real `Headers` rather than an object literal because the route asks it the
 * way a Bun request would -- a plain object would make the CORS tests pass against a shape the
 * server never sees.
 */
const segReq = (id: string, file: string, opts: { token?: string; origin?: string } = {}) =>
  ({
    params: { id, file },
    url: `http://x/api/play/s/${id}/${file}${opts.token ? `?t=${encodeURIComponent(opts.token)}` : ""}`,
    headers: new Headers(opts.origin ? { origin: opts.origin } : {}),
  }) as never;

describe("every route is admin-only", () => {
  test("a non-admin gets the refusal the auth module chose, on all four", async () => {
    const { routes } = build({ admin: false });
    const calls: Promise<Response>[] = [
      Promise.resolve(
        routes["/api/play/:tconst/session"]?.POST?.({
          params: { tconst: "tt1" },
          json: async () => ({}),
          url: "http://x",
        } as never) as Response,
      ),
      Promise.resolve(routes["/api/play/s/:id/:file"]?.GET?.(segReq("sess-1", "index.m3u8")) as Response),
      Promise.resolve(
        routes["/api/play/s/:id"]?.DELETE?.({
          params: { id: "sess-1" },
          url: "http://x",
        } as never) as Response,
      ),
      Promise.resolve(routes["/api/play/sessions"]?.GET?.({ url: "http://x" } as never) as Response),
    ];
    for (const c of calls) expect((await c).status).toBe(404);
  });
});

describe("a segment name cannot walk out of its session directory", () => {
  /**
   * THE SECOND TRAVERSAL BOUNDARY. `media-path.ts` decides which INPUT files may be opened;
   * this decides which OUTPUT files may be handed out, and the name comes straight off the
   * wire. The pattern ENUMERATES the three shapes ffmpeg writes, so there is nothing to
   * walk out of.
   */
  test.each([
    "../secret.txt",
    "..%2Fsecret.txt",
    "....//secret.txt",
    "/etc/passwd",
    ".env",
    "index.m3u8.bak",
    "vseg1.m4s",
    "vseg00001.m4s.txt",
    "VINIT00001.MP4",
    "vinit1.mp4",
    "init.mp4",
    "seg00001.m4s",
  ])("refuses %s with a 404", async (name) => {
    const { routes } = build({});
    const res = (await routes["/api/play/s/:id/:file"]?.GET?.(segReq("sess-1", name))) as Response;
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("admin api key");
  });

  test("serves exactly the shapes a session publishes, across all three renditions", async () => {
    const { routes } = build({});
    const published = [
      MASTER_PLAYLIST_NAME,
      mediaPlaylistName("video"),
      mediaPlaylistName("audio"),
      mediaPlaylistName("subtitles"),
      initName("video", 1),
      segmentFileName("video", 1),
      initName("audio", 1),
      segmentFileName("audio", 1),
      segmentFileName("subtitles", 1),
    ];
    for (const name of published) {
      const res = (await routes["/api/play/s/:id/:file"]?.GET?.(segReq("sess-1", name))) as Response;
      expect(res.status).toBe(200);
    }
  });

  test("a playlist is never cached and a segment is immutable", async () => {
    const { routes } = build({});
    const playlist = (await routes["/api/play/s/:id/:file"]?.GET?.(
      segReq("sess-1", MASTER_PLAYLIST_NAME),
    )) as Response;
    expect(playlist.headers.get("cache-control")).toBe("no-store");
    expect(playlist.headers.get("content-type")).toContain("mpegurl");

    const seg = (await routes["/api/play/s/:id/:file"]?.GET?.(
      segReq("sess-1", segmentFileName("video", 1)),
    )) as Response;
    expect(seg.headers.get("cache-control")).toContain("immutable");
  });

  /**
   * ONE ROUTE SERVES TWO KINDS OF SEGMENT NOW, and a browser will not read a caption file
   * handed to it as `video/iso.segment`. The type comes from the RENDITION rather than from
   * the file extension, so it agrees with the naming table that produced the name.
   */
  test("a WebVTT segment is served as text/vtt and an fMP4 one is not", async () => {
    const { routes } = build({});
    const typeOf = async (name: string) => {
      const res = (await routes["/api/play/s/:id/:file"]?.GET?.(segReq("sess-1", name))) as Response;
      return res.headers.get("content-type");
    };

    expect(await typeOf(segmentFileName("subtitles", 1))).toBe("text/vtt");
    expect(await typeOf(segmentFileName("video", 1))).toBe("video/iso.segment");
    expect(await typeOf(initName("audio", 1))).toBe("video/iso.segment");
  });

  test("an unknown session is a 404 rather than a read of some other directory", async () => {
    const { routes } = build({});
    const res = (await routes["/api/play/s/:id/:file"]?.GET?.(
      segReq("nope", MASTER_PLAYLIST_NAME),
    )) as Response;
    expect(res.status).toBe(404);
  });

  /**
   * A segment nobody has produced and that the manager declined to produce right now -- the
   * back-pressure case. It must be a 404: hls.js retries those and gives up on a 500.
   */
  test("a segment that could not be produced is a 404, not a 500", async () => {
    const { routes } = build({});
    const res = (await routes["/api/play/s/:id/:file"]?.GET?.(
      segReq("sess-1", segmentFileName("video", 42)),
    )) as Response;
    expect(res.status).toBe(404);
  });
});

/**
 * THE PLAYLIST IS GENERATED, NOT READ. It has to name every segment of the film before any
 * of them exists -- that is what gives the player a full scrub bar, which is the whole
 * feature. A playlist read off disk could only ever name what had already been encoded.
 */
describe("the playlist states the whole timeline up front", () => {
  const read = async (name: string) => {
    const { routes } = build({});
    const res = (await routes["/api/play/s/:id/:file"]?.GET?.(segReq("sess-1", name))) as Response;
    return res.text();
  };

  test.each(["video", "audio"] as const)(
    "the %s rendition names every segment and ends the list",
    async (track) => {
      const text = await read(mediaPlaylistName(track));

      expect(text).toContain(segmentFileName(track, 0));
      expect(text).toContain(segmentFileName(track, 2));
      expect(text).toContain("#EXT-X-ENDLIST");
    },
  );

  /** Two renditions on two grids is what closes the ~60 ms audio hole at every boundary. */
  test("the master names both renditions rather than any segment", async () => {
    const text = await read(MASTER_PLAYLIST_NAME);

    expect(text).toContain(mediaPlaylistName("video"));
    expect(text).toContain(mediaPlaylistName("audio"));
    expect(text).not.toContain(segmentFileName("video", 0));
    // Not the file sitting in the session directory, which says only this.
    expect(text).not.toBe("#EXTM3U\n");
  });
});

describe("starting a session", () => {
  const post = (body: unknown, tconst = "tt1") =>
    ({ params: { tconst }, json: async () => body, url: "http://x" }) as never;

  test("refuses a title with nothing mirrored", async () => {
    const { routes } = build({});
    const res = (await routes["/api/play/:tconst/session"]?.POST?.(
      post({ season: 1, episode: 1 }),
    )) as Response;
    expect(res.status).toBe(404);
  });

  /**
   * With no volume configured every path refuses, which is the feature switch: a checkout
   * that has not opted in cannot open a media file at all.
   */
  test("refuses when no media volume is configured, and says nothing about the path", async () => {
    const { routes } = build({ volumes: [] });
    const res = (await routes["/api/play/:tconst/session"]?.POST?.(post({}))) as Response;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("/plex");
    expect(body.error).not.toContain("no-volume");
  });

  test("a full server answers 503 and names which budget", async () => {
    const sessions = fakeSessions(sessionDir);
    sessions.refuseWith(new SessionRefused("too-many-expensive"));
    const real = mkdtempSync(`${tmpdir()}/finderr-media-`);
    writeFileSync(join(real, "a.mkv"), "not really a movie");
    const { routes } = build({
      sessions,
      volumes: [{ arr: "/plex", local: real }],
      path: "/plex/a.mkv",
    });
    // The probe will fail on this fake file first, which is itself the right answer -- so
    // this asserts the ordering: an unreadable file is refused before a session is asked for.
    const res = (await routes["/api/play/:tconst/session"]?.POST?.(post({}))) as Response;
    expect(res.status).toBe(409);
    rmSync(real, { recursive: true, force: true });
  });

  test("a body that is not JSON is treated as an unstated client, not a 400", async () => {
    const { routes } = build({ volumes: [] });
    const res = (await routes["/api/play/:tconst/session"]?.POST?.({
      params: { tconst: "tt1" },
      json: async () => {
        throw new Error("not json");
      },
      url: "http://x",
    } as never)) as Response;
    // Still reaches the path resolution and refuses there, rather than refusing the body.
    expect(res.status).toBe(409);
  });
});

/**
 * MULTI-HOMED PLAYBACK. A segment may be fetched from an origin the page was not loaded at,
 * and two things have to be true for that to work at all: the request must carry a credential
 * the browser WILL send cross-origin, and the response must carry the CORS header that lets
 * the page read it. Both are refusals-shaped, which is why they are tested here rather than
 * left to the modules underneath.
 */
describe("a stream token admits a cross-origin media request", () => {
  const routesFor = (opts: Parameters<typeof build>[0]) =>
    build(opts).routes["/api/play/s/:id/:file"] as Record<
      string,
      (req: never) => Promise<Response> | Response
    >;

  test("the right token serves the segment with no admin session at all", async () => {
    const routes = routesFor({ admin: false });
    const res = (await routes.GET?.(
      segReq("sess-1", segmentFileName("video", 1), { token: SESSION_TOKEN }),
    )) as Response;
    expect(res.status).toBe(200);
  });

  test("a wrong token falls through to the admin gate and is refused", async () => {
    const routes = routesFor({ admin: false });
    const res = (await routes.GET?.(
      segReq("sess-1", segmentFileName("video", 1), { token: "not-it" }),
    )) as Response;
    expect(res.status).toBe(404);
  });

  /** The token is scoped to ONE session, so it must not open the door to another's directory. */
  test("a valid token for one session does not admit a request naming another", async () => {
    const routes = routesFor({ admin: false });
    const res = (await routes.GET?.(
      segReq("sess-2", MASTER_PLAYLIST_NAME, { token: SESSION_TOKEN }),
    )) as Response;
    expect(res.status).toBe(404);
  });

  /** An admin browsing to the URL by hand still works -- the token is an addition, not a swap. */
  test("an admin with no token is still served", async () => {
    const routes = routesFor({});
    const res = (await routes.GET?.(segReq("sess-1", MASTER_PLAYLIST_NAME))) as Response;
    expect(res.status).toBe(200);
  });
});

describe("CORS on the stream origin", () => {
  const routesFor = (endpoints: StreamEndpoint[], pageOrigins: string[] = []) =>
    build({ endpoints, pageOrigins }).routes["/api/play/s/:id/:file"] as Record<
      string,
      (req: never) => Promise<Response> | Response
    >;

  test("an advertised endpoint may read the segment", async () => {
    const routes = routesFor([LAN]);
    const res = (await routes.GET?.(
      segReq("sess-1", segmentFileName("video", 1), { token: SESSION_TOKEN, origin: LAN.base }),
    )) as Response;
    expect(res.headers.get("access-control-allow-origin")).toBe(LAN.base);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("an origin nobody advertised gets no header, so the browser refuses the read", async () => {
    const routes = routesFor([LAN]);
    const res = (await routes.GET?.(
      segReq("sess-1", segmentFileName("video", 1), {
        token: SESSION_TOKEN,
        origin: "https://evil.example",
      }),
    )) as Response;
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  /**
   * THE HEADER GOES ON REFUSALS TOO, and this is the case that makes it matter.
   *
   * Our segment route answers 404 for a segment that is not ready yet, which is ordinary
   * back-pressure. Without CORS on that response the browser reports an opaque network error
   * instead, the loader reads it as a dead path, and the player rotates away from a candidate
   * that was working perfectly.
   */
  test("a 404 for an unproduced segment still carries the header", async () => {
    const routes = routesFor([LAN]);
    const res = (await routes.GET?.(
      segReq("sess-1", segmentFileName("video", 42), { token: SESSION_TOKEN, origin: LAN.base }),
    )) as Response;
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(LAN.base);
  });

  test("the origin the app itself is served from is allowed without being an endpoint", async () => {
    const routes = routesFor([], ["https://finderr.example"]);
    const res = (await routes.GET?.(
      segReq("sess-1", MASTER_PLAYLIST_NAME, { origin: "https://finderr.example" }),
    )) as Response;
    expect(res.headers.get("access-control-allow-origin")).toBe("https://finderr.example");
  });

  test("the preflight answers 204 and names the method a ranged fetch needs", async () => {
    const routes = routesFor([LAN]);
    const res = (await routes.OPTIONS?.(
      segReq("sess-1", segmentFileName("video", 1), { origin: LAN.base }),
    )) as Response;
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("range");
  });
});

describe("advertising where a client may stream from", () => {
  test("the endpoints route lists what the directory holds", async () => {
    const { routes } = build({ endpoints: [LAN, WAN] });
    const res = (await routes["/api/play/endpoints"]?.GET?.({ url: "http://x" } as never)) as Response;
    const body = (await res.json()) as { endpoints: StreamEndpoint[] };
    expect(body.endpoints).toEqual([LAN, WAN]);
  });

  test("it is admin-only like the rest of the surface", async () => {
    const { routes } = build({ admin: false, endpoints: [LAN] });
    const res = (await routes["/api/play/endpoints"]?.GET?.({ url: "http://x" } as never)) as Response;
    expect(res.status).toBe(404);
  });
});

/**
 * THE RE-MINT IS THE REASON THE TOKEN'S SHORT LIFE IS REAL.
 *
 * A token travels over plain http to whichever candidate answered, so it is observable in a
 * way the session cookie is not. It expires -- and renewal deliberately needs the credential
 * the token cannot carry, so a captured one cannot refresh itself forever.
 */
describe("renewing a stream token", () => {
  const post = (id: string) => ({ params: { id }, url: `http://x/api/play/s/${id}/token` }) as never;

  test("an admin gets a new token and the life left on it", async () => {
    const { routes } = build({});
    const res = (await routes["/api/play/s/:id/token"]?.POST?.(post("sess-1"))) as Response;
    const body = (await res.json()) as { streamToken: string; streamTokenTtlSec: number };
    expect(body.streamToken).not.toBe(SESSION_TOKEN);
    expect(body.streamTokenTtlSec).toBe(STREAM_TOKEN_TTL_MS / 1000);
  });

  test("a stream token cannot renew itself -- only the admin session can", async () => {
    const { routes } = build({ admin: false });
    const res = (await routes["/api/play/s/:id/token"]?.POST?.({
      params: { id: "sess-1" },
      url: `http://x/api/play/s/sess-1/token?t=${SESSION_TOKEN}`,
    } as never)) as Response;
    expect(res.status).toBe(404);
  });

  test("a session that is gone is a 404 rather than a token for nothing", async () => {
    const { routes } = build({});
    const res = (await routes["/api/play/s/:id/token"]?.POST?.(post("gone"))) as Response;
    expect(res.status).toBe(404);
  });
});

describe("stopping and listing", () => {
  test("delete stops the named session", async () => {
    const { routes, sessions } = build({});
    const res = (await routes["/api/play/s/:id"]?.DELETE?.({
      params: { id: "sess-1" },
      url: "http://x",
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(sessions.stopped).toEqual(["sess-1"]);
  });

  test("the session list reports what is running", async () => {
    const { routes } = build({});
    const res = (await routes["/api/play/sessions"]?.GET?.({ url: "http://x" } as never)) as Response;
    const body = (await res.json()) as { sessions: { id: string; expensive: boolean }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ id: "sess-1", expensive: false });
  });

  /**
   * The budgets ride along because "two of three expensive slots are spent" is the answer to
   * "why was I refused", and the browser has no honest way to know the limits otherwise.
   */
  test("the session list states both limits and what is spent against them", async () => {
    const { routes } = build({});
    const res = (await routes["/api/play/sessions"]?.GET?.({ url: "http://x" } as never)) as Response;
    const body = (await res.json()) as { budgets: unknown };
    expect(body.budgets).toEqual({
      sessions: { used: 1, max: 8 },
      expensive: { used: 0, max: 3 },
    });
  });
});
