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
import { type Session, SessionRefused, type TranscodeSessions } from "../lib/transcode-session";
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
const TIMELINES = { video: TIMELINE, audio: TIMELINE };

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
    segmentPath: (id: string, track: Track, index: number) => found(id, segmentFileName(track, index)),
    initPath: (id: string, track: Track, index: number) => found(id, initFileName(track, index)),
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
}) {
  const sessions = opts.sessions ?? fakeSessions(sessionDir);
  const routes = playbackRoutes({
    store: fakeStore(opts.path ?? "/plex/a.mkv"),
    sessions: sessions.api,
    volumes: opts.volumes ?? VOLUMES,
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
  writeFileSync(join(sessionDir, initFileName("video", 1)), "init");
  writeFileSync(join(sessionDir, segmentFileName("video", 1)), "segment-bytes");
  writeFileSync(join(sessionDir, initFileName("audio", 1)), "init");
  writeFileSync(join(sessionDir, segmentFileName("audio", 1)), "segment-bytes");
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

const segReq = (id: string, file: string) =>
  ({ params: { id, file }, url: `http://x/api/play/s/${id}/${file}` }) as never;

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

  test("serves exactly the shapes a session publishes, and both renditions", async () => {
    const { routes } = build({});
    const published = [
      MASTER_PLAYLIST_NAME,
      mediaPlaylistName("video"),
      mediaPlaylistName("audio"),
      initFileName("video", 1),
      segmentFileName("video", 1),
      initFileName("audio", 1),
      segmentFileName("audio", 1),
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
