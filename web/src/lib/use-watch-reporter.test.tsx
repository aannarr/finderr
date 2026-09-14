/**
 * The periodic position write, against a fake clock and a media element made of an EventTarget.
 */

import { describe, expect, mock, test } from "bun:test";
import { fakeTimers } from "../test/fake-timers";
import { act, render } from "../test/interact";
import { REPORT_EVERY_MS, type ReportedMedia, useWatchReporter } from "./use-watch-reporter";
import type { WatchWrite } from "./watch-api";

function fakeMedia(): ReportedMedia & { fire: (name: string) => void } {
  const target = new EventTarget() as ReportedMedia & { fire: (name: string) => void };
  target.currentTime = 0;
  target.duration = 2_400;
  target.paused = true;
  target.fire = (name) => target.dispatchEvent(new Event(name));
  return target;
}

function setup(opts: { season?: number; episode?: number } = {}) {
  const clock = fakeTimers();
  const media = fakeMedia();
  const puts: WatchWrite[] = [];
  const beacons: WatchWrite[] = [];
  const writer = {
    put: mock((_t: string, b: WatchWrite) => void puts.push(b)),
    beacon: mock((_t: string, b: WatchWrite) => void beacons.push(b)),
  };
  function Probe() {
    useWatchReporter({ tconst: "tt1", ...opts, media, timers: clock.timers, writer });
    return null;
  }
  const view = render(<Probe />);
  const play = () =>
    act(() => {
      media.paused = false;
      media.fire("playing");
    });
  return { clock, media, puts, beacons, view, play };
}

describe("writing the position while a title plays", () => {
  test("every fifteen seconds while playing, and not before playback has started", () => {
    const s = setup();
    act(() => s.clock.advance(REPORT_EVERY_MS * 3));
    act(() => s.media.fire("seeked"));
    expect(s.puts).toHaveLength(0);

    s.play();
    s.media.currentTime = 15;
    act(() => s.clock.advance(REPORT_EVERY_MS));
    s.media.currentTime = 30;
    act(() => s.clock.advance(REPORT_EVERY_MS));
    expect(s.puts).toEqual([
      { positionSec: 15, durationSec: 2_400 },
      { positionSec: 30, durationSec: 2_400 },
    ]);
  });

  test("a pause writes at once and stops the clock", () => {
    const s = setup();
    s.play();
    s.media.currentTime = 42;
    act(() => {
      s.media.paused = true;
      s.media.fire("pause");
    });
    expect(s.puts).toEqual([{ positionSec: 42, durationSec: 2_400 }]);
    act(() => s.clock.advance(REPORT_EVERY_MS * 4));
    expect(s.puts).toHaveLength(1);
  });

  test("a finished seek writes, and an episode names its season and number", () => {
    const s = setup({ season: 2, episode: 5 });
    s.play();
    s.media.currentTime = 600;
    act(() => s.media.fire("seeked"));
    expect(s.puts).toEqual([{ season: 2, episode: 5, positionSec: 600, durationSec: 2_400 }]);
  });

  test("pagehide goes by beacon, and closing the player writes where it stopped", () => {
    const s = setup();
    s.play();
    s.media.currentTime = 90;
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(s.beacons).toEqual([{ positionSec: 90, durationSec: 2_400 }]);
    s.view.unmount();
    expect(s.puts.at(-1)).toEqual({ positionSec: 90, durationSec: 2_400 });
    expect(s.clock.scheduled).toBe(0);
  });
});
