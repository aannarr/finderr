import { describe, expect, test } from "bun:test";
import { type PlaybackPlan, planGlance, planSummary } from "./playback-types";

const plan = (over: Partial<PlaybackPlan>): PlaybackPlan => ({
  video: { action: "copy", sourceIndex: 0, codec: "hevc" },
  audio: [{ action: "transcode", sourceIndex: 1, codec: "aac", label: { name: "English", language: "eng" } }],
  subtitles: [],
  reasons: [],
  ...over,
});

describe("the plan at a glance", () => {
  test("copied video and re-encoded audio read as one line, the re-encode marked with an arrow", () => {
    expect(planGlance(plan({}))).toBe("copy hevc · → aac");
  });

  test("a re-encoded picture and copied sound say which way each went", () => {
    expect(
      planGlance(
        plan({
          video: { action: "transcode", sourceIndex: 0, codec: "h264" },
          audio: [
            { action: "copy", sourceIndex: 1, codec: "aac", label: { name: "English", language: "eng" } },
          ],
        }),
      ),
    ).toBe("→ h264 · aac");
  });

  test("the glance leaves track counts to the full summary", () => {
    const many = plan({
      audio: [
        { action: "transcode", sourceIndex: 1, codec: "aac", label: { name: "English", language: "eng" } },
        { action: "transcode", sourceIndex: 2, codec: "aac", label: { name: "Svenska", language: "swe" } },
      ],
    });
    expect(planGlance(many)).not.toContain("tracks");
    expect(planSummary(many)).toContain("2 audio tracks");
  });

  test("an empty plan draws a dash, never an empty cell", () => {
    expect(planGlance(plan({ video: null, audio: [] }))).toBe("—");
  });
});
