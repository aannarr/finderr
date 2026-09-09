/**
 * The playback surface: start a session, read its playlist, read its segments, stop it -- and
 * report what all of that has cost the box.
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
  type PublishedTrack,
  type PublishedTracks,
  parseProducedName,
  SEGMENT_TARGET_SEC,
  segmentContentType,
  segmentCount,
  type Track,
  tracksBlockingFirstFrame,
  tracksOfKind,
  uniformTimeline,
} from "../lib/hls-timeline";
import { boundedText, clampInt, LIMITS } from "../lib/input-guards";
import { type CutPointCache, type CutSource, cutTimeline } from "../lib/keyframes";
import { NOT_AN_EPISODE } from "../lib/media-file";
import { type MediaVolume, resolveMediaFile } from "../lib/media-path";
import { probeMedia } from "../lib/media-probe";
import { playbackDiagnostics } from "../lib/playback-diagnostics";
import {
  type ClientCapabilities,
  CONSERVATIVE_CLIENT,
  type PlaybackPlan,
  planPlayback,
} from "../lib/playback-plan";
import type { Store } from "../lib/store";
import type { StreamEndpoint } from "../lib/stream-endpoints";
import type { TranscodeMeter } from "../lib/transcode-meter";
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
  /**
   * Where what playback COSTS is kept. Required, not optional: this is instrumentation the
   * product has rather than a mode it can be in, and an optional meter is one that silently
   * counts nothing on the deployment nobody remembered to wire.
   */
  meter: TranscodeMeter;
  volumes: readonly MediaVolume[];
  /** Returns a refusal Response, or null when the caller is an admin. */
  requireAdmin: (req: Request) => Response | null;
  /** For attributing a session in the health report. Never used for a decision. */
  actorId: (req: Request) => string | null;
  /** Which encoder a re-encode should use. Probed once at boot. */
  encoder?: EncoderChoice;
  /**
   * Where "this file can be cut here" is remembered between plays.
   *
   * Optional so a test can start a session without a database behind it. Absent means every
   * start re-derives the cut points, which is correct and merely slower.
   */
  keyframes?: CutPointCache;
  /**
   * Every address a client may fetch this session's media from, best first.
   *
   * A FUNCTION rather than a list, because the set grows after boot: a UPnP probe answers
   * seconds later if it answers at all, and an interface scan should reflect the machine as
   * it is now. Absent means the only address is the one the page was loaded from, which is
   * every deployment that has not opted in.
   */
  endpoints?: () => readonly StreamEndpoint[];
  /**
   * Origins the APP itself is served from -- `auth.origins`. Read only to decide CORS.
   *
   * Separate from `endpoints` because they answer different questions: an endpoint is a place
   * media may be FETCHED FROM, and this is a place the page may have been LOADED AT. A
   * deployment behind one proxy has one of the second and several of the first.
   */
  pageOrigins?: readonly string[];
  /** Reads the clock only to REPORT how long a token has left. Injected so a test can pin it. */
  now?: () => number;
  log?: (m: string) => void;
}

/**
 * The query parameter carrying a session's stream token.
 *
 * A QUERY PARAMETER rather than a header, and that is forced rather than chosen: a `<video>`
 * element following a native HLS playlist, and hls.js fetching a segment, both issue plain
 * GETs whose headers we do not get to set per URL. Plex and Jellyfin land in the same place
 * for the same reason.
 */
const TOKEN_PARAM = "t";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (error: string, status = 400) => json({ error }, status);

/**
 * The stream token a request carries, or null.
 *
 * `URL` rather than a hand-rolled scan of the query string: this runs on the segment route,
 * which is the hot one, and it is still far cheaper than the cookie parse and session lookup
 * `requireAdmin` would otherwise do -- so asking here FIRST makes the hot path faster, not
 * slower. Bounded, because it is compared against a secret and an unbounded one would be a
 * request body pretending to be a parameter.
 */
function streamTokenOf(url: string): string | null {
  try {
    const t = new URL(url).searchParams.get(TOKEN_PARAM);
    return t && t.length <= LIMITS.id ? t : null;
  } catch {
    return null;
  }
}

/**
 * The `Origin` a cross-origin fetch declared, or null for a same-origin one.
 *
 * A same-origin request sends no `Origin` on a GET, and it needs no CORS header either -- so
 * null here is the ordinary case rather than a refusal.
 */
function requestOrigin(req: Request): string | null {
  const origin = req.headers?.get?.("origin");
  return origin && origin !== "null" ? origin : null;
}

/**
 * A session's stream token, and how much longer it will actually be accepted.
 *
 * The remaining life rides along rather than being a constant the client also holds. Two
 * reasons, and the second is the one that bites: the player must renew INSIDE the window so
 * it needs the number at all, and **a request that JOINED a running session gets a token that
 * is already partly spent** -- reporting the full TTL there would have the second viewer
 * renew after their token had already expired.
 *
 * A DURATION rather than an expiry instant, deliberately: a browser's clock can be minutes
 * off, and a deadline in absolute time would be read against that clock.
 */
function mintedToken(session: Session, now: number): { streamToken: string; streamTokenTtlSec: number } {
  return {
    streamToken: session.token,
    streamTokenTtlSec: Math.max(0, Math.floor((session.tokenExpiresAt - now) / 1000)),
  };
}

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

/** One produced file: where it is on disk, and which rendition it belongs to. */
interface ProducedFile {
  path: string;
  track: Track;
}

/**
 * The produced file this name asks for, producing it if nobody has yet.
 *
 * Null for a name that is not one of ours, which is the traversal guard: the ordinal and index
 * come out of a closed vocabulary and are then NUMBERS, so nothing a caller writes ever reaches
 * the filesystem as text. The track comes back with the path because it is what decides the
 * content type -- an fMP4 segment and a WebVTT one are not served as the same thing.
 *
 * An init is asked for by RENDITION and a media segment by rendition and index, which is the
 * whole difference between the two branches: there is one init per rendition, named by the
 * single `EXT-X-MAP` at the top of its playlist.
 */
async function producedFile(
  sessions: TranscodeSessions,
  id: string,
  name: string,
): Promise<ProducedFile | null> {
  const asked = parseProducedName(name);
  if (!asked) return null;
  const path = await (asked.file === "segment"
    ? sessions.segmentPath(id, asked.track, asked.index)
    : sessions.initPath(id, asked.track));
  return path === null ? null : { path, track: asked.track };
}

/**
 * Get the first segment of every rendition a first frame needs on its way, before answering
 * the start request.
 *
 * Not politeness: a player asks for the initialisation segment and the first media segment
 * within milliseconds of reading the playlist, and both of those would otherwise arrive
 * while ffmpeg was still starting. **Video AND audio**, because the player fetches them in
 * parallel and it cannot show a frame until it has one of each -- and NOT subtitles, which no
 * player fetches until somebody switches them on. Bounded, and a timeout is NOT an error --
 * the production carries on and the client's own request joins it.
 */
async function warmFirstSegments(sessions: TranscodeSessions, session: Session): Promise<void> {
  const first = tracksBlockingFirstFrame(session.tracks).map((track) =>
    sessions.segmentPath(session.id, track, 0),
  );
  await Promise.race([Promise.all(first), Bun.sleep(FIRST_SEGMENT_WAIT_MS)]);
}

/**
 * Every rendition this title publishes, in offer order: the video grid it is stuck with, and a
 * plain grid for everything else.
 *
 * Audio has no keyframe constraint to honour -- every audio packet is a key packet -- and
 * neither has a subtitle cue, so both are uniform whatever the video is doing. That is
 * exactly what lets an audio segment cover its whole declared range and leave no hole at the
 * boundary. The grids do not have to agree, and making them agree would bring the constraint
 * back. Every audio rendition shares ONE uniform timeline object: they are cut identically,
 * so a copy per rendition would be the same numbers stored several times.
 *
 * > [!IMPORTANT] AN AUDIO-ONLY TITLE PUBLISHES ONE AUDIO RENDITION, whatever it carries
 * > With no video the variant must ITSELF be an audio playlist, and a variant that also joined
 * > an audio group would name the same media twice -- so there is nowhere for an alternate to
 * > hang. Publishing them anyway would put playlists in the session that the master never
 * > names, which is a rendition a player can only reach by guessing. The default is kept and
 * > the rest are dropped; see `masterPlaylist`.
 */
async function publishedTracksFor(
  path: string,
  durationSec: number,
  plan: PlaybackPlan,
  keyframes?: CutPointCache,
): Promise<{ tracks: PublishedTracks; video: VideoGrid | null }> {
  const tracks: PublishedTrack[] = [];
  let video: VideoGrid | null = null;
  if (plan.video) {
    const cut = await cutTimeline(path, durationSec, SEGMENT_TARGET_SEC, {
      copiesVideo: plan.video.action === "copy",
      cache: keyframes,
    });
    tracks.push({
      track: { kind: "video", ordinal: 0 },
      timeline: cut.timeline,
      label: { name: "Video", language: null },
    });
    video = { source: cut.source, cached: cut.cached };
  }
  const uniform = uniformTimeline(durationSec, SEGMENT_TARGET_SEC);
  const audio = plan.video ? plan.audio : plan.audio.slice(0, 1);
  audio.forEach((rendition, ordinal) => {
    tracks.push({ track: { kind: "audio", ordinal }, timeline: uniform, label: rendition.label });
  });
  plan.subtitles.forEach((rendition, ordinal) => {
    tracks.push({ track: { kind: "subtitles", ordinal }, timeline: uniform, label: rendition.label });
  });
  return { tracks, video };
}

/** How the video grid was arrived at, which is the half of the answer worth reporting. */
interface VideoGrid {
  source: CutSource;
  cached: boolean;
}

/**
 * The video grid in one line a reader can act on.
 *
 * It names the cache SEPARATELY from where the cut points came from, deliberately: a cache
 * that answers instantly would otherwise be indistinguishable from a container reader that
 * works, and the two need to be measurable apart to know which one is broken.
 */
function videoGridNote(video: VideoGrid, segments: number): string {
  if (video.source === "uniform")
    return `video segments are a ${SEGMENT_TARGET_SEC}s grid, ${segments} of them`;
  const how = video.source === "container" ? "the container's own index" : "an ffprobe keyframe probe";
  const when = video.cached ? "remembered from an earlier play" : "read just now";
  return `video segments follow ${how} (${when}), ${segments} of them`;
}

/** How many segments the playhead moves through: the video grid, or the audio one alone. */
function publishedSegments(tracks: PublishedTracks): number {
  const timeline = (tracksOfKind(tracks, "video")[0] ?? tracksOfKind(tracks, "audio")[0])?.timeline;
  return timeline ? segmentCount(timeline) : 0;
}

export function playbackRoutes(deps: PlaybackDeps): Record<string, unknown> {
  const log = deps.log ?? (() => {});
  const endpoints = deps.endpoints ?? (() => []);
  const now = deps.now ?? Date.now;

  /**
   * Let a media request through when it carries a live token for the session it names.
   *
   * The token admits ONE session, looked up by the id already in the path, so a token for one
   * playback cannot read another's segments. Whether it is still live -- and whether a token
   * being replaced right now still counts -- is `TranscodeSessions.admitsToken`'s to answer,
   * because that rule needs a clock and the manager already has one.
   */
  const tokenAdmits = (req: Request, id: string): boolean => {
    const offered = streamTokenOf(req.url);
    return offered !== null && deps.sessions.admitsToken(id, offered);
  };

  /**
   * Say who may read this response, when the asker is not the page's own origin.
   *
   * > [!IMPORTANT] THE HEADERS GO ON REFUSALS TOO, and leaving them off breaks failover
   * > A 404 without CORS headers reaches the browser as an opaque network error, which is
   * > indistinguishable from a dead path -- so a segment that is merely not ready yet would
   * > demote a perfectly good candidate and the player would rotate through every address it
   * > has for a reason that was never about the network.
   *
   * The allow-list is the ADVERTISED SET plus the origins the app is served from, so it
   * cannot drift: an address a client was told to use is an address it may fetch from. No
   * `Allow-Credentials`, deliberately -- the token is the credential here, the cookie is not
   * sent cross-origin anyway, and echoing an origin with credentials enabled is the shape of
   * mistake that turns an allow-list typo into a session-theft bug.
   */
  const withCors = (res: Response, req: Request): Response => {
    const origin = requestOrigin(req);
    if (!origin) return res;
    const allowed = endpoints().some((e) => e.base === origin) || (deps.pageOrigins ?? []).includes(origin);
    if (!allowed) return res;
    res.headers.set("access-control-allow-origin", origin);
    // The header depends on the request's own Origin, so a shared cache must key on it --
    // without this, one client's answer is served to another with the wrong permission.
    res.headers.append("vary", "Origin");
    return res;
  };

  /**
   * The playlist this name asks for, or null when it is not a playlist name.
   *
   * Every playlist is GENERATED rather than read off disk, and that is the whole point of the
   * redesign -- they name every segment of the film before any of them exists, so the player
   * offers a full scrub bar. The media, by contrast, is produced on demand: asking for a
   * segment is what causes it to be made.
   */
  const playlistFor = (session: Session, name: string): string | null => {
    if (name === MASTER_PLAYLIST_NAME) return masterPlaylist(session.tracks);
    const published = session.tracks.find((t) => mediaPlaylistName(t.track) === name);
    return published ? mediaPlaylist(published.track, published.timeline) : null;
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

    const produced = await producedFile(deps.sessions, id, name);
    if (!produced) {
      // Either the session is gone, the name is not one we produce, or ffmpeg could not make
      // this segment right now. 404 rather than 5xx: hls.js retries a 404 and gives up on a
      // 500, and every one of those states is one a retry can get out of.
      return bad("not ready", 404);
    }
    // Zero-copy: the bytes never enter the JS heap. This is the one route that runs
    // hundreds of times per playback and it must stay a stat plus an fd handoff.
    const file = Bun.file(produced.path);
    /*
      COUNTED FROM THE DECLARED SIZE, off the handle we are already holding -- never by
      reading the body. Reading it to measure it would undo the exact property the line above
      exists to protect, and it is the one thing that would turn a stat-and-an-fd into
      megabytes through the event loop. `playback-routes.test.ts` asserts the response body is
      still unconsumed after the handler has counted, which is what a body-reading count
      could not be.
    */
    deps.meter.served(id, file.size);
    return new Response(file, {
      headers: {
        // From the rendition rather than from the name: fMP4 segments and WebVTT segments are
        // served through this one route and a browser will not read a caption file handed to
        // it as `video/iso.segment`.
        "content-type": segmentContentType(produced.track),
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

        const { tracks, video } = await publishedTracksFor(
          resolved.path,
          probe.durationSec,
          plan,
          deps.keyframes,
        );
        const segments = publishedSegments(tracks);
        if (video !== null) plan.reasons.push(videoGridNote(video, segments));
        // The audio grid is worth stating too: it is the thing a reader would otherwise assume
        // matches the video grid, and it deliberately does not.
        if (video !== null && tracksOfKind(tracks, "audio").length > 0) {
          plan.reasons.push(`audio is a separate rendition on its own ${SEGMENT_TARGET_SEC}s grid`);
        }

        try {
          const session = deps.sessions.start({
            input: resolved.path,
            plan,
            tracks,
            encoder: deps.encoder,
            owner: deps.actorId(req) ?? undefined,
          });
          /*
            THE METER IS TOLD WHAT IS PLAYING, NOT THE SESSION MANAGER.

            `Session` has no reason to carry a title: it decides which file to cut and how,
            and a tconst changes none of that. The meter is the only thing that needs a name
            for the cost it is attributing, so it holds its own label -- which also lets a
            finished session keep its name after the manager has reaped it. Idempotent,
            because two viewers of one film JOIN one session and both arrive here.
          */
          deps.meter.open(session.id, {
            tconst: tconst.value,
            season: at?.season ?? NOT_AN_EPISODE,
            episode: at?.episode ?? NOT_AN_EPISODE,
          });
          await warmFirstSegments(deps.sessions, session);

          return json({
            sessionId: session.id,
            // RELATIVE, so a client may retarget it at any endpoint that serves this server
            // -- the property multi-homed playback needs and the reason the playlist itself
            // carries relative segment names too.
            playlist: `/api/play/s/${session.id}/${MASTER_PLAYLIST_NAME}`,
            // What lets a segment be fetched from an origin the page was not loaded at, and
            // how long before the player must ask for another -- see the field on `Session`.
            ...mintedToken(session, now()),
            // Handed over with the session rather than fetched separately: the client needs
            // both at the same instant, and `/api/play/endpoints` reads the same function.
            endpoints: endpoints(),
            durationSec: probe.durationSec,
            segments,
            plan,
            // Everything already measured on the way here, kept rather than dropped, for the
            // stats panel. Nothing below is a fresh read -- see `playback-diagnostics.ts`.
            diagnostics: playbackDiagnostics({
              row,
              probe,
              plan,
              segmenting: { source: video?.source ?? null, targetSec: SEGMENT_TARGET_SEC, count: segments },
              encoder: deps.encoder,
            }),
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

    /**
     * Where this session's media may be fetched from, best first.
     *
     * The list is ADVICE rather than routing: nothing here has proved that a given address
     * reaches this process from where the client is standing, and nothing can -- the browser
     * is behind a NAT or a VPN we cannot see. The client settles it by trying, which is why
     * an over-optimistic list is safe and a missing one is not.
     *
     * `POST /api/play/:tconst/session` returns the same list, so the ordinary player makes
     * ONE request rather than two. This route exists for the case the start response cannot
     * serve: looking at what a deployment is advertising without starting a transcode.
     */
    "/api/play/endpoints": {
      GET: (req: Request) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        return json({ endpoints: endpoints() });
      },
    },

    "/api/play/s/:id/:file": {
      /**
       * Admitted by the session's own token, or by an admin session.
       *
       * The token comes FIRST because it is the path a cross-origin fetch actually takes: the
       * cookie is `SameSite=Lax` and a browser will not send it to a candidate the page was
       * not loaded from, so a failover with only the cookie to offer is a 401 storm. The
       * admin fallback keeps a URL pasted into a browser working, which is how every
       * diagnostic session begins.
       */
      GET: async (req: Bun.BunRequest<"/api/play/s/:id/:file">) => {
        if (!tokenAdmits(req, req.params.id)) {
          const refused = deps.requireAdmin(req);
          if (refused) return withCors(refused, req);
        }
        return withCors(await serveFromSession(req.params.id, req.params.file), req);
      },
      /**
       * The preflight, for the requests that get one.
       *
       * A plain segment GET is a simple request and is never preflighted, so this is not on
       * the hot path -- but hls.js issues a ranged request for some playlist shapes, and a
       * `Range` header is exactly what turns a simple request into a preflighted one. A
       * preflight that 404s fails the whole fetch with no useful error.
       */
      OPTIONS: (req: Request) => {
        const res = withCors(new Response(null, { status: 204 }), req);
        if (res.headers.has("access-control-allow-origin")) {
          res.headers.set("access-control-allow-methods", "GET, OPTIONS");
          res.headers.set("access-control-allow-headers", "range");
          res.headers.set("access-control-max-age", "600");
        }
        return res;
      },
    },

    /**
     * Stop a session.
     *
     * Worth having rather than leaving it to the reaper: a viewer who closes the tab frees
     * an expensive slot NOW instead of in a minute, and with a budget of two that minute is
     * the difference between the next person playing and being refused.
     */
    /**
     * Issue a fresh stream token for a running session.
     *
     * > [!IMPORTANT] ADMIN SESSION ONLY -- the token may NOT renew itself
     * > This is what makes `STREAM_TOKEN_TTL_MS` a real bound rather than a formality. A
     * > re-mint reachable with the stream token would let a captured one refresh forever, so
     * > renewal deliberately requires the credential the token cannot carry: the session
     * > cookie, which the browser only sends to the app's own origin -- HTTPS wherever there
     * > is a public name.
     *
     * POST, because it changes server state: the previous token starts its grace window here.
     */
    "/api/play/s/:id/token": {
      POST: (req: Bun.BunRequest<"/api/play/s/:id/token">) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        const session = deps.sessions.remintToken(req.params.id);
        return session === null ? bad("no such session", 404) : json(mintedToken(session, now()));
      },
    },

    "/api/play/s/:id": {
      DELETE: (req: Bun.BunRequest<"/api/play/s/:id">) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        deps.sessions.stop(req.params.id);
        return json({ stopped: true });
      },
    },

    /**
     * What is running, for the admin UI and for `/api/health`.
     *
     * The one thing the stats panel polls, and the reason it carries the BUDGETS as well as
     * the sessions: "two of three expensive slots are spent" is the answer to "why was I
     * refused", and deriving it in the browser would need the two limits copied there.
     */
    "/api/play/sessions": {
      GET: (req: Request) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        return json({
          budgets: deps.sessions.budgets(),
          sessions: deps.sessions.list().map((s) => ({
            id: s.id,
            expensive: s.expensive,
            segments: publishedSegments(s.tracks),
            startedAt: new Date(s.startedAt).toISOString(),
            lastAccessAt: new Date(s.lastAccessAt).toISOString(),
            owner: s.owner,
            plan: s.plan,
          })),
        });
      },
    },

    /**
     * What playback has COST this box: bytes handed out and ffmpeg CPU, over a rolling window
     * and per session.
     *
     * > [!IMPORTANT] UNDER `/api/admin/` rather than `/api/play/`, and the prefix is the point
     * > It is the prefix `agent-api.ts` refuses outright, so this history is out of reach of
     * > every agent key whatever its owner's role -- and `requireAdmin` answers a signed-in
     * > non-admin with a 404, so the endpoint does not announce itself either. The other
     * > playback routes are admin-only too; this one is ADMINISTRATION, which is a stronger
     * > claim and a different denial list.
     *
     * Declared here rather than in `index.ts` for the reason `/api/admin/requests/:tconst/media`
     * states: the module that owns the subsystem owns the route that reports on it.
     *
     * Liveness comes from the SESSION MANAGER on the way past. The meter deliberately does not
     * track it -- whether a session still exists is the manager's fact, and a second copy would
     * be free to disagree with the thing that actually reaps them.
     */
    "/api/admin/playback/cost": {
      GET: (req: Request) => {
        const refused = deps.requireAdmin(req);
        if (refused) return refused;
        const live = new Set(deps.sessions.list().map((s) => s.id));
        return json(deps.meter.report((id) => live.has(id)));
      },
    },
  };
}
