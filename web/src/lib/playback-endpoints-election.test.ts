import { afterEach, describe, expect, mock, test } from "bun:test";
import { electStreamEndpoint, type PlaybackSession } from "./playback-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const session = (bases: string[]): PlaybackSession => ({
  sessionId: "s1",
  playlist: "/api/play/s/s1/index.m3u8",
  streamToken: "t1",
  endpoints: bases.map((base) => ({ base, family: "v4", kind: "lan", source: "interface" })),
  durationSec: 60,
  segments: 10,
  plan: { video: null, audio: [], subtitles: [], reasons: [] },
});

describe("choosing where to stream from", () => {
  /**
   * REGRESSION, 2026-09-15: the NAS container advertised its Docker bridge addresses over plain
   * http, and Safari on https://finderr.frst.dev raced both -- each one a refused mixed-content
   * request and a console error, and never a candidate that could have won.
   */
  test("an https page never probes an http candidate", async () => {
    const probed: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      probed.push(String(input));
      return new Response("#EXTM3U", { status: 200 });
    }) as unknown as typeof fetch;

    const ring = await electStreamEndpoint(
      session(["http://172.21.0.12:7979", "http://172.26.0.5:7979"]),
      "https://finderr.example.com",
    );

    expect(probed).toEqual([]);
    expect(ring.candidates()).toEqual(["https://finderr.example.com"]);
  });

  test("an http page still races its http candidates", async () => {
    const probed: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      probed.push(String(input));
      return new Response("#EXTM3U", { status: 200 });
    }) as unknown as typeof fetch;

    await electStreamEndpoint(session(["http://192.168.1.5:7979"]), "http://192.168.1.9:7979");

    expect(probed.some((url) => url.startsWith("http://192.168.1.5:7979"))).toBe(true);
  });
});
