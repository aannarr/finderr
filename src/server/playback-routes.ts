/**
 * The playback surface: start a session, read its playlist, read its segments, stop it.
 *
 * ADMIN ONLY, every route, for as long as this is a prototype. `auth.requireAdmin` is the
 * single owner of that decision and it is asked on every handler rather than once at the
 * top -- the route table is a plain object, so a guard "at the top" would be a comment.
 *
 * > [!IMPORTANT] NOTHING HERE IS ON A RENDER PATH, and the shapes reflect it
 * > Starting a session probes a file and spawns a process, which is exactly the kind of work
 * > the governing rule keeps off a render. It is allowed here because it happens ONLY on an
 * > explicit click, never on a page load, never on a poll, and never on a shelf warm. The
 * > segment reads that follow are the opposite -- a stat and an fd -- and those are the ones
 * > that happen thousands of times.
 *
 * > [!CAUTION] SEGMENT NAMES ARE MATCHED AGAINST A CLOSED PATTERN, never sanitised
 * > A session directory is a real directory and the file name arrives from the wire, so this
 * > is the classic traversal surface. `serveFromSession` admits exactly the names this server
 * > generates and nothing else: the three playlists, and whatever `parseProducedName` accepts
 * > -- which is a closed vocabulary whose index becomes a NUMBER before anything touches the
 * > filesystem. So no caller's text ever becomes a path component -- no `..`, no slash, no
 * > dot-file, no extension we did not write. A pattern that ENUMERATES what is allowed cannot
 * > be walked out of; one that strips what is forbidden is a guessing game with an attacker.
 * >
 * > This is the second such boundary in the playback path and they guard different things:
 * > `media-path.ts` decides which INPUT files may be opened, this decides which OUTPUT files
 * > may be handed out. Neither substitutes for the other.
 */

import type { EncoderChoice } from "../lib/encoder";
import {
  MASTER_PLAYLIST_NAME,
  masterPlaylist,
  mediaPlaylist,
  mediaPlaylistName,
  parseProducedName,
  SEGMENT_TARGET_SEC,
  segmentCount,
  type Timeline,
  TRACKS,
  type Track,
  type TrackTimelines,
  uniformTimeline,
} from "../lib/hls-timeline";
import { boundedText, clampInt, LIMITS } from "../lib/input-guards";
import { type CutSource, cutTimeline } from "../lib/keyframes";
import { NOT_AN_EPISODE } from "../lib/media-file";
import { type MediaVolume, resolveMediaFile } from "../lib/media-path";
import { probeMedia } from "../lib/media-probe";
import {
  type ClientCapabilities,
  CONSERVATIVE_CLIENT,
  type PlaybackPlan,
  planPlayback,
} from "../lib/playback-plan";
import type { Store } from "../lib/store";
import { type Session, SessionRefused, type TranscodeSessions } from "../lib/transcode-session";

/**
 * How long the start request will wait for the first segment before answering anyway.
 *
 * Measured on the NAS over the array 2026-09-08: producing one copy-mode segment takes
 * 0.07-0.08 s, and a software 4K re-encode of one takes seconds. Five seconds covers the
 * cheap case many times over and gives up on the expensive one rather than holding a
 * connection -- which costs nothing, because the client's own request for that segment will
 * join the production already running.
 */
const FIRST_SEGMENT_WAIT_MS = 5_000;

export interface PlaybackDeps {
  store: Store;
  sessions: TranscodeSessions;
  volumes: readonly MediaVolume[];
  /** Returns a refusal Response, or null when the caller is an admin. */
  requireAdmin: (req: Request) => Response | null;
  /** For attributing a session in the health report. Never used for a decision. */
  actorId: (req: Request) => string | null;
  /** Which encoder a re-encode should use. Probed once at boot. */
  encoder?: EncoderChoice;
  log?: (m: string) => void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (error: string, status = 400) => json({ error }, status);

/**
 * Read the client's declared codec support off a request body.
 *
 * A malformed or absent block yields `CONSERVATIVE_CLIENT` rather than a 400: the failure
 * mode of guessing low is a transcode that works, and refusing the request outright would
 * turn a client-side quirk into a title that cannot be played at all.
 */
function capabilitiesFrom(v: unknown): ClientCapabilities {
  const body = v as { capabilities?: { video?: unknown; audio?: unknown } } | null;
  const caps = body?.capabilities;
  if (!caps) return CONSERVATIVE_CLIENT;
  const list = (x: unknown): string[] =>
    Array.isArray(x)
      ? x
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 32)
      : [];
  const video = list(caps.video);
  const audio = list(caps.audio);
  // A client claiming nothing at all in a dimension gets the floor for that dimension, not
  // an empty set -- an empty set would transcode everything including h264, forever.
  return {
    video: video.length > 0 ? video : CONSERVATIVE_CLIENT.video,
    audio: audio.length > 0 ? audio : CONSERVATIVE_CLIENT.audio,
  };
}

/**
 * The path of the produced file this name asks for, producing it if nobody has yet.
 *
 * Null for a name that is not one of ours, which is the traversal guard: the index comes out
 * of a closed vocabulary and is then a NUMBER, so nothing a caller writes ever reaches the
 * filesystem as text.
 */
function producedFile(sessions: TranscodeSessions, id: string, name: string): Promise<string | null> {
  const asked = parseProducedName(name);
  if (!asked) return Promise.resolve(null);
  const of = asked.kind === "segment" ? sessions.segmentPath : sessions.initPath;
  return of.call(sessions, id, asked.track, asked.index);
}

/**
 * Get the first segment of every rendition on its way before answering the start request.
 *
 * Not politeness: a player asks for the initialisation segment and the first media segment
 * within milliseconds of reading the playlist, and both of those would otherwise arrive
 * while ffmpeg was still starting. **Both renditions**, because the player fetches them in
 * parallel and it cannot show a frame until it has one of each. Bounded, and a timeout is NOT
 * an error -- the production carries on and the client's own request joins it.
 */
async function warmFirstSegments(sessions: TranscodeSessions, session: Session): Promise<void> {
  const first = TRACKS.filter((track) => session.timelines[track]).map((track) =>
    sessions.segmentPath(session.id, track, 0),
  );
  await Promise.race([Promise.all(first), Bun.sleep(FIRST_SEGMENT_WAIT_MS)]);
}

/**
 * The timelines a title publishes: the video grid it is stuck with, and a plain audio grid.
 *
 * The audio grid has no keyframe constraint to honour -- every audio packet is a key packet
 * -- so it is uniform whatever the video is doing, which is exactly what lets an audio
 * segment cover its whole declared range and leave no hole at the boundary. The two grids do
 * not have to agree, and making them agree would bring the constraint back.
 */
async function timelinesFor(
  path: string,
  durationSec: number,
  plan: PlaybackPlan,
): Promise<{ timelines: TrackTimelines; videoSource: CutSource | null }> {
  const timelines: { -readonly [K in Track]?: Timeline } = {};
  let videoSource: CutSource | null = null;
  if (plan.video.sourceIndex !== null) {
    const cut = await cutTimeline(path, durationSec, SEGMENT_TARGET_SEC, {
      copiesVideo: plan.video.action === "copy",
    });
    timelines.video = cut.timeline;
    videoSource = cut.source;
  }
  if (plan.audio.sourceIndex !== null) timelines.audio = uniformTimeline(durationSec, SEGMENT_TARGET_SEC);
  return { timelines, videoSource };
}

/** How many segments the playhead moves through: the video grid, or the audio one alone. */
function publishedSegments(timelines: TrackTimelines): number {
  const timeline = timelines.video ?? timelines.audio;
  return timeline ? segmentCount(timeline) : 0;
}

export function playbackRoutes(deps: PlaybackDeps): Record<string, unknown> {
  const log = deps.log ?? (() => {});

  /**
   * The playlist this name asks for, or null when it is not a playlist name.
   *
   * Every playlist is GENERATED rather than read off disk, and that is the whole point of the
   * redesign -- they name every segment of the film before any of them exists, so the player
   * offers a full scrub bar. The media, by contrast, is produced on demand: asking for a
   * segment is what causes it to be made.
   */
  const playlistFor = (session: Session, name: string): string | null => {
    if (name === MASTER_PLAYLIST_NAME) return masterPlaylist(session.timelines);
    for (const track of TRACKS) {
      const timeline = session.timelines[track];
      if (timeline && name === mediaPlaylistName(track)) return mediaPlaylist(track, timeline);
    }
    return null;
  };

  /** Serve one file of a session: a playlist, an init segment, or one media segment. */
  const serveFromSession = async (id: string, name: string): Promise<Response> => {
    const session = deps.sessions.touch(id);
    const playlist = session ? playlistFor(session, name) : null;
    if (playlist !== null) {
      return new Response(playlist, {
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          // The timeline is fixed for the life of the session, but the session is not: a
          // reaped one must not be served from a cache after its segments are gone.
          "cache-control": "no-store",
        },
      });
    }

    const path = await producedFile(deps.sessions, id, name);
    if (!path) {
      // Either the session is gone, the name is not one we produce, or ffmpeg could not make
      // this segment right now. 404 rather than 5xx: hls.js retries a 404 and gives up on a
      // 500, and every one of those states is one a retry can get out of.
      return bad("not ready", 404);
    }
    // Zero-copy: the bytes never enter the JS heap. This is the one route that runs
    // hundreds of times per playback and it must stay a stat plus an fd handoff.
    return new Response(Bun.file(path), {
      headers: {
        "content-type": "video/iso.segment",
        // A produced segment is byte-identical whenever it is produced, and the URL names
        // both the session and the exact range, so it can be cached hard.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  };

  return {
    /**
     * Plan and start a playback session.
     *
     * POST only. A GET here would spawn a process on a cross-site navigation riding the
     * `SameSite=Lax` cookie -- the same argument `/api/requests/:tconst/retry` makes, and
     * this one spawns ffmpeg rather than enqueueing arr work.
     */
    "/api/play/:tconst/session": {
      POST: async (req: Bun.BunRequest<"/api/play/:tconst/session">) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;

        const tconst = boundedText(req.params.tconst, LIMITS.id);
        if (!tconst.ok) return bad("bad title id");

        let body: unknown = null;
        try {
          body = await req.json();
        } catch {
          // No body is fine -- it means "conservative client, from the start".
        }
        const b = (body ?? {}) as {
          season?: unknown;
          episode?: unknown;
          wantSubtitles?: unknown;
        };

        // A request naming EITHER a season or an episode is asking for an episode, and a
        // half-named one falls back to the sentinel rather than to 0 -- season 0 is the
        // specials and is a real season, so defaulting there would silently serve the wrong
        // file rather than none.
        const hasEpisode = b.season !== undefined || b.episode !== undefined;
        const at = hasEpisode
          ? {
              season: clampInt(b.season, { min: 0, max: 9999 }) ?? NOT_AN_EPISODE,
              episode: clampInt(b.episode, { min: 0, max: 99999 }) ?? NOT_AN_EPISODE,
            }
          : undefined;

        const row = deps.store.mediaFile(tconst.value, at);
        if (!row) return bad("nothing playable is mirrored for this", 404);

        const resolved = await resolveMediaFile(row.path, deps.volumes);
        if (!resolved.ok) {
          // The REASON stays in the log. It names a path and a mount layout, which is
          // exactly the shape of fact the no-upstream-URL rule keeps out of a response.
          log(`playback: refused ${tconst.value} (${resolved.reason})`);
          return bad("this file cannot be opened", 409);
        }

        let probe: Awaited<ReturnType<typeof probeMedia>>;
        try {
          probe = await probeMedia(resolved.path);
        } catch (err) {
          log(`playback: probe failed for ${tconst.value}: ${(err as Error).message}`);
          return bad("this file could not be read", 409);
        }

        const plan = planPlayback(probe, capabilitiesFrom(body), { wantSubtitles: b.wantSubtitles === true });

        /*
          THE TIMELINE IS THE FEATURE, and it cannot be built without a runtime.

          Every segment boundary is stated up front so the player offers a full scrub bar,
          and the last boundary is the end of the film. A container that will not say how
          long it is leaves nothing to state, so this refuses rather than serving a timeline
          that is a guess -- a playlist which is wrong about the runtime sends every seek to
          the wrong place. ffprobe reports a duration for every real file in this library.
        */
        if (probe.durationSec === null) {
          log(`playback: refused ${tconst.value} (container states no duration)`);
          return bad("this file does not say how long it is", 409);
        }

        const { timelines, videoSource } = await timelinesFor(resolved.path, probe.durationSec, plan);
        const segments = publishedSegments(timelines);
        if (videoSource !== null) {
          plan.reasons.push(
            videoSource === "keyframes"
              ? `video segments follow the source keyframes, ${segments} of them`
              : `video segments are a ${SEGMENT_TARGET_SEC}s grid, ${segments} of them`,
          );
        }
        // The audio grid is worth stating too: it is the thing a reader would otherwise assume
        // matches the video grid, and it deliberately does not.
        if (timelines.audio && timelines.video) {
          plan.reasons.push(`audio is a separate rendition on its own ${SEGMENT_TARGET_SEC}s grid`);
        }

        try {
          const session = deps.sessions.start({
            input: resolved.path,
            plan,
            timelines,
            encoder: deps.encoder,
            owner: deps.actorId(req) ?? undefined,
          });
          await warmFirstSegments(deps.sessions, session);

          return json({
            sessionId: session.id,
            // RELATIVE, so a client may retarget it at any endpoint that serves this server
            // -- the property multi-homed playback needs and the reason the playlist itself
            // carries relative segment names too.
            playlist: `/api/play/s/${session.id}/${MASTER_PLAYLIST_NAME}`,
            durationSec: probe.durationSec,
            segments,
            plan,
          });
        } catch (err) {
          if (err instanceof SessionRefused) {
            // 503 rather than 429: this is the server being full, not this caller being
            // rude, and the two want different client behaviour.
            return json({ error: "the server is transcoding as much as it can", reason: err.reason }, 503);
          }
          throw err;
        }
      },
    },

    "/api/play/s/:id/:file": {
      GET: async (req: Bun.BunRequest<"/api/play/s/:id/:file">) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        return serveFromSession(req.params.id, req.params.file);
      },
    },

    /**
     * Stop a session.
     *
     * Worth having rather than leaving it to the reaper: a viewer who closes the tab frees
     * an expensive slot NOW instead of in a minute, and with a budget of two that minute is
     * the difference between the next person playing and being refused.
     */
    "/api/play/s/:id": {
      DELETE: (req: Bun.BunRequest<"/api/play/s/:id">) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        deps.sessions.stop(req.params.id);
        return json({ stopped: true });
      },
    },

    /** What is running, for the admin UI and for `/api/health`. */
    "/api/play/sessions": {
      GET: (req: Request) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        return json({
          sessions: deps.sessions.list().map((s) => ({
            id: s.id,
            expensive: s.expensive,
            segments: publishedSegments(s.timelines),
            startedAt: new Date(s.startedAt).toISOString(),
            lastAccessAt: new Date(s.lastAccessAt).toISOString(),
            owner: s.owner,
            plan: s.plan,
          })),
        });
      },
    },
  };
}
