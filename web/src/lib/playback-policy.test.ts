/**
 * A CSP refusal reaches the stats panel and the copied report, and no stream token comes with it.
 *
 * The failure this exists for: the CSP refused hls.js's `blob:` MediaSource, hls.js raised
 * nothing, the element said `code 4`, and the report said nothing else.
 */

import { describe, expect, test } from "bun:test";
import type { PlaybackSession } from "./playback-api";
import { lastErrorLine, playbackReport } from "./playback-report";
import { PlaybackTelemetry, redactBlockedUri, watchPolicyViolations } from "./playback-telemetry";

const element = {
  readyState: 0,
  currentTime: 0,
  buffered: { length: 0, start: () => 0, end: () => 0 },
  error: { code: 4 },
};

const session: PlaybackSession = {
  sessionId: "s1",
  playlist: "/api/play/s/s1/index.m3u8",
  durationSec: 100,
  segments: 17,
  plan: { video: null, audio: [], subtitles: [], reasons: [] },
} as unknown as PlaybackSession;

function violate(target: EventTarget, fields: Record<string, string>) {
  // happy-dom has no SecurityPolicyViolationEvent, so the fields are put on a plain Event.
  target.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), fields));
}

describe("a synthetic CSP violation", () => {
  test("names the directive in the stats and in the copied report", () => {
    const target = new EventTarget();
    const telemetry = new PlaybackTelemetry();
    const stop = watchPolicyViolations(target, telemetry);
    violate(target, { effectiveDirective: "media-src", blockedURI: "blob" });
    stop();

    const stats = telemetry.read(element, null);
    expect(stats.policyViolation).toEqual({ directive: "media-src", blocked: "blob" });
    expect(lastErrorLine(stats)).toBe("media element error 4 · CSP: media-src refused blob");

    const report = playbackReport({
      session,
      browser: stats,
      report: null,
      capabilities: { video: [], audio: [] },
      userAgent: "test",
      page: "https://finderr.example.com/title/tt1",
      now: 0,
    });
    expect(report).toContain("Blocked by CSP: media-src refused blob");
  });

  test("no stream token survives into the report", () => {
    const target = new EventTarget();
    const telemetry = new PlaybackTelemetry();
    watchPolicyViolations(target, telemetry);
    violate(target, {
      violatedDirective: "connect-src",
      blockedURI: "http://172.20.0.5:7979/api/play/s/s1/v0-12.m4s?t=secret-token-123",
    });
    const stats = telemetry.read(element, null);
    const text = [lastErrorLine(stats) ?? ""].join("\n");
    expect(text).toContain("connect-src refused http://172.20.0.5:7979");
    expect(text).not.toContain("secret-token-123");
    expect(text).not.toContain("/api/play");
  });

  test("stops listening once released", () => {
    const target = new EventTarget();
    const telemetry = new PlaybackTelemetry();
    watchPolicyViolations(target, telemetry)();
    violate(target, { effectiveDirective: "media-src", blockedURI: "blob" });
    expect(telemetry.read(element, null).policyViolation).toBeNull();
  });
});

describe("redacting a refused URI", () => {
  test("keywords pass, URLs become origins, blob URLs become the scheme, junk becomes unknown", () => {
    expect(redactBlockedUri("inline")).toBe("inline");
    expect(redactBlockedUri("https://cdn.example.com/x.js?t=abc")).toBe("https://cdn.example.com");
    expect(redactBlockedUri("blob:https://finderr.example.com/0b1c")).toBe("blob:");
    expect(redactBlockedUri("not a url ?t=abc")).toBe("unknown");
  });
});
