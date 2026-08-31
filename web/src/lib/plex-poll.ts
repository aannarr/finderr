/**
 * Waiting for somebody to finish approving a PIN on plex.tv.
 *
 * Plex's PIN flow has no callback we can receive: the browser is sent to plex.tv, the user
 * types a password there, and the only way to learn that it worked is to keep asking. Both
 * ceremonies do it -- signing IN (`AuthScreen`) and LINKING an account you are already
 * signed in to (`AccountRoute`) -- and the loop is identical in both because it is a
 * property of Plex rather than of either screen.
 *
 * Pure and injectable, with `sleep` as a parameter, so the timing rules are tested against
 * a fake clock rather than by waiting five real minutes. Same shape and same reason as
 * `pollWhileWorking` in `./use-title-detail.ts`.
 */

/**
 * How long to wait between asks.
 *
 * Somebody is typing a password on another site; there is nothing to be gained by asking
 * faster, and Plex is not our infrastructure to poll hard.
 */
export const PLEX_POLL_INTERVAL_MS = 2000;

/**
 * How many times to ask before giving up -- five minutes at the interval above.
 *
 * Generous on purpose: the slow path here is a person finding their password manager, not
 * a network. It is a cap rather than a deadline, so that a tab left open overnight stops
 * asking rather than polling until the laptop closes.
 */
export const PLEX_POLL_ATTEMPTS = 150;

export interface PlexPollOptions {
  attempts?: number;
  intervalMs?: number;
  /** Injected by tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** The answer, or the fact that we ran out of patience. Never a thrown timeout. */
export type PlexPollResult<T> = { done: T } | { timedOut: true };

/**
 * Ask until the answer stops being `pending`.
 *
 * An error is NOT swallowed -- it propagates, because a refusal from the server ("that Plex
 * account cannot be connected") is a final answer that both callers show and neither should
 * retry 149 more times. Only `{ pending: true }` means keep going.
 */
export async function pollPlexPin<T extends { pending?: boolean }>(
  ask: () => Promise<T>,
  opts: PlexPollOptions = {},
): Promise<PlexPollResult<T>> {
  const attempts = opts.attempts ?? PLEX_POLL_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? PLEX_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < attempts; i++) {
    const res = await ask();
    if (!res.pending) return { done: res };
    // No sleep after the LAST attempt: waiting two seconds to then give up anyway is two
    // seconds of a spinner that was never going to become an answer.
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { timedOut: true };
}
