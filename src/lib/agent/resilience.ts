/**
 * What happens when OpenRouter has a bad minute.
 *
 * Until this existed a single flaky response killed a turn outright: the runner caught the
 * throw, returned `failure: "error"`, and the reader got "The assistant could not answer."
 * for something a second attempt would have answered. That is the wrong shape for a
 * third-party HTTP call -- especially one that routes to whichever upstream is healthy, so a
 * transient 502 is genuinely a different provider away from working.
 *
 * Every policy here is `cockatiel`, per the standing rule: do not hand-roll a timeout, a
 * retry or a breaker in this repo.
 *
 * > [!IMPORTANT] ONLY RETRY WHAT IS ACTUALLY TRANSIENT, AND A 4xx IS NOT
 * > `isTransient` is the whole of the judgement. A 429 or a 5xx is worth trying again; a 400
 * > (a malformed tool schema), a 401 (a wrong key) and a 402 (out of credit) will fail
 * > identically forever, and retrying them turns one clear error into three slow ones and
 * > triples the latency in front of a reader who is already going to be told no.
 *
 * > [!CAUTION] A STREAMING CALL IS NOT SAFE TO RETRY ONCE IT HAS EMITTED
 * > A retry replays the whole request, and the tokens from the first attempt have already
 * > been sent to the browser -- so a naive retry mid-stream renders the answer twice, spliced.
 * > `retryableStream` therefore only retries while NOTHING has been emitted yet: a failure
 * > during the connection or before the first delta is safe, a failure after it is final.
 * > This is why the guard is a mutable flag rather than a policy option; cockatiel cannot
 * > know what our caller has already written to a socket.
 */

import { ExponentialBackoff, handleWhen, retry } from "cockatiel";
import { OpenRouterError } from "./openrouter.js";

/**
 * Worth trying again?
 *
 * A network error (no status at all) counts: DNS, a reset connection, a TLS hiccup. Those
 * are the most common transient failures and they arrive as a plain `TypeError` from fetch
 * rather than as anything with a code.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof OpenRouterError) {
    // 0 is our own "no status" marker -- a thrown-before-response failure.
    if (err.status === 0) return true;
    if (err.status === 429) return true;
    return err.status >= 500 && err.status < 600;
  }
  // Anything that is not an OpenRouterError got past the status check entirely, which means
  // it never got a response. `AbortError` is excluded because a deliberate cancellation is
  // not a failure to retry -- it is a decision somebody already made.
  if (err instanceof Error && err.name === "AbortError") return false;
  return err instanceof Error;
}

/**
 * Two retries, exponentially backed off, jittered. THREE calls in total.
 *
 * > [!IMPORTANT] `maxAttempts` IS A COUNT OF RETRIES, NOT OF CALLS
 * > Measured, because the name reads the other way and this comment said the wrong thing
 * > until a test counted: `maxAttempts: 3` invokes the function FOUR times. It is 2 here so
 * > that a failing call is attempted three times, which is what the paragraph below argues
 * > for. A test pins the number precisely because the setting cannot be read at face value.
 *
 * A fourth call buys very little -- an upstream still failing after two backed-off retries is
 * having an outage rather than a blip -- and every attempt is paid for in latency by a person
 * watching a spinner.
 *
 * The jitter matters more here than it looks: several people asking at once during a
 * provider wobble would otherwise retry in lockstep and hit the recovering upstream as one
 * synchronised burst, which is how a blip becomes an outage. cockatiel's exponential backoff
 * is jittered by default; this names it so nobody "simplifies" it to a fixed delay.
 */
export const openRouterRetry = retry(handleWhen(isTransient), {
  maxAttempts: 2,
  backoff: new ExponentialBackoff({ initialDelay: 400, maxDelay: 4_000 }),
});

/**
 * Run a STREAMING call under the retry policy, giving up the moment anything has been shown.
 *
 * `hasEmitted` is read at failure time rather than captured, because the whole question is
 * whether the attempt that just died had already written to the reader's socket.
 *
 * Returns the result, or rethrows the last error. It deliberately does NOT swallow: the
 * caller owns the ledger row and the user-facing message, and a resilience helper that
 * silently returned a fake answer would be worse than the failure it hid.
 */
export async function retryableStream<T>(
  attempt: () => Promise<T>,
  hasEmitted: () => boolean,
  onRetry?: (err: unknown, attemptNumber: number) => void,
): Promise<T> {
  let n = 0;
  return openRouterRetry.execute(async () => {
    n++;
    if (n > 1) {
      // Anything already on the wire makes a replay a splice, so stop and let the original
      // error stand. Throwing a NON-transient error is how the policy is told to give up.
      if (hasEmitted()) {
        throw new OpenRouterError("stream failed after output had already been sent", 400);
      }
      onRetry?.(undefined, n);
    }
    return attempt();
  });
}

/**
 * A one-line, credential-free description of a failure, for the log.
 *
 * NEVER goes to the browser. An upstream error body can quote the request -- including a URL
 * with a query string -- which is the exact leak `safeUrl` exists for elsewhere. The reader
 * gets a fixed sentence; the operator gets this.
 */
export function describeFailure(err: unknown): string {
  if (err instanceof OpenRouterError) {
    return `openrouter status=${err.status} ${err.message.slice(0, 300)}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 300)}`;
  return String(err).slice(0, 300);
}
