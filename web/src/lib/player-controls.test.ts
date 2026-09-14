import { describe, expect, test } from "bun:test";
import {
  bufferedSpans,
  chromeVisible,
  clampTime,
  clampVolume,
  nextAudioTrack,
  percentTime,
  seekValueText,
  spokenDuration,
  stepSpeed,
  subtitlesFeedback,
  timeReadout,
  toggledSubtitles,
  volumeFeedback,
} from "./player-controls";
import { SUBTITLES_OFF, type TrackChoices } from "./player-tracks";

const ranges = (pairs: [number, number][]) => ({
  length: pairs.length,
  start: (i: number) => pairs[i]?.[0] ?? 0,
  end: (i: number) => pairs[i]?.[1] ?? 0,
});

const choices = (over: Partial<TrackChoices> = {}): TrackChoices => ({
  audio: [
    { index: 0, name: "English" },
    { index: 1, name: "Japanese" },
  ],
  audioAt: 0,
  subtitles: [
    { index: 0, name: "English" },
    { index: 1, name: "Svenska" },
  ],
  subtitlesAt: SUBTITLES_OFF,
  ...over,
});

describe("positions and volumes stay where the element can go", () => {
  test("a seek never leaves the film", () => {
    expect(clampTime(-4, 100)).toBe(0);
    expect(clampTime(140, 100)).toBe(100);
    expect(clampTime(40, Number.NaN)).toBe(40);
  });

  test("volume steps do not drift into floating-point noise", () => {
    expect(clampVolume(0.3 + 0.05)).toBe(0.35);
    expect(clampVolume(1.2)).toBe(1);
    expect(clampVolume(-0.1)).toBe(0);
  });

  test("0-9 is a tenth of the film each", () => {
    expect(percentTime(3, 200)).toBe(60);
    expect(percentTime(3, Number.NaN)).toBe(0);
  });
});

describe("speed walks the ladder", () => {
  test("up and down, stopping at both ends", () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
  });

  test("from a rate that is off the ladder, to its nearest neighbour", () => {
    expect(stepSpeed(1.1, 1)).toBe(1.25);
    expect(stepSpeed(1.1, -1)).toBe(1);
  });
});

describe("the seek bar draws every buffered range", () => {
  test("all ranges, as fractions, clipped to the film", () => {
    expect(
      bufferedSpans(
        ranges([
          [0, 30],
          [50, 60],
          [95, 130],
        ]),
        100,
      ),
    ).toEqual([
      { start: 0, end: 0.3 },
      { start: 0.5, end: 0.6 },
      { start: 0.95, end: 1 },
    ]);
  });

  test("nothing to draw before the length is known", () => {
    expect(bufferedSpans(ranges([[0, 10]]), Number.NaN)).toEqual([]);
    expect(bufferedSpans(null, 100)).toEqual([]);
  });
});

describe("what a screen reader hears", () => {
  test("the card's own example", () => {
    expect(seekValueText(4867, 5827)).toBe("1 hour 21 minutes of 1 hour 37 minutes");
  });

  test("under an hour keeps the seconds, and singulars are singular", () => {
    expect(spokenDuration(245)).toBe("4 minutes 5 seconds");
    expect(spokenDuration(61)).toBe("1 minute 1 second");
    expect(spokenDuration(3600)).toBe("1 hour");
  });

  test("the readout is the shared clock format", () => {
    expect(timeReadout(4867, 5827)).toEqual({ elapsed: "1:21:07", total: "1:37:07" });
  });
});

describe("tracks from the keyboard", () => {
  test("c turns subtitles off when on, and back to the last one used when off", () => {
    expect(toggledSubtitles(choices({ subtitlesAt: 1 }), 1)).toBe(SUBTITLES_OFF);
    expect(toggledSubtitles(choices(), 1)).toBe(1);
    expect(toggledSubtitles(choices(), null)).toBe(0);
    expect(toggledSubtitles(choices({ subtitles: [] }), null)).toBeNull();
  });

  test("a names the next audio track, wrapping, and nothing when there is no choice", () => {
    expect(nextAudioTrack(choices({ audioAt: 1 }))).toBe(0);
    expect(nextAudioTrack(choices({ audio: [{ index: 0, name: "English" }] }))).toBeNull();
  });

  test("feedback names what it did", () => {
    expect(subtitlesFeedback(choices(), 1)).toBe("Subtitles: Svenska");
    expect(subtitlesFeedback(choices(), SUBTITLES_OFF)).toBe("Subtitles off");
    expect(volumeFeedback(0.45, false)).toBe("Volume 45%");
    expect(volumeFeedback(0.45, true)).toBe("Muted");
  });
});

test("the chrome shows when awake or pinned, and only then", () => {
  expect(chromeVisible(false, false)).toBe(false);
  expect(chromeVisible(true, false)).toBe(true);
  expect(chromeVisible(false, true)).toBe(true);
});
