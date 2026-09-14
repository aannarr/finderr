import { describe, expect, test } from "bun:test";
import type { PlaybackSession, SessionsReport } from "./playback-api";
import { mediaErrorLine, playbackReport, type ReportInput } from "./playback-report";
import type { BrowserStats } from "./playback-telemetry";

const SESSION: PlaybackSession = {
  sessionId: "3f5500c4",
  playlist: "/api/play/s/3f5500c4/index.m3u8",
  durationSec: 7156,
  segments: 775,
  plan: {
    video: { action: "copy", sourceIndex: 0, codec: "hevc" },
    audio: [{ action: "copy", sourceIndex: 1, codec: "ac3", label: { name: "English", language: "eng" } }],
    subtitles: [],
    reasons: ["video is hevc, which this browser decodes -- copied"],
  },
  diagnostics: {
    source: {
      container: "matroska,webm",
      resolution: "1920x800",
      videoCodec: "hevc",
      audioCodec: "ac3",
      audioChannels: 6,
      bitDepth: 10,
      dynamicRange: null,
      durationSec: 7156,
      sizeBytes: 5_400_000_000,
    },
    segmenting: { source: "container", targetSec: 6, count: 775 },
    encoder: { name: "h264_vaapi", hardware: true, reason: "hardware (VAAPI)" },
  },
};

const DEAD: BrowserStats = {
  readyState: 0,
  bufferedAheadSec: 0,
  positionSec: 0,
  droppedFrames: 0,
  totalFrames: 0,
  bandwidthBps: 5_000_000,
  lastFragment: null,
  lastError: "media element error 4",
};

const REPORT: SessionsReport = {
  sessions: [
    {
      id: "3f5500c4",
      expensive: false,
      segments: 775,
      startedAt: new Date(1_000_000).toISOString(),
      lastAccessAt: new Date(1_000_000).toISOString(),
      owner: null,
      plan: SESSION.plan,
    },
  ],
  budgets: { sessions: { used: 1, max: 8 }, expensive: { used: 0, max: 3 } },
};

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  session: SESSION,
  browser: DEAD,
  report: REPORT,
  capabilities: { video: ["h264", "hevc"], audio: ["aac", "ac3"] },
  userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15",
  page: "https://finderr.example.com/title/tt2209764",
  now: 1_047_000,
  ...over,
});

describe("a media error in words", () => {
  test("every spec code reads as a sentence and keeps its number for a bug report", () => {
    expect(mediaErrorLine(3)).toBe("This browser could not decode the video (media error 3).");
    for (const code of [1, 2, 4]) expect(mediaErrorLine(code)).toContain(`(media error ${code})`);
  });

  test("no code never prints the word unknown", () => {
    expect(mediaErrorLine(undefined)).toBe("The video stopped without saying why.");
    expect(mediaErrorLine(null)).not.toContain("unknown");
  });
});

describe("the copied diagnostics", () => {
  test("carry what the panel shows plus what the browser claimed and who it is", () => {
    const text = playbackReport(input());

    expect(text).toContain("Page: https://finderr.example.com/title/tt2209764");
    expect(text).toContain("Browser: Mozilla/5.0 (Macintosh) Safari/605.1.15");
    expect(text).toContain("Claims video: h264, hevc");
    expect(text).toContain("Claims audio: aac, ac3");
    expect(text).toContain("Plan: video hevc copied");
    expect(text).toContain("Video: hevc · 1920x800 · 10-bit");
    expect(text).toContain("Segments: 775 segments, ~6s, on the container's own index");
    expect(text).toContain("Session: 3f5500c4");
    expect(text).toContain("Ready state: 0 - nothing");
    expect(text).toContain("Last error: media element error 4");
    expect(text).toContain("Sessions: 1 of 8");
    expect(text).toContain("- video is hevc, which this browser decodes -- copied");
  });

  test("never print undefined when nothing is known yet", () => {
    const text = playbackReport(
      input({ browser: null, report: null, session: { ...SESSION, diagnostics: undefined } }),
    );

    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text).toContain("Ready state: —");
    expect(text).toContain("Server lists it: —");
  });

  test("say plainly when the server has stopped listing the session", () => {
    expect(playbackReport(input({ report: { ...REPORT, sessions: [] } }))).toContain("Server lists it: no");
  });

  test("is one fact per line, so it reads as a list when pasted", () => {
    const lines = playbackReport(input()).split("\n");
    expect(lines[0]).toBe("finderr playback diagnostics");
    expect(lines.every((l) => l.length > 0)).toBe(true);
  });
});
