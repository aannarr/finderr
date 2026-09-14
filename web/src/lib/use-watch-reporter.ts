/**
 * Tell the server where the reader is, as they watch.
 *
 * WHEN, and why each: every `REPORT_EVERY_MS` while playing (a crash or a closed laptop loses at
 * most that much), on pause and on a finished seek (the two moments a reader most often walks
 * away), at the end (so an episode is marked finished), when the player closes, and on
 * `pagehide` through a beacon -- the only request a browser promises to send from a page that
 * is going away.
 *
 * Each write is one upsert into local SQLite on the server (`watch-routes.ts`), measured at
 * 0.033 ms p50 on the M1 Max, so the cadence is set by what a lost position costs the reader and
 * not by what a write costs the box.
 *
 * NOTHING IS WRITTEN BEFORE PLAYBACK HAS STARTED. The element reports `currentTime` 0 and fires
 * `seeked` while a resume position is applied, and writing either would overwrite the very
 * position being resumed with zero.
 */

import { useEffect } from "react";
import { realTimers, type Timers } from "./timers";
import { beaconWatch, putWatch, type WatchWrite } from "./watch-api";

/** How often a playing title reports its position. */
export const REPORT_EVERY_MS = 15_000;

/** The slice of a `<video>` this reads. Structural, so a test hands over an `EventTarget`. */
export interface ReportedMedia extends EventTarget {
  currentTime: number;
  duration: number;
  paused: boolean;
}

export interface WatchWriter {
  put: (tconst: string, body: WatchWrite) => unknown;
  beacon: (tconst: string, body: WatchWrite) => unknown;
}

const LIVE: WatchWriter = { put: putWatch, beacon: beaconWatch };

export function useWatchReporter({
  tconst,
  season,
  episode,
  media,
  timers = realTimers,
  writer = LIVE,
}: {
  tconst: string;
  season?: number;
  episode?: number;
  media: ReportedMedia | null;
  timers?: Timers;
  writer?: WatchWriter;
}): void {
  useEffect(() => {
    if (!media) return;
    let started = false;
    let handle: unknown = null;

    /** The body for right now, or null when there is nothing true to say yet. */
    const body = (): WatchWrite | null => {
      const duration = media.duration;
      if (!started || !Number.isFinite(duration) || duration <= 0) return null;
      const at = season !== undefined && episode !== undefined ? { season, episode } : {};
      return {
        ...at,
        positionSec: Math.min(duration, Math.max(0, media.currentTime)),
        durationSec: duration,
      };
    };
    const put = () => {
      const b = body();
      if (b) void writer.put(tconst, b);
    };
    const stopTicking = () => {
      if (handle !== null) timers.clear(handle);
      handle = null;
    };
    const tick = () => {
      stopTicking();
      handle = timers.set(() => {
        handle = null;
        put();
        if (!media.paused) tick();
      }, REPORT_EVERY_MS);
    };

    const onPlaying = () => {
      started = true;
      if (handle === null) tick();
    };
    const onPause = () => {
      stopTicking();
      put();
    };
    const onPageHide = () => {
      const b = body();
      if (b) void writer.beacon(tconst, b);
    };

    media.addEventListener("playing", onPlaying);
    media.addEventListener("pause", onPause);
    media.addEventListener("ended", onPause);
    media.addEventListener("seeked", put);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      stopTicking();
      media.removeEventListener("playing", onPlaying);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("ended", onPause);
      media.removeEventListener("seeked", put);
      window.removeEventListener("pagehide", onPageHide);
      // The player closing is a moment the reader chose to stop: record where.
      put();
    };
  }, [media, tconst, season, episode, timers, writer]);
}
