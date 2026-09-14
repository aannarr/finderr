/**
 * Retrying a segment the server has not made yet -- which hls.js, left alone, never does.
 *
 * > [!CAUTION] hls.js REFUSES TO RETRY ANY 4xx, and this server's "not yet" IS a 404
 * > `retryForHttpStatus` in hls.js 1.7.2 (`src/utils/error-helper.ts`) returns false for every
 * > status from 400 to 499. The transcoder answers a segment it declined to START right now --
 * > back-pressure while somebody drags the scrubber -- with a 404 so that the player comes back
 * > for it (`playback-routes.ts`). So every one of those refusals was final: the player gave up
 * > on a segment that would have existed half a second later. The comments on both sides said
 * > "hls.js retries a 404", and it never did. Found reading hls.js's source on 2026-09-15.
 * >
 * > A 503 instead would be retried by hls.js, but the endpoint ring (`hls-candidate-loader.ts`)
 * > reads a 5xx as a dead PATH and would rotate away from an address that is working. So the
 * > status stays and the client is taught what it means.
 *
 * Only a 404 is added. 401 and 403 stay final: a stream token that has lapsed is not fixed by
 * asking again, and eight retries against a closed door is a storm.
 *
 * Plain structural types rather than hls.js imports, so this is testable without the library.
 */

/** How many times a "not ready" segment, playlist or manifest is asked for again. */
export const NOT_READY_RETRIES = 8;

export interface RetryConfigLike {
  maxNumRetry: number;
}

export interface LoaderResponseLike {
  code?: number;
}

/**
 * hls.js's `RetryConfig.shouldRetry`: its own verdict arrives as `hlsWouldRetry`, and this only
 * ever widens it -- to a 404 inside the budget.
 */
export function retryNotReady(
  retryConfig: RetryConfigLike,
  retryCount: number,
  _isTimeout: boolean,
  response: LoaderResponseLike | undefined,
  hlsWouldRetry: boolean,
): boolean {
  if (hlsWouldRetry) return true;
  return response?.code === 404 && retryCount < retryConfig.maxNumRetry;
}

interface PolicyLike {
  default: { errorRetry: object | null } & Record<string, unknown>;
}

/**
 * A copy of one of hls.js's default load policies that retries "not ready".
 *
 * Built FROM the library's defaults rather than written out, so the timeouts and delays stay
 * whatever the installed hls.js ships -- including the 120 s segment load budget, which covers
 * a software re-encode of one segment. Only the error-retry count and the retry rule change.
 */
export function retryingNotReady<P extends PolicyLike>(policy: P, maxNumRetry = NOT_READY_RETRIES): P {
  const errorRetry = policy.default.errorRetry ?? { retryDelayMs: 1000, maxRetryDelayMs: 8000 };
  return {
    ...policy,
    default: { ...policy.default, errorRetry: { ...errorRetry, maxNumRetry, shouldRetry: retryNotReady } },
  };
}
