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
 * > is the classic traversal surface. `SEGMENT_NAME` admits exactly the three shapes ffmpeg
 * > is configured to produce and nothing else -- no `..`, no slash, no dot-file, no
 * > extension we did not write. A pattern that ENUMERATES what is allowed cannot be walked
 * > out of; one that strips what is forbidden is a guessing game with an attacker.
 * >
 * > This is the second such boundary in the playback path and they guard different things:
 * > `media-path.ts` decides which INPUT files may be opened, this decides which OUTPUT files
 * > may be handed out. Neither substitutes for the other.
 */

import { join } from "node:path";
import type { EncoderChoice } from "../lib/encoder";
import { boundedText, clampInt, LIMITS } from "../lib/input-guards";
import { NOT_AN_EPISODE } from "../lib/media-file";
import { type MediaVolume, resolveMediaFile } from "../lib/media-path";
import { probeMedia } from "../lib/media-probe";
import { type ClientCapabilities, CONSERVATIVE_CLIENT, planPlayback } from "../lib/playback-plan";
import type { Store } from "../lib/store";
import { SessionRefused, type TranscodeSessions } from "../lib/transcode-session";

/**
 * The only file names a session directory may hand out.
 *
 * Matches exactly what `ffmpegArgs` configures ffmpeg to write: the playlist, the fMP4
 * init segment, and numbered media segments. Closed by construction.
 */
const SEGMENT_NAME = /^(?:index\.m3u8|init\.mp4|seg\d{5}\.m4s)$/;

/** How far into a title a caller may seek. 24 hours is past any real runtime. */
const MAX_SEEK_SEC = 24 * 60 * 60;

/**
 * How long the start request will wait for ffmpeg to write its first playlist.
 *
 * Measured on an M1 Max over SMB 2026-09-08: a remux plus an audio track produces the
 * manifest in about a second, and a software 4K re-encode takes several. Five seconds
 * covers the cheap case comfortably and gives up on the expensive one rather than holding
 * a connection -- which is correct, because giving up here costs nothing.
 */
const MANIFEST_WAIT_MS = 5_000;
const MANIFEST_POLL_MS = 100;

async function waitForManifest(dir: string): Promise<boolean> {
  const path = join(dir, "index.m3u8");
  const deadline = Date.now() + MANIFEST_WAIT_MS;
  while (Date.now() < deadline) {
    // A FRESH `Bun.file` each pass. Hoisting it out of the loop looks like the tidier
    // version and silently never returns true: the handle caches its answer, so a file that
    // did not exist on the first check never exists on any later one, and the wait always
    // spends its full budget. Measured 2026-09-08 -- a remux that writes its manifest in
    // about a second took the whole five.
    if (await Bun.file(path).exists()) return true;
    await Bun.sleep(MANIFEST_POLL_MS);
  }
  return false;
}

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
  /** Seconds to burst-read before throttling. Probed once at boot; 0 means plain `-re`. */
  readrateBurstSec?: number;
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

export function playbackRoutes(deps: PlaybackDeps): Record<string, unknown> {
  const log = deps.log ?? (() => {});

  /** Serve one file out of a session directory, having touched the session. */
  const serveFromSession = async (id: string, name: string): Promise<Response> => {
    if (!SEGMENT_NAME.test(name)) return bad("no such file", 404);
    const session = deps.sessions.touch(id);
    if (!session) return bad("no such session", 404);

    const file = Bun.file(join(session.dir, name));
    if (!(await file.exists())) {
      // ffmpeg has not written it YET, which is the ordinary state for the first second of
      // a session and for the segment just past the live edge. 404 rather than 5xx: hls.js
      // retries a 404 and gives up on a 500.
      return bad("not ready", 404);
    }
    // Zero-copy: the bytes never enter the JS heap. This is the one route that runs
    // thousands of times per playback and it must stay a stat plus an fd handoff.
    return new Response(file, {
      headers: {
        "content-type": name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/iso.segment",
        // A live playlist must never be cached; a written segment never changes.
        "cache-control": name.endsWith(".m3u8") ? "no-store" : "public, max-age=31536000, immutable",
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
          seekSec?: unknown;
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

        const seekSec = clampInt(b.seekSec, { min: 0, max: MAX_SEEK_SEC }) ?? 0;
        const plan = planPlayback(probe, capabilitiesFrom(body), { wantSubtitles: b.wantSubtitles === true });

        try {
          const session = deps.sessions.start({
            input: resolved.path,
            plan,
            seekSec,
            encoder: deps.encoder,
            readrateBurstSec: deps.readrateBurstSec,
            owner: deps.actorId(req) ?? undefined,
          });

          /*
            WAIT FOR THE MANIFEST BEFORE ANSWERING, and this is not politeness.

            ffmpeg needs a second or two to write `index.m3u8`, so returning the moment the
            process is spawned hands the client a playlist URL that 404s. hls.js does retry
            a 404 -- but its retry budget is spent in well under the time a 4K software
            re-encode needs to produce a first segment, after which it gives up silently and
            the player sits at `readyState 0` with an empty console. Measured in a real
            browser 2026-09-08; it is exactly the failure that looks like nothing happening.

            Bounded, and a timeout is NOT an error: the session is running and the manifest
            will appear, so the client gets its URL either way and hls.js's retries cover the
            remainder. This wait removes the common case, it does not promise anything.
          */
          await waitForManifest(session.dir);

          return json({
            sessionId: session.id,
            // RELATIVE, so a client may retarget it at any endpoint that serves this server
            // -- the property multi-homed playback needs and the reason the playlist itself
            // carries relative segment names too.
            playlist: `/api/play/s/${session.id}/index.m3u8`,
            durationSec: probe.durationSec,
            seekSec,
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
