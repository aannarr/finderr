/**
 * The client half of playback: what this browser can decode, and starting a session.
 *
 * > [!IMPORTANT] THE CAPABILITY LIST IS MEASURED IN THE BROWSER, NEVER GUESSED ON THE SERVER
 * > `MediaSource.isTypeSupported` is the only thing that actually knows. HEVC in Chrome
 * > depends on the machine's hardware decoder rather than on the version, so a user-agent
 * > sniff would be a guess about somebody else's GPU -- wrong in both directions, and the
 * > expensive direction produces a black rectangle rather than an error.
 * >
 * > The server's job is to believe this list. Ours is to be honest in it: a codec we are
 * > not sure about is left OUT, because the cost of omitting one is a transcode that works
 * > and the cost of claiming one falsely is a player that spins.
 */

import type { PlaybackPlan } from "./playback-types";
import { EndpointRing, electEndpoint, type StreamEndpoint, streamUrl } from "./stream-endpoints";
import { realTimers, type Timers } from "./timers";

/**
 * The codecs worth asking about, and the MIME string that asks.
 *
 * fMP4 for every probe, because fMP4 is what the server packages -- asking whether the
 * browser can play HEVC in some other container would answer a question nobody is going to
 * act on. The codec strings are the RFC 6381 forms browsers actually match on: `avc1.42E01E`
 * is baseline h264, `hvc1.1.6.L93.B0` is main-profile HEVC, and Safari matches `hvc1` where
 * some builds only match `hev1`, so both are tried.
 */
const VIDEO_PROBES: { codec: string; mimes: string[] }[] = [
  { codec: "h264", mimes: ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.4D401F"'] },
  { codec: "hevc", mimes: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'] },
  { codec: "av1", mimes: ['video/mp4; codecs="av01.0.05M.08"'] },
  { codec: "vp9", mimes: ['video/mp4; codecs="vp09.00.10.08"'] },
];

const AUDIO_PROBES: { codec: string; mimes: string[] }[] = [
  { codec: "aac", mimes: ['audio/mp4; codecs="mp4a.40.2"'] },
  { codec: "ac3", mimes: ['audio/mp4; codecs="ac-3"'] },
  { codec: "eac3", mimes: ['audio/mp4; codecs="ec-3"'] },
  { codec: "opus", mimes: ['audio/mp4; codecs="opus"'] },
  { codec: "flac", mimes: ['audio/mp4; codecs="flac"'] },
];

export interface ClientCapabilities {
  video: string[];
  audio: string[];
}

/**
 * What this browser can actually decode.
 *
 * Asks `MediaSource` first and falls back to `<video>.canPlayType`, because Safari on iOS
 * historically exposed no `MediaSource` at all while playing HLS natively perfectly well --
 * reporting nothing there would force a full transcode of every title on exactly the
 * platform that needs it least.
 *
 * A browser with neither returns empty lists, and the server reads that as "tell me
 * nothing" and applies its conservative floor. That is the correct failure: it costs CPU
 * and it works.
 */
export function detectCapabilities(): ClientCapabilities {
  const ms = (globalThis as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource;
  const probe = (mime: string): boolean => {
    if (ms?.isTypeSupported?.(mime)) return true;
    try {
      const el = document.createElement("video");
      // `canPlayType` answers "", "maybe" or "probably". "maybe" is genuinely uncertain, so
      // it is NOT counted -- see the honesty note in this module's header.
      return el.canPlayType(mime) === "probably";
    } catch {
      return false;
    }
  };
  const supported = (probes: { codec: string; mimes: string[] }[]) =>
    probes.filter((p) => p.mimes.some(probe)).map((p) => p.codec);

  return { video: supported(VIDEO_PROBES), audio: supported(AUDIO_PROBES) };
}

/**
 * Whether the element itself will attempt HLS. **A FALLBACK TEST, never a preference.**
 *
 * > [!CAUTION] THIS QUESTION CANNOT DECIDE WHICH PLAYER TO USE, AND USING IT THAT WAY IS A BUG
 * > `canPlayType("application/vnd.apple.mpegurl")` answers `"maybe"` in BOTH Chromium, which
 * > cannot play HLS at all, and iOS Safari, where it is the only thing that can. So a
 * > truthy test claims support Chromium does not have -- setting `src` there loads nothing,
 * > issues no request, and leaves `video.error.code === 4` with an empty console -- and a
 * > `"probably"` test would refuse the one platform that needs this path.
 * >
 * > `PlayHere` therefore asks `Hls.isSupported()` FIRST (real MSE support: every desktop
 * > browser has it, iOS does not) and only reaches for this when the answer is no. Measured
 * > in headless Chromium 2026-09-08, after the component passed every unit test.
 */
export function hasNativeHls(): boolean {
  try {
    return document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
  } catch {
    return false;
  }
}

/**
 * What the server knows about this playback that will not change while it runs.
 *
 * A structural copy of `src/lib/playback-diagnostics.ts`, for the same reason
 * `playback-types.ts` copies the plan: importing the real one would pull a server module into
 * this bundle. Nothing here is computed on this side -- it is displayed -- so a field this
 * copy has not heard of is simply not drawn.
 */
export interface PlaybackDiagnostics {
  source: {
    container: string | null;
    resolution: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    audioChannels: number | null;
    bitDepth: number | null;
    dynamicRange: string | null;
    durationSec: number | null;
    sizeBytes: number | null;
  };
  segmenting: {
    /**
     * Where the cut points came from: the file's own index, an ffprobe keyframe probe, or
     * neither -- `uniform` means nothing usable was found and the cut is a plain grid.
     */
    source: "container" | "probe" | "uniform" | null;
    targetSec: number;
    count: number;
  };
  encoder: { name: string; hardware: boolean; reason: string } | null;
}

export interface PlaybackSession {
  sessionId: string;
  playlist: string;
  /**
   * The bearer secret for this session's playlists and segments.
   *
   * Optional because a server older than this field does not send one, and a player that
   * asserted it would refuse to play against one. Absent means "same origin only", which is
   * exactly what playback did before multi-homing existed.
   */
  streamToken?: string;
  /**
   * Seconds until `streamToken` stops being accepted. The player renews well inside it.
   *
   * **May be ZERO, and that is not an error state**: starting a session JOINS a running one for
   * the same title, so a second viewer is handed a token that is already partly or wholly
   * spent. `renewStreamToken` reads a zero as "renew now" for exactly this reason.
   */
  streamTokenTtlSec?: number;
  /** Where else this session's media can be fetched from, best first. Absent means nowhere else. */
  endpoints?: StreamEndpoint[];
  durationSec: number | null;
  /** How many segments the playlist names. The whole film, not what has been produced. */
  segments: number;
  plan: PlaybackPlan;
  /**
   * Absent from a server older than this field, which is why every reader treats it as
   * optional rather than asserting it: a stats panel that crashed the player on a version
   * skew would be a diagnostic that caused an outage.
   */
  diagnostics?: PlaybackDiagnostics;
}

/** How much of one session limit is spent. */
export interface Budget {
  used: number;
  max: number;
}

/** One session as the server lists it. */
export interface RunningSession {
  id: string;
  expensive: boolean;
  segments: number;
  startedAt: string;
  lastAccessAt: string;
  owner: string | null;
  plan: PlaybackPlan;
}

export interface SessionsReport {
  sessions: RunningSession[];
  budgets: { sessions: Budget; expensive: Budget };
}

export class PlaybackRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Ask the server to start a session for this title, for this browser.
 *
 * There is no start POSITION any more and that absence is the feature: the session covers
 * the whole film, the playlist names every segment of it, and seeking is something the
 * player does by asking for a different segment. A start offset used to be part of the
 * session's identity because a session WAS a position.
 *
 * `wantSubtitles` asks the server to PUBLISH a WebVTT rendition when the file carries a text
 * subtitle track. It never switches subtitles on and it can never make the video expensive:
 * a bitmap-only title is declined in words rather than burned into the picture.
 */
export async function startPlayback(
  tconst: string,
  opts: { season?: number; episode?: number; wantSubtitles?: boolean } = {},
): Promise<PlaybackSession> {
  const res = await fetch(`/api/play/${encodeURIComponent(tconst)}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...opts, capabilities: detectCapabilities() }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PlaybackRefused(body.error ?? `playback failed: ${res.status}`, res.status);
  }
  return (await res.json()) as PlaybackSession;
}

/**
 * Stop a session.
 *
 * `keepalive` because the common caller is a `beforeunload` or an unmount, and a normal
 * fetch is cancelled when the page goes -- which would leave an expensive slot held until
 * the idle reaper notices, and with a budget of two that minute is somebody else's playback.
 */
/**
 * Whether a parsed body really is a session report.
 *
 * > [!CAUTION] A CAST IS NOT A CHECK, and here that difference crashed the player
 * > This used to be `as SessionsReport` on whatever came back with a 200. A body of some other
 * > shape -- a proxy's courtesy page, a rolled-back server, a redirect that landed on JSON --
 * > then reached the panel as a report with no `sessions` array, and the first `.find` on it
 * > threw INSIDE the player's tree, taking the video down with the diagnostic. A panel that can
 * > break playback is worse than no panel.
 *
 * Structural and shallow on purpose: it asks only what the panel will actually dereference.
 */
function isSessionsReport(body: unknown): body is SessionsReport {
  const report = body as SessionsReport | null;
  const budget = (b: Budget | undefined) => typeof b?.used === "number" && typeof b?.max === "number";
  return (
    !!report &&
    Array.isArray(report.sessions) &&
    budget(report.budgets?.sessions) &&
    budget(report.budgets?.expensive)
  );
}

/**
 * What is running on the server, and how much of each limit that spends.
 *
 * **The ONLY thing the stats panel polls**, which is the budget the card set: everything else
 * it draws is either fixed for the session or already in the browser. Null on any failure --
 * a refusal, an unreachable server, a body that is not a report -- and the panel draws the
 * server half as unknown rather than disappearing or throwing.
 */
export async function fetchSessions(): Promise<SessionsReport | null> {
  try {
    const res = await fetch("/api/play/sessions");
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isSessionsReport(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Pick the address this browser will stream from, and hand back the ring that owns the choice.
 *
 * Every candidate is probed with the session's own master playlist, so what is measured is
 * the request the player is about to make -- DNS, TCP, TLS, CORS and the token, over the
 * exact path -- rather than a reachability check that could pass while playback fails.
 *
 * **Falls back to the page's own origin on every failure**, which is not a degraded mode: it
 * is what playback did before this existed, and the page origin is by definition reachable
 * because the page came from it. So a server with no endpoints configured, a race in which
 * nothing answers, and a browser that refuses every cross-origin fetch all land in the same
 * working place.
 */
export async function electStreamEndpoint(
  session: PlaybackSession,
  pageOrigin: string,
): Promise<EndpointRing> {
  const token = session.streamToken ?? null;
  const bases = (session.endpoints ?? []).map((e) => e.base).filter((base) => base !== pageOrigin);
  const ring = new EndpointRing([...bases, pageOrigin], token);
  if (bases.length === 0) return ring;

  const winner = await electEndpoint(ring.candidates(), (base, signal) =>
    probeEndpoint(base, session.playlist, token, signal),
  );
  if (winner) ring.pin(winner);
  return ring;
}

/**
 * The shortest life this will ever schedule against, in seconds.
 *
 * Only reached when the server has stopped answering renewals: the estimate halves on every
 * attempt that tells us nothing, and without a floor it would converge on a tight loop against
 * a session that is simply gone. Half of this is the retry interval, so a dead renewal
 * endpoint is asked once every thirty seconds rather than thousands of times a second.
 */
const MIN_ASSUMED_TTL_SEC = 60;

/**
 * Keep a ring's token live for as long as playback runs, and hand back the cancel.
 *
 * **Renews at HALF the token's remaining life**, so one failed renewal is survivable rather
 * than an interruption -- and the renewal goes to the app's own origin, which is the only
 * place allowed to mint one. A failure is deliberately silent: the current token is usually
 * still valid for the rest of its window, and there is another attempt before it lapses.
 *
 * > [!IMPORTANT] THE CADENCE FOLLOWS THE SERVER, WHICH IS WHY THIS IS A CHAIN OF TIMEOUTS
 * > `TranscodeSessions.start` JOINS an existing session for the same key, so a second viewer
 * > receives that session's CURRENT token with only its REMAINING life -- possibly none of it.
 * > An interval computed once from the start response therefore got both edges wrong: a
 * > viewer joining at minute 14 of somebody else's cycle renewed every 30 seconds for the rest
 * > of the film, and a viewer joining after the window had lapsed scheduled nothing at all and
 * > played on an expired token. Only the ring's cross-origin requests carry that token, and a
 * > 401 is deliberately not `pathIsDead`, so the failure was hls.js exhausting its retries
 * > against an endpoint that was working perfectly.
 * >
 * > Each renewal is therefore scheduled from the life the PREVIOUS response reported, and
 * > `POST /api/play/s/:id/token` reports one on every call.
 *
 * A TTL of zero means "already spent" and renews NOW. A session with no TTL FIELD at all is a
 * different thing -- a server older than this feature, which has no renewal endpoint to call
 * either -- and schedules nothing, which is why the caller can wire this unconditionally.
 */
export function renewStreamToken(
  session: PlaybackSession,
  ring: EndpointRing,
  timers: Timers = realTimers,
): () => void {
  const initialTtlSec = session.streamTokenTtlSec;
  if (!session.streamToken || initialTtlSec === undefined) return () => {};

  let handle: unknown = null;
  let cancelled = false;

  const schedule = (ttlSec: number) => {
    handle = timers.set(() => {
      handle = null;
      void (async () => {
        const minted = await remintStreamToken(session.sessionId);
        // The player may have gone while the request was in flight; a token set on a ring
        // nobody reads is harmless, but re-arming the chain would leak a timer per session.
        if (cancelled) return;
        if (minted) ring.setToken(minted.streamToken);
        schedule(minted?.streamTokenTtlSec ?? assumedRemainingSec(ttlSec));
      })();
    }, renewalDelayMs(ttlSec));
  };

  schedule(initialTtlSec);
  return () => {
    cancelled = true;
    if (handle !== null) timers.clear(handle);
  };
}

/** When to renew a token with `ttlSec` of life left: halfway through it, or now if it has none. */
function renewalDelayMs(ttlSec: number): number {
  return Math.max(0, (ttlSec * 1000) / 2);
}

/**
 * What to assume is left after an attempt that reported nothing -- a refused re-mint, or one
 * answered by a server that sends no TTL.
 *
 * Half of what was believed before, because half of it is exactly what was just waited out.
 * That decays the retry interval towards `MIN_ASSUMED_TTL_SEC` instead of holding a stale
 * fifteen-minute cadence while the token expires underneath it.
 */
function assumedRemainingSec(ttlSec: number): number {
  return Math.max(MIN_ASSUMED_TTL_SEC, ttlSec / 2);
}

/** A freshly minted stream token and its life, exactly as the server states them. */
interface MintedToken {
  streamToken: string;
  /** Absent only from a server that does not report one; see `assumedRemainingSec`. */
  streamTokenTtlSec?: number;
}

/**
 * Ask the app for a fresh stream token. Null on any failure -- the caller keeps the old one.
 *
 * The TTL rides back with it because the renewal cadence is re-derived from every response;
 * a reply with a token but no TTL is honoured for the token and left to the caller's decay.
 */
async function remintStreamToken(sessionId: string): Promise<MintedToken | null> {
  try {
    const res = await fetch(`/api/play/s/${encodeURIComponent(sessionId)}/token`, { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { streamToken?: unknown; streamTokenTtlSec?: unknown };
    if (typeof body.streamToken !== "string") return null;
    return {
      streamToken: body.streamToken,
      streamTokenTtlSec: typeof body.streamTokenTtlSec === "number" ? body.streamTokenTtlSec : undefined,
    };
  } catch {
    return null;
  }
}

/** Whether this address will serve this session's master playlist right now. */
async function probeEndpoint(
  base: string,
  playlist: string,
  token: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(streamUrl(base, playlist, token), { signal, cache: "no-store" });
    // The body is read and discarded so the connection is not left half-consumed, which on
    // an HTTP/1.1 keep-alive would make the winner's very first real request open a second
    // connection it did not need.
    await res.text().catch(() => "");
    return res.ok;
  } catch {
    return false;
  }
}

export function stopPlayback(sessionId: string): void {
  void fetch(`/api/play/s/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {});
}
