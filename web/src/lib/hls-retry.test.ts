/**
 * A "not ready" 404 from the transcoder is retried; an auth refusal is not.
 *
 * Regression for `hls-js-never-retries-a-404-so-a-back-pressure-refusal-on-a-s`: hls.js 1.7.2
 * refuses to retry ANY 4xx (`retryForHttpStatus` in its `utils/error-helper.ts`), while this
 * server answers a segment it declined to start right now -- back-pressure during a scrub -- with
 * a 404 precisely so that it would be retried. Every such refusal was final for the player.
 */

import { describe, expect, test } from "bun:test";
import { NOT_READY_RETRIES, retryingNotReady, retryNotReady } from "./hls-retry";

describe("decorating hls.js's default policy", () => {
  test("keeps its timeouts and delays, and changes only the error-retry count and rule", () => {
    const shipped = {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
      },
    };
    const policy = retryingNotReady(shipped);
    expect(policy.default.maxLoadTimeMs).toBe(120_000);
    expect(policy.default.timeoutRetry).toEqual(shipped.default.timeoutRetry);
    expect(policy.default.errorRetry).toMatchObject({
      maxNumRetry: NOT_READY_RETRIES,
      retryDelayMs: 1000,
      maxRetryDelayMs: 8000,
      shouldRetry: retryNotReady,
    });
    // The library's own object is not mutated.
    expect(shipped.default.errorRetry.maxNumRetry).toBe(6);
  });
});

const budget = { maxNumRetry: 8 };

describe("what hls.js refuses, we retry only when it is the server saying 'not yet'", () => {
  test("a 404 is retried inside the budget, even though hls.js said no", () => {
    expect(retryNotReady(budget, 0, false, { code: 404 }, false)).toBe(true);
    expect(retryNotReady(budget, 7, false, { code: 404 }, false)).toBe(true);
  });

  test("and not past the budget", () => {
    expect(retryNotReady(budget, 8, false, { code: 404 }, false)).toBe(false);
  });

  test("an auth refusal stays final -- retrying a 401 or 403 is a storm against a closed door", () => {
    expect(retryNotReady(budget, 0, false, { code: 401 }, false)).toBe(false);
    expect(retryNotReady(budget, 0, false, { code: 403 }, false)).toBe(false);
  });

  test("whatever hls.js already retries, it still retries", () => {
    expect(retryNotReady(budget, 0, false, { code: 500 }, true)).toBe(true);
    expect(retryNotReady(budget, 0, true, undefined, true)).toBe(true);
  });
});
