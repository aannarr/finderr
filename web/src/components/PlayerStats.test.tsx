/**
 * The stats panel.
 *
 * Two properties carry this file. **It draws a dash rather than `undefined`** for every value
 * nobody knows -- an unscanned arr row, a server too old to send diagnostics, a browser that
 * cannot count frames -- because a diagnostic panel that lies about what it knows is worse
 * than none. And **it stops polling when it goes away**: it is mounted only while it is open,
 * so unmounting is what clears both timers.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PlaybackDiagnostics, PlaybackSession, SessionsReport } from "../lib/playback-api";
import type { BrowserStats } from "../lib/playback-telemetry";
import { render, waitFor } from "../test/interact";
import { PlayerStats } from "./PlayerStats";

const realFetch = globalThis.fetch;

// Named apart from SESSION because `diagnostics` is OPTIONAL on a session -- a server too old
// to send it is a case this panel handles -- so spreading `SESSION.diagnostics` widens every
// member to `| undefined` and a test that varies one field stops typechecking.
const DIAGNOSTICS: PlaybackDiagnostics = {
  source: {
    container: "matroska,webm",
    resolution: "3840x2160",
    videoCodec: "hevc",
    audioCodec: "dts",
    audioChannels: 6,
    bitDepth: 10,
    dynamicRange: "HDR",
    durationSec: 8880,
    sizeBytes: 3_400_000_000,
  },
  segmenting: { source: "container", targetSec: 6, count: 1480 },
  encoder: { name: "h264_vaapi", hardware: true, reason: "hardware (VAAPI)" },
};

const SESSION: PlaybackSession = {
  sessionId: "sess-1",
  playlist: "/api/play/s/sess-1/index.m3u8",
  durationSec: 8880,
  segments: 1480,
  plan: {
    video: { action: "copy", sourceIndex: 0, codec: "hevc" },
    audio: [
      { action: "transcode", sourceIndex: 1, codec: "aac", label: { name: "English", language: "eng" } },
    ],
    subtitles: [],
    reasons: ["video is hevc and this browser plays it, copied"],
  },
  diagnostics: DIAGNOSTICS,
};

const REPORT: SessionsReport = {
  sessions: [
    {
      id: "sess-1",
      expensive: false,
      segments: 1480,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      lastAccessAt: new Date().toISOString(),
      owner: "admin-1",
      plan: SESSION.plan,
    },
  ],
  budgets: { sessions: { used: 2, max: 8 }, expensive: { used: 1, max: 3 } },
};

const STATS: BrowserStats = {
  readyState: 4,
  bufferedAheadSec: 18.4,
  positionSec: 581,
  droppedFrames: 7,
  totalFrames: 1500,
  bandwidthBps: 4_200_000,
  lastFragment: { index: 96, track: "main", loadMs: 74, bytes: 1_050_000 },
  lastError: null,
};

/** A server that answers the one poll this panel makes, and counts how often it is asked. */
function servingSessions(report: SessionsReport | null = REPORT) {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (!report) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

/**
 * The fetch a test gets when it has not said otherwise: one that REFUSES.
 *
 * Deliberately not a `200 {}`. `fetchSessions` treats a refusal as "I do not know" and sets no
 * state, so a test asserting on the browser half alone finishes without a React update landing
 * after it returned -- which is the shape that fills a suite with `act(...)` warnings and
 * trains everybody to ignore one.
 */
const refusingFetch = mock(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

beforeEach(() => {
  globalThis.fetch = refusingFetch;
});

afterEach(() => {
  globalThis.fetch = refusingFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const show = (over: { session?: PlaybackSession; stats?: BrowserStats | null } = {}) =>
  render(
    <PlayerStats
      session={over.session ?? SESSION}
      readBrowserStats={() => (over.stats === undefined ? STATS : over.stats)}
    />,
  );

describe("what a playing title reports", () => {
  test("the plan, the encoder, the source and the cut are all on screen", async () => {
    servingSessions();
    const { container } = show();

    await waitFor(() => expect(container.textContent).toContain("h264_vaapi"));
    const text = container.textContent ?? "";
    expect(text).toContain("video hevc copied");
    expect(text).toContain("matroska,webm");
    expect(text).toContain("3840x2160");
    expect(text).toContain("10-bit");
    expect(text).toContain("HDR");
    expect(text).toContain("dts");
    expect(text).toContain("3.4 GB");
    // The cut source is the difference between "this stutters" and "this fell back to a grid".
    expect(text).toContain("on the container's own index");
    expect(text).toContain("1480 segments");
    // The plan's own sentences, which the server writes in plain English for exactly this.
    expect(text).toContain("video is hevc and this browser plays it, copied");
  });

  // All three cut sources are named apart on screen. The container index and the ffprobe probe
  // both produce a correct timeline, so a panel that called them one thing could not tell a
  // working container reader from an expensive fallback to the probe -- and `uniform` is the
  // one that actually stutters. Pinned per source because the branch is where they diverge.
  test.each([
    ["container", "on the container's own index"],
    ["probe", "on probed keyframes"],
    ["uniform", "on a uniform grid"],
  ] as const)("a %s timeline says so in its own words", (source, said) => {
    const session: PlaybackSession = {
      ...SESSION,
      diagnostics: { ...DIAGNOSTICS, segmenting: { source, targetSec: 6, count: 1480 } },
    };
    const { container } = show({ session });

    expect(container.textContent ?? "").toContain(said);
  });

  test("the browser half is drawn from what the player measured", () => {
    const { container } = show();
    const text = container.textContent ?? "";

    expect(text).toContain("enough to finish");
    expect(text).toContain("18.4s");
    expect(text).toContain("7 of 1500");
    expect(text).toContain("4.2 Mbps");
    expect(text).toContain("#96");
    expect(text).toContain("74 ms");
    // The playhead as a clock rather than 581 seconds.
    expect(text).toContain("9:41");
  });

  test("the two budgets say what is spent against each", async () => {
    servingSessions();
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("2 of 8"));
    expect(container.textContent).toContain("1 of 3");
  });

  test("an encoder that is not in use says so rather than implying a re-encode", () => {
    const { container } = show();
    expect(container.textContent).toContain("idle");
  });
});

describe("it never prints undefined", () => {
  /** A server that predates the diagnostics block. The panel must draw, not crash. */
  test("a session with no diagnostics draws dashes", () => {
    const bare: PlaybackSession = { ...SESSION, diagnostics: undefined };
    const { container } = show({ session: bare });
    const text = container.textContent ?? "";

    expect(text).not.toContain("undefined");
    expect(text).toContain("—");
    // The plan came from the same response and is still worth showing.
    expect(text).toContain("video hevc copied");
  });

  test("an unscanned file leaves out the parts nobody measured rather than dashing each one", () => {
    const unscanned: PlaybackSession = {
      ...SESSION,
      diagnostics: {
        source: {
          container: null,
          resolution: null,
          videoCodec: "hevc",
          audioCodec: null,
          audioChannels: null,
          bitDepth: null,
          dynamicRange: null,
          durationSec: null,
          sizeBytes: null,
        },
        segmenting: { source: null, targetSec: 6, count: 0 },
        encoder: null,
      },
    };
    const { container } = show({ session: unscanned });
    const text = container.textContent ?? "";

    expect(text).not.toContain("undefined");
    // One known part, drawn on its own -- not "hevc · — · —".
    expect(text).toContain("hevc");
    expect(text).toContain("no video timeline");
  });

  test("nothing measured in the browser yet is dashes rather than zeroes", () => {
    const { container } = show({ stats: null });
    const text = container.textContent ?? "";
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("0.0s");
  });

  test("a browser that cannot count frames says so rather than claiming none were dropped", () => {
    const blind: BrowserStats = { ...STATS, droppedFrames: null, totalFrames: null, bandwidthBps: null };
    const { container } = show({ stats: blind });
    expect(container.textContent).not.toContain("0 of 0");
  });

  test("a server that refuses the poll leaves the server column unknown rather than blank", async () => {
    servingSessions(null);
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("—"));
    expect(container.textContent).not.toContain("undefined");
  });

  /**
   * REGRESSION. `fetchSessions` used to cast any 200 body to a report, so a body of another
   * shape reached this component as a report with no `sessions` array and the first `.find`
   * threw inside the PLAYER's tree -- a diagnostic that took the video down with it.
   */
  test("a 200 that is not a session report is treated as unknown rather than thrown at", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ sessionId: "s1", playlist: "/x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("Sessions"));
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("undefined");
  });
});

describe("what it says when something is wrong", () => {
  test("a stall names itself instead of leaving a reader to interpret a zero", () => {
    const stalled: BrowserStats = { ...STATS, readyState: 2, bufferedAheadSec: 0 };
    const { container } = show({ stats: stalled });
    expect(container.textContent).toContain("what a stall looks like");
  });

  /** `readyState 0` with an empty console is this subsystem's oldest failure. */
  test("readyState 0 is called out rather than printed as a number", () => {
    const dead: BrowserStats = { ...STATS, readyState: 0, bufferedAheadSec: 0 };
    const { container } = show({ stats: dead });
    expect(container.textContent).toContain("no data at all");
  });

  test("the last player error is shown with its cause", () => {
    const failing: BrowserStats = { ...STATS, lastError: "fragLoadError (fatal)" };
    const { container } = show({ stats: failing });
    expect(container.textContent).toContain("fragLoadError (fatal)");
  });

  test("a session the server has stopped listing is called out", async () => {
    servingSessions({ ...REPORT, sessions: [] });
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("no longer listing"));
  });
});

describe("it stops polling when it goes away", () => {
  test("unmounting ends the server poll", async () => {
    const calls = servingSessions();
    const { unmount } = show();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    unmount();
    const after = calls.length;
    // Well past a browser tick and most of a server tick: a timer that survived the unmount
    // would fire in here.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(calls.length).toBe(after);
  });

  test("unmounting ends the browser sampling too", async () => {
    let reads = 0;
    const { unmount } = render(
      <PlayerStats
        session={SESSION}
        readBrowserStats={() => {
          reads++;
          return STATS;
        }}
      />,
    );
    await waitFor(() => expect(reads).toBeGreaterThan(0));

    unmount();
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(reads).toBe(after);
  });

  test("the panel polls exactly one endpoint", async () => {
    const calls = servingSessions();
    show();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect([...new Set(calls)]).toEqual(["/api/play/sessions"]);
  });
});

describe("a session that is running", () => {
  test("says how long it has been up", async () => {
    servingSessions();
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("2 minutes"));
  });
});
