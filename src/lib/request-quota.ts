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

/**
 * The start of the UTC day `daysAgo` days before the one `now` falls in.
 *
 * `utcDayStart` is this with zero and keeps its own name, because the quota's window is
 * genuinely "today" rather than "a window of one day". The people list on `/admin/users`
 * reports a seven-day one, and that second caller is what generalised this rather than
 * leaving `n * 86_400_000` spelled out in a route.
 */
export function utcDayStartDaysAgo(daysAgo: number, now: Date = new Date()): string {
  return utcDayStart(new Date(now.getTime() - daysAgo * DAY_MS));
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

/**
 * Does the daily limit bind THIS person at all?
 *
 * Two exemptions, and both are stated once here rather than re-derived by every screen that
 * wants to say "unlimited" instead of "0 of 0 today". `quotaVerdict` below is the first
 * caller and the admin user page (`GET /api/admin/users/:id`) is the second -- a page that
 * spelled `role === "admin" || limit <= 0` for itself would be a second owner of a rule that
 * decides whether a request is refused.
 *
 * - **Zero or less is UNLIMITED**, the same reading `RateLimiter.take` uses. It also makes
 *   the default safe: an operator who has never heard of this setting keeps the behaviour
 *   every version so far has had, and a typo that lands a 0 in the env opens the gate rather
 *   than locking every user out of the product.
 * - **Admins are exempt.** `admin` is the set of people who administer the library rather
 *   than ask it for things -- see `Role` in `./auth.ts` -- and an admin who cannot refill
 *   their own library because they spent the day filling it is a limit pointed the wrong way.
 */
export function quotaApplies(role: Role, limit: number): boolean {
  return limit > 0 && role !== "admin";
}

/**
 * The daily title limit that binds THIS person: their own override, else the site's.
 *
 * One owner for the fallback, and it exists because there are four readers -- the request
 * route, the assistant's request tool, the admin user page and the agent manifest -- and a
 * `??` spelled in each of them is four places to edit when the site value moves. It DID move:
 * `siteDefault` is now `SiteSettings.requestQuotaPerDay`, an operator-set value seeded from
 * `FINDERR_REQUEST_QUOTA_PER_DAY`, and the whole of that change was at this function's
 * callers -- which is what the one owner bought.
 *
 * NULL AND ZERO ARE DIFFERENT ANSWERS. Null is "I have no opinion, use the site's"; zero is
 * an explicit "unlimited for this person" that survives the operator later capping everybody
 * else. `??` rather than `||` is what keeps those apart.
 */
export function quotaLimitFor(override: number | null, siteDefault: number): number {
  return override ?? siteDefault;
}

/**
 * Is this a daily title limit somebody is allowed to type? A whole number, zero or more.
 *
 * TWO CALLERS AND THEY MUST NOT DISAGREE: the per-user override on `PATCH
 * /api/admin/users/:id`, and the site default on `PATCH /api/admin/settings`. An operator who
 * may enter 2.5 in one field and not the other is reading two different products, and the two
 * fields sit four lines apart on the same screen.
 *
 * Zero is LEGITIMATE and not empty -- it is "no limit", which `quotaApplies` above reads the
 * same way whichever of the two it came from. Negative and fractional are refused rather than
 * clamped: both are a client bug, and a limit of 2.5 titles is not a decision anybody meant.
 */
export function isQuotaValue(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0;
}

/**
 * Where one person stands against the daily limit, as a screen would say it.
 *
 * ONE shape, and the browser imports it rather than mirroring it -- the same arrangement
 * `RequestStateView` has, for the same reason: a hand-kept copy of a server shape is the
 * definition of two things that drift. `web/src/lib/auth-api.ts` re-exports it.
 *
 * `applies` is here rather than left to the reader because the two exemptions -- an admin,
 * and a limit of zero -- belong to `quotaApplies` above. A header that worked them out from
 * `limitPerDay` and a role it holds an opinion about would be a second owner of the rule that
 * decides whether a request is refused, and it would be the copy nobody updates.
 */
export interface QuotaState {
  /** Titles per UTC day binding THIS person: their override where they have one, else the site's. */
  limitPerDay: number;
  /** Titles they have already asked for since the last UTC midnight. */
  usedToday: number;
  /** ISO instant of the next UTC midnight. */
  resetsAt: string;
  /** Does the limit BIND this person at all? See `quotaApplies`. */
  applies: boolean;
}

/**
 * The same standing, plus what the SITE would give them.
 *
 * Admin-only, and separate from `QuotaState` for that reason rather than for tidiness: the
 * site default is an operator's setting, and an editor needs it to offer "follow the site
 * default (N)" as a real choice. Nobody else's screen has a use for it, so nobody else's
 * response carries it.
 */
export interface AdminQuotaState extends QuotaState {
  siteLimitPerDay: number;
}

/**
 * Build one person's standing from the two things that decide it.
 *
 * THREE ROUTES ANSWER THIS QUESTION and they must not answer it differently: the admin's view
 * of somebody, the agent manifest's account of its own budget, and the `/requests` header.
 * Each of them used to resolve the limit, count the day and stamp the reset by hand, which is
 * three copies of a four-line join -- and the reset is the one most likely to be spelled
 * slightly differently, because it is the field nothing on screen checks.
 *
 * `usedToday` is a thunk for the reason `quotaVerdict` takes one: it is a database query, and
 * injecting it is what lets every branch here be tested without a Store.
 *
 * It is called UNCONDITIONALLY, unlike in `quotaVerdict` where an exempt caller skips it. The
 * count is a fact a screen reports rather than a step in a refusal -- an admin's own page says
 * "4 today" beside "no limit", and an exempt reader who was handed a zero would be shown a
 * number that is simply false. One indexed `count(*)` is the price of that being true.
 */
export function quotaStateFor(input: {
  role: Role;
  /** This person's own override, or null to follow the site's. */
  override: number | null;
  siteDefault: number;
  usedToday: () => number;
  now?: Date;
}): QuotaState {
  const limitPerDay = quotaLimitFor(input.override, input.siteDefault);
  return {
    limitPerDay,
    usedToday: input.usedToday(),
    resetsAt: utcDayReset(input.now),
    applies: quotaApplies(input.role, limitPerDay),
  };
}

/**
 * YOUR OWN standing, as compactly as it can be said: `3 of 5 today · resets in 6 h`.
 *
 * There are three wordings of this fact in the product and they are three audiences rather
 * than three copies. `quotaVerdict`'s message is an API answer, so it names the absolute reset
 * instant a caller needs to schedule a retry. `quotaLine` on `/admin/users/:id` is one
 * administrator reading about somebody ELSE, so it is a full sentence and says something even
 * when no limit applies. This one sits above your own downloads, where "in 6 h" is what a
 * person can act on and an ISO string is noise. What all three share -- the limit, the count,
 * the reset and whether it binds -- is `QuotaState`, so they can never describe different
 * allowances however differently they are worded.
 *
 * NULL WHEN THE LIMIT DOES NOT BIND, which is the whole reason `applies` travels: a header
 * reading "0 of 0 today" at an admin is worse than one saying nothing, and "unlimited" is a
 * fact about the configuration that nobody reading their own requests needs.
 *
 * `remaining` is injected as the relative-time formatter rather than imported, because this
 * module is pure by contract and `formatRemaining` lives with the request verdicts. The
 * caller passing it is the browser, which holds the clock this is relative to.
 */
export function quotaSummary(
  quota: QuotaState,
  now: number,
  remaining: (ms: number) => string | null,
): string | null {
  if (!quota.applies) return null;
  const resets = remaining(Date.parse(quota.resetsAt) - now);
  const spent = `${quota.usedToday} of ${quota.limitPerDay} today`;
  return resets ? `${spent} · resets in ${resets}` : spent;
}

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
  // Both exemptions -- no configured limit, and an admin -- live in `quotaApplies`, which
  // the admin user page reads too. They are the ordinary cases, and neither needs the count.
  if (!quotaApplies(input.role, input.limit)) return { allowed: true };

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
