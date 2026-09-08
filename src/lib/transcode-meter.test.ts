/**
 * The playback cost meter, against a pinned clock.
 *
 * The properties worth the most here are the ones a chart cannot show you it got wrong: that
 * the CPU number is the ffmpeg CHILDREN and not this process, that history really does roll off
 * the far end of the window rather than accumulating, and that the session table stays bounded
 * while telling you what it dropped.
 */

import { describe, expect, test } from "bun:test";
import { NOT_AN_EPISODE } from "./media-file";
import { mediaLabel, type PlayedMedia, TranscodeMeter } from "./transcode-meter";

const FILM: PlayedMedia = { tconst: "tt1375666", season: NOT_AN_EPISODE, episode: NOT_AN_EPISODE };
const EPISODE: PlayedMedia = { tconst: "tt0903747", season: 2, episode: 7 };

const MINUTE = 60_000;
const START = 1_700_000_000_000;

/** A meter and the handle that moves its clock, so every window question is deterministic. */
function meter() {
  let clock = START;
  const m = new TranscodeMeter({ now: () => clock });
  return {
    m,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Nothing is running unless a test says so; liveness is the manager's fact, not the meter's. */
    report: (live: string[] = []) => m.report((id) => live.includes(id)),
  };
}

describe("counting what a playback costs", () => {
  test("bytes and child CPU land on the session that caused them", () => {
    const { m, report } = meter();
    m.open("s1", FILM);
    m.served("s1", 3_000_000);
    m.served("s1", 1_000_000);
    m.burned("s1", 420);

    const r = report(["s1"]);
    expect(r.window).toEqual({ bytes: 4_000_000, cpuMs: 420 });
    expect(r.sessions).toEqual([
      {
        id: "s1",
        media: FILM,
        bytes: 4_000_000,
        cpuMs: 420,
        startedAt: new Date(START).toISOString(),
        lastAt: new Date(START).toISOString(),
        running: true,
      },
    ]);
  });

  /**
   * THE DISTINCTION THE CARD ASKED FOR A TEST ON.
   *
   * A meter built on `process.cpuUsage()` could not produce this line: this process has burned
   * real CPU getting here, and the number below is still zero because no ffmpeg has run. That
   * is the whole difference between "what is this box doing" and "what is transcoding costing".
   */
  test("CPU is the ffmpeg children, so a process that has transcoded nothing reports zero", () => {
    const { m, report } = meter();
    m.open("s1", FILM);
    m.served("s1", 8_000_000);
    // Burn some of THIS process's CPU, which a process-wide meter would attribute to playback.
    let spun = 0;
    for (let i = 0; i < 2_000_000; i++) spun += i;
    expect(spun).toBeGreaterThan(0);
    expect(process.cpuUsage().user).toBeGreaterThan(0);

    expect(report().window.cpuMs).toBe(0);
    expect(report().sessions[0]?.cpuMs).toBe(0);
  });

  test("a session that was never opened still counts towards the box's total", () => {
    const { m, report } = meter();
    m.served("ghost", 2_000);

    const r = report();
    // No row -- there is nothing to call it -- but the machine really did push the bytes, so
    // hiding them would report the box as quieter than it was.
    expect(r.sessions).toHaveLength(0);
    expect(r.window.bytes).toBe(2_000);
    expect(r.measured).toBe(true);
  });

  test("zero and negative charges are not recorded at all", () => {
    const { m, report } = meter();
    m.open("s1", FILM);
    m.served("s1", 0);
    m.burned("s1", -5);

    const r = report();
    expect(r.measured).toBe(false);
    expect(r.window).toEqual({ bytes: 0, cpuMs: 0 });
  });

  test("re-opening a joined session keeps its running totals", () => {
    const { m, report } = meter();
    m.open("s1", FILM);
    m.served("s1", 5_000);
    // A second viewer of the same film joins the same session and starts again.
    m.open("s1", FILM);

    expect(report().sessions[0]?.bytes).toBe(5_000);
  });
});

describe("the rolling window", () => {
  test("slices are contiguous, oldest first, and cover the whole window", () => {
    const { report } = meter();
    const r = report();
    expect(r.sliceSeconds).toBe(30);
    expect(r.windowSeconds).toBe(2 * 60 * 60);
    expect(r.slices).toHaveLength(r.windowSeconds / r.sliceSeconds);
    expect(r.slices.every((s) => s.bytes === 0 && s.cpuMs === 0)).toBe(true);
    expect(r.measured).toBe(false);
  });

  test("what was served lands in the newest slice, and moves back as time passes", () => {
    const { m, advance, report } = meter();
    m.open("s1", FILM);
    m.served("s1", 1_000);

    const last = report().slices.length - 1;
    expect(report().slices[last]?.bytes).toBe(1_000);

    advance(5 * MINUTE);
    // Ten 30-second slices later, the same bytes are ten slices further from the right edge.
    expect(report().slices[last]?.bytes).toBe(0);
    expect(report().slices[last - 10]?.bytes).toBe(1_000);
    expect(report().window.bytes).toBe(1_000);
  });

  test("history older than the window rolls off, and the session total does not", () => {
    const { m, advance, report } = meter();
    m.open("s1", FILM);
    m.served("s1", 9_000_000);

    advance(3 * 60 * MINUTE);
    const r = report();
    expect(r.window.bytes).toBe(0);
    expect(r.slices.every((s) => s.bytes === 0)).toBe(true);
    // The chart forgets; the session table is what answers "what did that play cost".
    expect(r.sessions[0]?.bytes).toBe(9_000_000);
    expect(r.measured).toBe(true);
  });

  test("the window sums exactly what the slices hold", () => {
    const { m, advance, report } = meter();
    m.open("s1", FILM);
    for (let i = 0; i < 20; i++) {
      m.served("s1", 100);
      m.burned("s1", 3);
      advance(90_000);
    }
    const r = report();
    const summed = r.slices.reduce((acc, s) => ({ bytes: acc.bytes + s.bytes, cpuMs: acc.cpuMs + s.cpuMs }), {
      bytes: 0,
      cpuMs: 0,
    });
    expect(r.window).toEqual(summed);
  });
});

describe("the session table stays bounded", () => {
  test("the least recently active row is dropped, and the drop is reported", () => {
    const { m, advance, report } = meter();
    // 32 sessions fill the table; each is opened a minute after the last one, so "least
    // recently active" and "opened first" are the same session.
    for (let i = 0; i < 32; i++) {
      m.open(`s${i}`, FILM);
      m.served(`s${i}`, 1_000 + i);
      advance(MINUTE);
    }
    expect(report().sessions).toHaveLength(32);
    expect(report().evicted).toBe(0);

    m.open("s32", FILM);
    const r = report();
    expect(r.sessions).toHaveLength(32);
    expect(r.sessions.map((s) => s.id)).not.toContain("s0");
    expect(r.evicted).toBe(1);
    // The evicted session's bytes are still in the window: the box really pushed them, so the
    // rows summing to less than the total is the truth rather than a rounding error.
    expect(r.window.bytes).toBeGreaterThan(r.sessions.reduce((n, s) => n + s.bytes, 0));
  });

  test("rows are biggest spender first", () => {
    const { m, report } = meter();
    m.open("small", FILM);
    m.open("big", EPISODE);
    m.served("small", 10);
    m.served("big", 10_000);

    expect(report().sessions.map((s) => s.id)).toEqual(["big", "small"]);
  });
});

describe("naming what was played", () => {
  test("a film is its tconst and an episode carries its season and number", () => {
    expect(mediaLabel(FILM)).toBe("tt1375666");
    expect(mediaLabel(EPISODE)).toBe("tt0903747 S02E07");
  });

  test("season zero is a real season -- the specials -- and is not a film", () => {
    expect(mediaLabel({ tconst: "tt0903747", season: 0, episode: 3 })).toBe("tt0903747 S00E03");
  });
});
