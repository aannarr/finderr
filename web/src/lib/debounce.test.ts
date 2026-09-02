/**
 * The debounce policy, tested against a fake clock with no DOM and no React.
 *
 * Same shape as `use-title-detail.test.ts`: the hook around this is state plumbing, and the
 * part that was wrong -- how many requests a burst of typing sends -- is all here.
 */

import { describe, expect, test } from "bun:test";
import { debouncer, SEARCH_DEBOUNCE_MS, type Timers } from "./debounce";

/**
 * A virtual clock. Timers fire when `advance` passes their deadline, so a 150ms policy
 * costs a test nothing and assertions read as elapsed milliseconds.
 */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    get scheduled() {
      return pending.size;
    },
  };
}

/** Types `text` one character at a time, `gap` ms apart, and returns what got emitted. */
function type(text: string, gap: number, ms = SEARCH_DEBOUNCE_MS): string[] {
  const clock = fakeTimers();
  const sent: string[] = [];
  const d = debouncer<string>(ms, (v) => sent.push(v), clock.timers);
  for (let i = 1; i <= text.length; i++) {
    d.push(text.slice(0, i));
    clock.advance(gap);
  }
  clock.advance(ms); // the pause after the last keystroke
  return sent;
}

describe("debouncer", () => {
  test("a burst of keystrokes sends ONE request, for the last value", () => {
    // The measured bug: typing "the matrix" sent 10 requests in 3.1s, two of them the
    // 1033ms stopword query. At 40ms between keys the whole word is now one round trip.
    expect(type("the matrix", 40)).toEqual(["the matrix"]);
  });

  test("the expensive intermediate queries are never sent at all", () => {
    // `the` and `the ` were 1033ms EACH on the live NAS, and each one blocked the whole
    // event loop for that second. Not sending them is the entire fix.
    const sent = type("the matrix", 40);
    expect(sent).not.toContain("the");
    expect(sent).not.toContain("the ");
  });

  test("typing slower than the delay sends each settled value", () => {
    // Someone typing deliberately, or pausing to think, still gets live results -- the
    // debounce must not feel like a search that stopped working.
    expect(type("abc", SEARCH_DEBOUNCE_MS + 10)).toEqual(["a", "ab", "abc"]);
  });

  test("a pause mid-word sends the prefix, then the rest", () => {
    const clock = fakeTimers();
    const sent: string[] = [];
    const d = debouncer<string>(SEARCH_DEBOUNCE_MS, (v) => sent.push(v), clock.timers);
    d.push("mat");
    clock.advance(SEARCH_DEBOUNCE_MS);
    expect(sent).toEqual(["mat"]);
    d.push("matrix");
    clock.advance(SEARCH_DEBOUNCE_MS);
    expect(sent).toEqual(["mat", "matrix"]);
  });

  test("nothing is emitted before the delay has fully elapsed", () => {
    const clock = fakeTimers();
    const sent: string[] = [];
    const d = debouncer<string>(SEARCH_DEBOUNCE_MS, (v) => sent.push(v), clock.timers);
    d.push("matrix");
    clock.advance(SEARCH_DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toEqual(["matrix"]);
  });

  test("cancel drops the pending value and leaves no timer behind", () => {
    // Unmounting the route mid-flight must not fire a fetch into a dead component.
    const clock = fakeTimers();
    const sent: string[] = [];
    const d = debouncer<string>(SEARCH_DEBOUNCE_MS, (v) => sent.push(v), clock.timers);
    d.push("matrix");
    d.cancel();
    clock.advance(SEARCH_DEBOUNCE_MS * 10);
    expect(sent).toEqual([]);
    expect(clock.scheduled).toBe(0);
  });

  test("flush emits immediately, and only once", () => {
    // Submitting the form should not wait out the tail of the delay.
    const clock = fakeTimers();
    const sent: string[] = [];
    const d = debouncer<string>(SEARCH_DEBOUNCE_MS, (v) => sent.push(v), clock.timers);
    d.push("matrix");
    d.flush();
    expect(sent).toEqual(["matrix"]);
    clock.advance(SEARCH_DEBOUNCE_MS * 10);
    expect(sent).toEqual(["matrix"]);
  });

  test("flush with nothing pending emits nothing", () => {
    const clock = fakeTimers();
    const sent: string[] = [];
    debouncer<string>(SEARCH_DEBOUNCE_MS, (v) => sent.push(v), clock.timers).flush();
    expect(sent).toEqual([]);
  });

  test("the delay is under the gap that reads as a stalled page", () => {
    // Guards the constant itself: past ~200ms the pause after the last letter starts to
    // read as the page having stopped rather than as it thinking.
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(200);
  });
});
