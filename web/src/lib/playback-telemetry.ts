/**
 * What the BROWSER knows about a playback in progress, which is the half no log on the server
 * can answer.
 *
 * > [!IMPORTANT] THIS IS THE HALF THAT WOULD HAVE FOUND THE BUGS
 * > Four of this subsystem's four historical failures were invisible server-side: ffmpeg was
 * > fine, the session was alive, and the picture was black. `readyState 0` with an empty
 * > console, a session stopped a millisecond after it started, a manifest that 404'd. Three of
 * > the four are named in seconds by the three fields at the top of `BrowserStats`.
 *
 * **It knows nothing about hls.js and imports none of it.** The player extracts the four
 * numbers it wants out of an hls.js event and hands them over as plain data, so this module is
 * pure, testable with an object literal, and unaffected the day that library renames a field.
 * The alternative -- a telemetry module that takes an `Hls` -- would need the ~200 KB chunk
 * loaded before it could be tested at all.
 */

/** One segment fetch, as the player observed it. */
export interface FragmentLoad {
  /**
   * Which segment of the timeline. Null for an initialisation segment, which has no place on
   * it -- and the distinction matters, because "still fetching init" and "fetching segment 0"
   * are different stages of the same stall.
   */
  index: number | null;
  /** `main` or `audio`: which rendition this fetch was for. */
  track: string | null;
  loadMs: number;
  bytes: number;
}

/**
 * The bits of a `<video>` element this reads, and nothing else.
 *
 * A structural type rather than `HTMLVideoElement` so a test can hand over a literal: an
 * element is assignable to it, and nothing here needs a DOM to prove.
 */
export interface PlayheadSource {
  readyState: number;
  currentTime: number;
  buffered: { length: number; start(index: number): number; end(index: number): number };
  /** Absent outside a browser, and on a few of them. Null rather than zero when it is. */
  getVideoPlaybackQuality?: () => { droppedVideoFrames: number; totalVideoFrames: number };
  /** The element's own failure, which is the ONLY signal on the native-HLS path. */
  error?: { code: number } | null;
}

export interface BrowserStats {
  /** 0-4. `readyStateLabel` turns it into the words. */
  readyState: number;
  /** Seconds of media buffered ahead of the playhead -- the number that explains a stall. */
  bufferedAheadSec: number;
  positionSec: number;
  droppedFrames: number | null;
  totalFrames: number | null;
  /** hls.js's own throughput estimate, bits per second. Null on the native path. */
  bandwidthBps: number | null;
  lastFragment: FragmentLoad | null;
  /** The most recent failure, in the words the player used. Null while nothing has failed. */
  lastError: string | null;
  /**
   * The last thing the page's Content-Security-Policy refused while the player was mounted.
   *
   * Optional because every existing reader builds this type from a literal, and absent means
   * "nothing was refused" exactly as null does.
   */
  policyViolation?: PolicyViolation | null;
}

/**
 * A CSP refusal, reduced to what is safe to show and paste.
 *
 * > [!IMPORTANT] THIS IS THE ONE FAILURE NEITHER hls.js NOR THE ELEMENT CAN REPORT
 * > When the CSP refused hls.js's `blob:` MediaSource, hls.js raised no ERROR event and the
 * > element reported `code 4` and nothing else. The real cause was only in Safari's console, and
 * > it cost a wrong diagnosis and a deploy. The browser DOES fire `securitypolicyviolation` on
 * > the document, so the player listens for it.
 */
export interface PolicyViolation {
  /** `media-src`, `worker-src`, ... -- the directive that refused. */
  directive: string;
  /**
   * What was refused, as an ORIGIN or a scheme keyword and never a full URL: the URLs the player
   * requests carry `?t=<stream token>`, and this lands in a report somebody pastes into a chat.
   */
  blocked: string;
}

/**
 * A refused URI as something safe to print.
 *
 * `blob:https://host/uuid` becomes `blob:`, an http(s) URL becomes its origin, and the CSP
 * keywords the browser reports instead of a URL (`inline`, `eval`, `data`) pass through. Anything
 * unparseable is reported as `unknown` rather than echoed -- an unparseable string is exactly the
 * one that might still carry a token.
 */
export function redactBlockedUri(uri: string): string {
  const trimmed = uri.trim();
  if (/^(inline|eval|wasm-eval|data|blob|trusted-types-sink|self)$/i.test(trimmed))
    return trimmed.toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    return url.protocol;
  } catch {
    return "unknown";
  }
}

/** The fields of a `SecurityPolicyViolationEvent` this reads. Structural, so a test fakes it. */
interface ViolationEventLike {
  violatedDirective?: string;
  effectiveDirective?: string;
  blockedURI?: string;
}

/**
 * Record every CSP refusal on `target` into `telemetry` until the returned function is called.
 *
 * A function rather than an effect body so the wiring is testable with a plain `EventTarget` and
 * a synthetic event -- happy-dom has no `SecurityPolicyViolationEvent` to construct.
 */
export function watchPolicyViolations(target: EventTarget, telemetry: PlaybackTelemetry): () => void {
  const onViolation = (event: Event) => {
    const e = event as Event & ViolationEventLike;
    telemetry.policyViolated({
      directive: e.effectiveDirective || e.violatedDirective || "unknown",
      blocked: redactBlockedUri(e.blockedURI ?? ""),
    });
  };
  target.addEventListener("securitypolicyviolation", onViolation);
  return () => target.removeEventListener("securitypolicyviolation", onViolation);
}

/**
 * `readyState` in words.
 *
 * The number alone is the least readable diagnostic in the browser and the most useful: `0`
 * with a running session is the empty-console failure this panel exists to name.
 */
const READY_STATES = [
  "0 - nothing",
  "1 - metadata",
  "2 - current frame",
  "3 - a little ahead",
  "4 - enough to finish",
] as const;

export function readyStateLabel(state: number): string {
  return READY_STATES[state] ?? `${state} - unknown`;
}

/**
 * Seconds of continuous media ahead of the playhead.
 *
 * Zero when no buffered range CONTAINS the playhead, which is not the same as "nothing is
 * buffered" and is exactly the stall worth seeing: a player sitting at a hole has ranges on
 * both sides of a position it cannot advance through.
 */
function bufferedAhead(video: PlayheadSource): number {
  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);
    if (start <= video.currentTime && video.currentTime <= end) return end - video.currentTime;
  }
  return 0;
}

/**
 * What the player has seen, kept between renders.
 *
 * Mutable and deliberately not React state: an hls.js fragment event fires several times a
 * second per rendition, and putting each one through `setState` would re-render the player
 * itself rather than the panel that is sampling it. The panel reads on its own timer instead,
 * so the cost of the whole diagnostic is one read per tick and it is zero while it is closed.
 */
export class PlaybackTelemetry {
  private fragment: FragmentLoad | null = null;
  private error: string | null = null;
  private violation: PolicyViolation | null = null;

  /** Record a CSP refusal. Already redacted by `watchPolicyViolations`; the last one wins. */
  policyViolated(violation: PolicyViolation): void {
    this.violation = violation;
  }

  fragmentLoaded(load: FragmentLoad): void {
    this.fragment = load;
  }

  /** Record a failure the player reported. The LAST one wins; this is a diagnostic, not a log. */
  failed(detail: string): void {
    this.error = detail;
  }

  /**
   * Everything the browser can say right now.
   *
   * `bandwidthBps` is passed in rather than read off an hls instance for the reason in this
   * module's header: keeping hls.js on the other side of the seam is what makes this testable.
   */
  read(video: PlayheadSource, bandwidthBps: number | null): BrowserStats {
    const quality = video.getVideoPlaybackQuality?.();
    return {
      readyState: video.readyState,
      bufferedAheadSec: bufferedAhead(video),
      positionSec: video.currentTime,
      droppedFrames: quality?.droppedVideoFrames ?? null,
      totalFrames: quality?.totalVideoFrames ?? null,
      bandwidthBps: Number.isFinite(bandwidthBps ?? Number.NaN) ? bandwidthBps : null,
      lastFragment: this.fragment,
      // The element's own error is the fallback rather than the first answer: hls.js reports
      // the CAUSE ("fragLoadError") while the element reports only that decoding stopped. On
      // the native-HLS path there is no hls.js, and `code 4` is all there ever is.
      lastError: this.error ?? (video.error ? `media element error ${video.error.code}` : null),
      policyViolation: this.violation,
    };
  }
}
