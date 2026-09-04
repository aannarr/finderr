/**
 * The two rules that decide whether a retry helps or hurts.
 *
 * Both are cheap to get wrong and expensive to notice: retrying a 4xx triples the latency in
 * front of a reader who was always going to be told no, and retrying a stream that has
 * already emitted renders the answer twice, spliced, which reads as the model repeating
 * itself rather than as a bug.
 */

import { describe, expect, test } from "bun:test";
import { OpenRouterError } from "./openrouter";
import { describeFailure, isTransient, retryableStream } from "./resilience";

describe("what counts as transient", () => {
  test.each([429, 500, 502, 503, 529])("%i is worth another attempt", (status) => {
    expect(isTransient(new OpenRouterError("upstream wobble", status))).toBe(true);
  });

  test.each([400, 401, 402, 403, 404, 422])("%i will fail identically forever", (status) => {
    // A malformed schema, a wrong key, no credit. Retrying turns one clear error into three
    // slow ones.
    expect(isTransient(new OpenRouterError("nope", status))).toBe(false);
  });

  test("a network error with no status at all is transient", () => {
    // DNS, a reset connection, a TLS hiccup -- the most common transient failure, and it
    // arrives as a plain TypeError from fetch rather than as anything with a code.
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new OpenRouterError("no response", 0))).toBe(true);
  });

  test("a deliberate cancellation is NOT retried", () => {
    // Someone already decided to stop. Trying again would be overruling them.
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(isTransient(abort)).toBe(false);
  });
});

describe("retryableStream", () => {
  test("retries a transient failure that happened before anything was shown", async () => {
    let attempts = 0;
    const out = await retryableStream(
      async () => {
        attempts++;
        if (attempts === 1) throw new OpenRouterError("bad gateway", 502);
        return "answered";
      },
      () => false,
    );
    expect(out).toBe("answered");
    expect(attempts).toBe(2);
  });

  test("does NOT retry once tokens have reached the reader", async () => {
    /*
      The case this whole guard exists for. A replay would re-send an answer whose first half
      is already on the reader's screen, and the two halves would be spliced into one bubble
      that reads as the model stuttering.
    */
    let attempts = 0;
    let emitted = false;
    const run = retryableStream(
      async () => {
        attempts++;
        emitted = true; // the first delta went out
        throw new OpenRouterError("connection reset mid-stream", 0);
      },
      () => emitted,
    );
    await expect(run).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test("gives up after the policy's attempts rather than looping", async () => {
    let attempts = 0;
    const run = retryableStream(
      async () => {
        attempts++;
        throw new OpenRouterError("still down", 503);
      },
      () => false,
    );
    await expect(run).rejects.toThrow();
    // THREE CALLS, from `maxAttempts: 2`. The setting counts retries, not calls -- the
    // original comment claimed 3 from `maxAttempts: 3` and this assertion is what caught it.
    expect(attempts).toBe(3);
  });

  test("a 4xx is not retried even before anything is shown", async () => {
    let attempts = 0;
    const run = retryableStream(
      async () => {
        attempts++;
        throw new OpenRouterError("bad request", 400);
      },
      () => false,
    );
    await expect(run).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("describeFailure", () => {
  test("names the status so an operator can act on it", () => {
    expect(describeFailure(new OpenRouterError("rate limited", 429))).toContain("status=429");
  });

  test("is bounded, because an upstream body can be enormous", () => {
    const huge = new OpenRouterError("x".repeat(10_000), 500);
    expect(describeFailure(huge).length).toBeLessThan(400);
  });
});
