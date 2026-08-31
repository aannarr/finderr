import { describe, expect, test } from "bun:test";
import { PLEX_POLL_ATTEMPTS, PLEX_POLL_INTERVAL_MS, pollPlexPin } from "./plex-poll";

/** A fake clock: records what it was asked to wait for and returns immediately. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("pollPlexPin", () => {
  test("an answer on the first ask costs no wait at all", async () => {
    const clock = fakeSleep();
    let asks = 0;
    const res = await pollPlexPin(
      async () => {
        asks++;
        return { pending: false, ok: true };
      },
      { sleep: clock.sleep },
    );

    expect(res).toEqual({ done: { pending: false, ok: true } });
    expect(asks).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test("it keeps asking while the answer is pending", async () => {
    const clock = fakeSleep();
    let asks = 0;
    const res = await pollPlexPin(
      async () => {
        asks++;
        return asks < 4 ? { pending: true } : { pending: false, ok: true };
      },
      { sleep: clock.sleep },
    );

    expect(res).toEqual({ done: { pending: false, ok: true } });
    expect(asks).toBe(4);
    expect(clock.waits).toEqual([PLEX_POLL_INTERVAL_MS, PLEX_POLL_INTERVAL_MS, PLEX_POLL_INTERVAL_MS]);
  });

  test("it gives up after the cap, and reports that rather than throwing", async () => {
    // A tab left open overnight has to stop asking. Timing out is an outcome the caller
    // renders a message for, not an exception it has to distinguish from a real failure.
    const clock = fakeSleep();
    let asks = 0;
    const res = await pollPlexPin(
      async () => {
        asks++;
        return { pending: true };
      },
      { attempts: 5, sleep: clock.sleep },
    );

    expect(res).toEqual({ timedOut: true });
    expect(asks).toBe(5);
    // Four waits for five asks: no sleep after the last one, because waiting two seconds
    // to then give up anyway is two seconds of a spinner that cannot become an answer.
    expect(clock.waits).toHaveLength(4);
  });

  test("an error PROPAGATES -- a refusal is a final answer, not something to retry", async () => {
    // "That Plex account cannot be connected" is a 409 the caller shows. Retrying it 149
    // more times would hammer Plex to re-learn something the server already told us.
    let asks = 0;
    await expect(
      pollPlexPin(
        async () => {
          asks++;
          throw new Error("that Plex account cannot be connected");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("that Plex account cannot be connected");
    expect(asks).toBe(1);
  });

  test("the defaults are five minutes of patience", () => {
    // A person finding their password manager is the slow path here, not a network.
    expect((PLEX_POLL_ATTEMPTS * PLEX_POLL_INTERVAL_MS) / 1000 / 60).toBe(5);
  });

  test("`pending: undefined` counts as an answer, not as pending", async () => {
    // The link endpoint answers `{ ok: true, plexUsername }` on success and omits the key
    // entirely. Treating a missing `pending` as truthy would poll forever on success.
    const res = await pollPlexPin(async () => ({ ok: true }) as { pending?: boolean; ok: boolean }, {
      sleep: async () => {},
    });
    expect(res).toEqual({ done: { ok: true } });
  });
});
