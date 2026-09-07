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

export interface PlaybackSession {
  sessionId: string;
  playlist: string;
  durationSec: number | null;
  seekSec: number;
  plan: PlaybackPlan;
}

export class PlaybackRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Ask the server to start a session for this title, at this position, for this browser. */
export async function startPlayback(
  tconst: string,
  opts: { season?: number; episode?: number; seekSec?: number; wantSubtitles?: boolean } = {},
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
export function stopPlayback(sessionId: string): void {
  void fetch(`/api/play/s/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {});
}
