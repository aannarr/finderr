/**
 * What the `<video>` element is doing, as React state, for the controls to draw.
 *
 * The element is the single source of truth for playback -- paused, position, volume, rate --
 * and the controls READ it rather than keeping a copy that would drift the moment Safari's own
 * fullscreen UI or a media key changed something behind their back. Every event that can change
 * a drawn value re-reads the whole snapshot; `timeupdate` fires about four times a second, which
 * is the cadence a clock readout wants and far below anything that costs.
 *
 * `buffering` is the one DERIVED value, because no property says it. `waiting` sets it; anything
 * that proves frames are moving again clears it. `stalled` counts only when the element has
 * nothing ahead, because MSE players fire it routinely while playing perfectly well.
 */

import { useEffect, useState } from "react";

export interface VideoState {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  /** The element's buffered ranges, in seconds -- `player-controls.ts` turns them into spans. */
  buffered: TimeRanges | null;
  volume: number;
  muted: boolean;
  rate: number;
  buffering: boolean;
  /** Whether playback has ever started, which is what the big centre play waits for. */
  started: boolean;
  /** Whether the element has a frame to show (`readyState >= 2`). */
  ready: boolean;
}

export const IDLE_VIDEO: VideoState = {
  paused: true,
  ended: false,
  currentTime: 0,
  duration: Number.NaN,
  buffered: null,
  volume: 1,
  muted: false,
  rate: 1,
  buffering: false,
  started: false,
  ready: false,
};

const EVENTS = [
  "play",
  "pause",
  "playing",
  "waiting",
  "stalled",
  "canplay",
  "seeked",
  "timeupdate",
  "durationchange",
  "loadedmetadata",
  "progress",
  "volumechange",
  "ratechange",
  "ended",
] as const;

/**
 * Subscribe to an element and hand back its snapshot.
 *
 * `fallbackDuration` is the session's own runtime: the element does not know how long the film
 * is until the playlist has been parsed, and a seek bar with no end for that second would draw
 * nothing and announce NaN.
 */
export function useVideoState(video: HTMLVideoElement | null, fallbackDuration: number | null): VideoState {
  const [state, setState] = useState<VideoState>(IDLE_VIDEO);

  useEffect(() => {
    if (!video) return;
    let buffering = false;
    let started = false;
    const read = (event?: Event) => {
      switch (event?.type) {
        case "waiting":
          buffering = true;
          break;
        case "stalled":
          buffering = video.readyState < 3;
          break;
        case "playing":
        case "canplay":
        case "seeked":
        case "pause":
        case "ended":
          buffering = false;
          break;
        case "timeupdate":
          if (video.readyState >= 3) buffering = false;
          break;
      }
      if (event?.type === "playing") started = true;
      const duration =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : (fallbackDuration ?? Number.NaN);
      setState({
        paused: video.paused,
        ended: video.ended,
        currentTime: video.currentTime,
        duration,
        buffered: video.buffered ?? null,
        volume: video.volume,
        muted: video.muted,
        rate: video.playbackRate,
        buffering,
        started,
        ready: video.readyState >= 2,
      });
    };
    read();
    for (const name of EVENTS) video.addEventListener(name, read);
    return () => {
      for (const name of EVENTS) video.removeEventListener(name, read);
    };
  }, [video, fallbackDuration]);

  return state;
}
