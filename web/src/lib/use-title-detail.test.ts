/**
 * The detail page's re-read policy, tested without React and without a DOM.
 *
 * `reReadUntilSettled` is the whole policy -- the hook around it is state plumbing. It
 * takes an injected `load` and `sleep`, so a schedule measured in seconds costs a test
 * nothing and the assertions are about WHEN it re-reads and when it stops, which is the
 * part that was wrong.
 */

import { describe, expect, test } from "bun:test";
import { POLL_CADENCE_MS, POLL_ERROR_BUDGET, pollWhileWorking } from "./use-title-detail";

/**
 * A virtual clock. `sleep` advances it instead of waiting, so a poll that would run for
 * seconds costs a test nothing and the assertions read as elapsed milliseconds.
 */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await Promise.resolve();
    },
  };
}

/** A server that reports work outstanding until `doneAt` ms have elapsed. */
function serverBusyUntil(doneAt: number, clock: ReturnType<typeof fakeClock>) {
  const at: number[] = [];
  return {
    at,
    load: async () => {
      at.push(clock.now());
      return { working: clock.now() < doneAt ? 2 : 0 };
    },
  };
}

const isWorking = (d: { working: number }) => d.working > 0;

describe("the poll cadence", () => {
  /**
   * The cadence decides how OFTEN to look, never how long to keep looking -- the stop
   * condition is the server saying it has finished. Front-loading matters because the
   * measurements say most answers land inside two seconds: cold titles settled at
   * 417/422/1240 ms singly and 1363/1520/1772/2027 ms in a burst, on 2026-08-31.
   */
  test("is front-loaded, so the first poll lands well inside the measured window", () => {
    expect(POLL_CADENCE_MS[0]).toBeLessThanOrEqual(400);
    let elapsed = 0;
    const checkpoints = POLL_CADENCE_MS.map((gap) => (elapsed += gap));
    // At least three looks before the slowest burst title we measured had settled.
    expect(checkpoints.filter((ms) => ms <= 2027).length).toBeGreaterThanOrEqual(3);
  });

  test("every gap is positive and the cadence only grows", () => {
    for (const gap of POLL_CADENCE_MS) expect(gap).toBeGreaterThan(0);
    for (let i = 1; i < POLL_CADENCE_MS.length; i++) {
      expect(POLL_CADENCE_MS[i]).toBeGreaterThanOrEqual(POLL_CADENCE_MS[i - 1] as number);
    }
  });
});

describe("polling while the server is working", () => {
  test("stops the moment the server says it has finished", async () => {
    const clock = fakeClock();
    const server = serverBusyUntil(500, clock);

    await pollWhileWorking({ working: 3 }, { load: server.load, isWorking, sleep: clock.sleep });

    // 300, then 700 -- the second read sees `working: 0` and the loop ends.
    expect(server.at).toEqual([300, 700]);
  });

  test("a server already finished on the first response costs zero polls", async () => {
    const clock = fakeClock();
    const server = serverBusyUntil(0, clock);

    await pollWhileWorking({ working: 0 }, { load: server.load, isWorking, sleep: clock.sleep });

    expect(server.at).toEqual([]);
  });

  /**
   * The case the fixed 3.3s schedule lost, and the reason this is not a timer. A provider
   * answering at 8s is rare, but the page had no way to know the difference between that
   * and a dead one -- so it hid both.
   */
  test("keeps going well past the old 3.3s ceiling while work is genuinely outstanding", async () => {
    const clock = fakeClock();
    const server = serverBusyUntil(8_000, clock);

    await pollWhileWorking({ working: 1 }, { load: server.load, isWorking, sleep: clock.sleep });

    expect(server.at.length).toBeGreaterThan(POLL_CADENCE_MS.length);
    expect(server.at.at(-1)).toBeGreaterThanOrEqual(8_000);
  });

  /** The cadence table must not be a stop condition when it runs out. */
  test("the last gap repeats rather than ending the poll", async () => {
    const clock = fakeClock();
    const server = serverBusyUntil(20_000, clock);

    await pollWhileWorking({ working: 1 }, { load: server.load, isWorking, sleep: clock.sleep });

    const last = POLL_CADENCE_MS.at(-1) as number;
    const tail = server.at.slice(-3);
    expect(tail[1] - (tail[0] as number)).toBe(last);
    expect(tail[2] - (tail[1] as number)).toBe(last);
  });

  test("a stopped view issues no further loads", async () => {
    const clock = fakeClock();
    const server = serverBusyUntil(Number.POSITIVE_INFINITY, clock);
    let stopped = false;

    await pollWhileWorking(
      { working: 1 },
      {
        load: async () => {
          stopped = true; // unmounted while the first poll was in flight
          return server.load();
        },
        isWorking,
        sleep: clock.sleep,
        stopped: () => stopped,
      },
    );

    expect(server.at).toEqual([300]);
  });

  test("a view stopped before the first gap elapses never loads at all", async () => {
    const clock = fakeClock();
    const server = serverBusyUntil(Number.POSITIVE_INFINITY, clock);

    await pollWhileWorking(
      { working: 1 },
      { load: server.load, isWorking, sleep: clock.sleep, stopped: () => true },
    );

    expect(server.at).toEqual([]);
  });
});

describe("giving up on a server that has stopped answering", () => {
  test("a dead server ends the poll after the error budget, not after forever", async () => {
    const clock = fakeClock();
    let calls = 0;
    const load = async () => {
      calls++;
      throw new Error("connection refused");
    };

    await pollWhileWorking({ working: 1 }, { load, isWorking, sleep: clock.sleep });

    expect(calls).toBe(POLL_ERROR_BUDGET);
  });

  /**
   * A blip in the middle of a healthy poll must not count towards giving up. The single
   * retry this replaced ended on the first error, which made one transient failure
   * indistinguishable from a provider that had genuinely answered "nothing".
   */
  test("the error budget RESETS on any success, so a blip does not end a healthy poll", async () => {
    const clock = fakeClock();
    let calls = 0;
    const load = async () => {
      calls++;
      // Fail twice, succeed, then fail twice more -- five calls, never three in a row.
      if (calls === 1 || calls === 2 || calls === 4 || calls === 5) throw new Error("blip");
      return { working: calls >= 6 ? 0 : 1 };
    };

    await pollWhileWorking({ working: 1 }, { load, isWorking, sleep: clock.sleep });

    // Without the reset this would have ended at 3. It reached the answer instead.
    expect(calls).toBeGreaterThanOrEqual(6);
  });
});
