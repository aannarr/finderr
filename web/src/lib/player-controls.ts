/**
 * The player's controls as pure rules: how far a key seeks, what a volume step is, which speed
 * comes next, what the seek bar announces, and what the on-screen feedback says.
 *
 * PURE and DOM-free, the split `keymap.ts` and `player-tracks.ts` already use: the components
 * decide what things look like and hang the listeners, this decides what they MEAN, and that is
 * what lets every rule here be pinned without a browser. The clock format itself is not here --
 * `clock()` in `playback-report.ts` already prints every time this player shows, and a second
 * one would be two roundings of one fact.
 */

import { clock } from "./playback-report";
import { SUBTITLES_OFF, type TrackChoices } from "./player-tracks";

/** `j` / `l` and the two skip buttons. */
export const SKIP_SEC = 10;
/** ← / →. Half a skip, because arrows repeat when held and ten seconds a repeat is a sprint. */
export const ARROW_SEC = 5;
/** ↑ / ↓ and the volume slider's own arrows. */
export const VOLUME_STEP = 0.05;
/** How long the chrome stays up after the pointer stops moving while playing. */
export const IDLE_HIDE_MS = 2_500;
/** How long a key's feedback stays on screen. */
export const FEEDBACK_MS = 700;
/**
 * The frame length a frame step uses. The session's diagnostics carry no frame rate, so this is
 * film's 24 fps rather than a probed value; a 25 or 30 fps source steps a hair short, which a
 * viewer stepping frame by frame corrects with one more press.
 */
export const DEFAULT_FRAME_SEC = 1 / 24;

/** The speed menu, and the ladder `<` and `>` walk. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** A position the element can actually be sent to. */
export function clampTime(seconds: number, duration: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(0, seconds), end);
}

/** A volume the element accepts, rounded so repeated steps do not drift to 0.35000000000000003. */
export function clampVolume(volume: number): number {
  return Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
}

/** The next speed up or down the ladder, or the same one at either end. */
export function stepSpeed(rate: number, direction: 1 | -1): number {
  // From wherever the rate is now, which may be off the ladder (a browser's own menu can set 1.1).
  if (direction === 1) return SPEEDS.find((s) => s > rate + 1e-9) ?? SPEEDS[SPEEDS.length - 1];
  return [...SPEEDS].reverse().find((s) => s < rate - 1e-9) ?? SPEEDS[0];
}

/** `0`-`9` as a position: the digit's tenth of the film. */
export function percentTime(digit: number, duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? (duration * digit) / 10 : 0;
}

/** One buffered range as fractions of the film, for drawing. */
export interface Span {
  start: number;
  end: number;
}

/** The bits of `TimeRanges` read here. Structural, so a test hands over a literal. */
export interface RangesSource {
  length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * EVERY buffered range, not only the one under the playhead.
 *
 * The one under the playhead is what "buffer ahead" in the stats panel measures; the seek bar
 * draws all of them because a viewer about to seek wants to see the HOLES -- a range further on
 * that the read-ahead already made is a seek that will not stall.
 */
export function bufferedSpans(ranges: RangesSource | null | undefined, duration: number): Span[] {
  if (!ranges || !Number.isFinite(duration) || duration <= 0) return [];
  const spans: Span[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const start = Math.max(0, ranges.start(i) / duration);
    const end = Math.min(1, ranges.end(i) / duration);
    if (end > start) spans.push({ start, end });
  }
  return spans;
}

/** Seconds as words for a screen reader: "1 hour 21 minutes", "4 minutes 5 seconds". */
export function spokenDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const secs = whole % 60;
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  // To the minute past an hour: "1 hour 21 minutes 7 seconds" is read aloud on every arrow press.
  if (hours > 0)
    return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour");
  if (minutes > 0)
    return secs > 0 ? `${unit(minutes, "minute")} ${unit(secs, "second")}` : unit(minutes, "minute");
  return unit(secs, "second");
}

/** `aria-valuetext` for the seek bar: "1 hour 21 minutes of 1 hour 37 minutes". */
export function seekValueText(position: number, duration: number): string {
  return `${spokenDuration(position)} of ${spokenDuration(duration)}`;
}

/** The time readout: `1:21:07 / 1:37:07`. Split so the moving half can be drawn louder. */
export function timeReadout(position: number, duration: number): { elapsed: string; total: string } {
  return { elapsed: clock(clampTime(position, duration)), total: clock(duration) };
}

/* ---- What a key says it did ---- */

export const skipFeedback = (deltaSec: number): string =>
  `${deltaSec > 0 ? "+" : "-"}${Math.abs(deltaSec)} s`;

export const volumeFeedback = (volume: number, muted: boolean): string =>
  muted || volume === 0 ? "Muted" : `Volume ${Math.round(volume * 100)}%`;

/** `1.5x`, and `Normal speed` at 1 -- "1x" reads like a setting nobody chose. */
export const speedFeedback = (rate: number): string => (rate === 1 ? "Normal speed" : `${rate}x`);

/** The label a speed wears in its menu. */
export const speedLabel = (rate: number): string => (rate === 1 ? "Normal" : `${rate}x`);

/* ---- Tracks from the keyboard ---- */

/**
 * What `c` does: off if on, otherwise back to the track last used -- or the first one.
 *
 * Null when there is nothing to switch, which the caller answers with feedback rather than a
 * silent no-op: a key that does nothing looks like a key that is broken.
 */
export function toggledSubtitles(choices: TrackChoices | null, lastUsed: number | null): number | null {
  if (!choices || choices.subtitles.length === 0) return null;
  if (choices.subtitlesAt !== SUBTITLES_OFF) return SUBTITLES_OFF;
  const remembered = choices.subtitles.find((t) => t.index === lastUsed);
  return (remembered ?? choices.subtitles[0])?.index ?? null;
}

/** What `a` does: the next audio track, wrapping. Null when there is only one, or none. */
export function nextAudioTrack(choices: TrackChoices | null): number | null {
  if (!choices || choices.audio.length < 2) return null;
  const at = choices.audio.findIndex((t) => t.index === choices.audioAt);
  return choices.audio[(at + 1) % choices.audio.length]?.index ?? null;
}

/** The feedback for a subtitle switch: "Subtitles: English", "Subtitles off". */
export function subtitlesFeedback(choices: TrackChoices | null, index: number): string {
  if (index === SUBTITLES_OFF) return "Subtitles off";
  const name = choices?.subtitles.find((t) => t.index === index)?.name;
  return name ? `Subtitles: ${name}` : "Subtitles on";
}

export function audioFeedback(choices: TrackChoices | null, index: number): string {
  const name = choices?.audio.find((t) => t.index === index)?.name;
  return name ? `Audio: ${name}` : "Audio track changed";
}

/**
 * Whether the chrome is on screen.
 *
 * `awake` is the pointer's recent activity; `pinned` is every state in which hiding would take
 * away what the viewer is using or needs to see -- paused, ended, scrubbing, a menu or the help
 * open, keyboard focus in the bar, an error. One predicate, so no state can pin the bar in one
 * place and forget to in another.
 */
export function chromeVisible(awake: boolean, pinned: boolean): boolean {
  return awake || pinned;
}
