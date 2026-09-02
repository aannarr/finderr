/**
 * The daily request quota: how many titles one person may ask for in a UTC day.
 *
 * Pure -- no SQLite, no HTTP, and no clock it was not handed. The count comes from
 * `Store.countRequestsSince` and the refusal is turned into a 429 by `/api/requests` in
 * `../server/index.ts`; this file owns the RULE, and only the rule.
 *
 * > [!IMPORTANT] A quota is not a rate limit, and merging the two would break both
 * > `RateLimiter` (`./rate-limit.ts`) counts HTTP calls per IP per minute, in memory, and
 * > forgets everything on restart. That is right for defending a CPU-bound search and a
 * > guessable bearer token, and useless here: a quota is a fact about a PERSON over a DAY,
 * > it has to survive a restart, and it is measured in titles rather than in calls. Both
 * > are wanted, and they answer different questions.
 *
 * > [!NOTE] The quota counts TITLES, and the request log is what makes that true
 * > `request` is uniquely keyed on `tconst`, so a series requested with three seasons is
 * > one row, and clicking Request again on something already queued does not spend a
 * > second unit. That is the rule the card asked for -- "one request = one title" -- and
 * > deriving the count from the log is what makes it hold by construction rather than by
 * > arithmetic somebody has to keep correct. See `Store.countRequestsSince`.
 */

import type { Role } from "./auth";

const DAY_MS = 86_400_000;

/**
 * The start of the UTC day `now` falls in, spelled exactly as `request.created_at` is.
 *
 * Both are `new Date().toISOString()` output, so `created_at >= utcDayStart()` is a plain
 * string comparison and SQLite can answer it without parsing a date. That is the whole
 * reason every timestamp column in this schema is TEXT -- see `isExpired` in `./auth.ts`,
 * which leans on the same property.
 */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** When the current day's allowance is replenished: the next UTC midnight. */
export function utcDayReset(now: Date = new Date()): string {
  return new Date(Date.parse(utcDayStart(now)) + DAY_MS).toISOString();
}

/**
 * Whether this person may ask for one more title today.
 *
 * A discriminated union rather than a boolean plus out-parameters: the refusal carries
 * everything the 429 needs, so the route cannot assemble a message from a state the rule
 * did not actually reach.
 */
export type QuotaVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Titles already asked for since the last UTC midnight. */
      used: number;
      limit: number;
      /** ISO instant of the next UTC midnight. */
      resetsAt: string;
      /** For the `Retry-After` header. At least 1, never 0 -- 0 invites an instant retry. */
      retryAfterSeconds: number;
      /** What the caller is told. Names the limit and the reset, as the card asked. */
      message: string;
    };

export function quotaVerdict(input: {
  role: Role;
  /** Titles per UTC day. Zero or less is UNLIMITED. */
  limit: number;
  /**
   * Reads the count of titles this person has asked for today.
   *
   * A thunk rather than a number, because it is a database query and the two cases that
   * do not need it -- no configured limit, and an admin -- are the ordinary ones. Injecting
   * it is also what lets every branch below be tested without a Store.
   */
  usedToday: () => number;
  now?: Date;
}): QuotaVerdict {
  /*
    Zero or less means UNLIMITED, not "refuse everything".

    The same reading `RateLimiter.take` already uses, so there is one convention here and
    not two. It also makes the default safe: an operator who has never heard of this
    setting keeps the behaviour every version so far has had, and a typo that lands a 0 in
    the env opens the gate rather than locking every user out of the product.
  */
  if (input.limit <= 0) return { allowed: true };

  // Admins are exempt. `admin` is the set of people who administer the library rather than
  // ask it for things -- see `Role` in `./auth.ts` -- and an admin who cannot refill their
  // own library because they spent the day filling it is a limit pointed the wrong way.
  if (input.role === "admin") return { allowed: true };

  const used = input.usedToday();
  if (used < input.limit) return { allowed: true };

  const now = input.now ?? new Date();
  const resetsAt = utcDayReset(now);
  return {
    allowed: false,
    used,
    limit: input.limit,
    resetsAt,
    retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(resetsAt) - now.getTime()) / 1000)),
    message:
      `daily request limit reached -- ${used} of ${input.limit} titles since 00:00 UTC. ` +
      `Your quota resets at ${resetsAt}.`,
  };
}
