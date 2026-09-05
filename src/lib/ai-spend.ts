/**
 * The daily AI budget: how much one person may spend on model calls in a day.
 *
 * Pure -- no SQLite, no HTTP, and no clock it was not handed. The spend comes from
 * `Store.aiSpendUsd` over the `ai_call` ledger; this file owns the RULE, and only the rule.
 * Same split as `./request-quota.ts`, and deliberately the same shape, because a second
 * quota that behaved differently from the first would be two things for a reader to learn.
 *
 * > [!IMPORTANT] COUNT THE LEDGER, NEVER A COUNTER
 * > The rule `per-user-request-quota` already follows. A running total is a second owner of
 * > a fact the log already holds, it drifts on any failure between the call and the
 * > increment, and it cannot answer "why was this expensive". One row per call answers the
 * > quota, the billing question and the diagnosis with one table.
 *
 * > [!IMPORTANT] THE CHECK IS NAIVE ON PURPOSE, AND IT IS ONLY SAFE BECAUSE THE MODEL IS PINNED
 * > `if (spentToday > limit) refuse` -- no reservation, no hold, no two-phase anything. A
 * > conversation is bounded by maxTurns x maxToolCalls, so the worst overshoot past the cap
 * > is ONE conversation. Measured 2026-09-04: on `z-ai/glm-5.3-flash` that is ~$0.003, which
 * > is 0.3% of a $1 cap and therefore noise. On `anthropic/claude-fable-5.1` the same check
 * > leaks ~90%.
 * >
 * > The default moved to `meta/muse-spark-1.3-contributor` on 2026-09-05 and the bound did
 * > not loosen: measured per QUESTION it is $0.0004 against glm's $0.00085, so the same
 * > turn budget buys a cheaper worst case. The per-conversation figure has not been
 * > re-measured on it, which is safe in this direction and would not be in the other.
 * >
 * > So the cap and the model list are ONE decision. If an expensive model is added to
 * > `FINDERR_AI_MODELS`, re-check that a worst-case conversation still costs under ~1% of
 * > the cap, or this one-liner has quietly stopped being a cap.
 */

import type { Role } from "./auth";

/**
 * The day a call belongs to, in the CONTAINER'S timezone, as `YYYY-MM-DD`.
 *
 * A "day" is a day where the users are, not in UTC -- a household in Bangkok whose budget
 * resets at 07:00 local has a budget that resets in the middle of the evening they are
 * using it. That is why this is not `utcDayStart` from `./request-quota.ts`: the two
 * quotas answer to different clocks and sharing one helper would force the wrong clock on
 * one of them.
 *
 * Assembled from the local getters rather than through `toLocaleDateString`, so it depends
 * on no locale data and no ICU build: `getFullYear`/`getMonth`/`getDate` are already the
 * container's local calendar.
 */
export function localDay(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/** The next local midnight -- when the day's allowance is replenished. */
export function nextLocalMidnight(now: Date = new Date()): Date {
  // Local-time construction, so a DST boundary is the runtime's problem rather than ours.
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

/**
 * How long until the budget resets, as a DELTA a reader does not have to convert.
 *
 * aannarr, 2026-09-04: every message about the day boundary is "resets in 5h 12m" and never
 * a wall-clock time. A wall clock forces the reader to work out which timezone the server
 * meant and then subtract -- on their phone, while being told no. A delta is the answer to
 * the question they actually have.
 */
export function resetDelta(now: Date = new Date()): string {
  const ms = nextLocalMidnight(now).getTime() - now.getTime();
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Money as a person reads it. Two decimals: at the cap, the interesting digits are dollars. */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * How a conversation ended, and every one of these writes a ledger row.
 *
 * A cap that only counts successes leaks: a run that timed out on turn six spent five turns
 * of tokens, and a run that hit its turn cap spent all of them. `refused` writes a row too,
 * with `usd: 0` -- so "how often are people hitting the wall" is a question the table can
 * answer rather than one nobody logged.
 */
export type AiCallOutcome = "ok" | "error" | "max_turns" | "max_tool_calls" | "refused";

/** One row of the ledger. Mirrors the `ai_call` columns exactly; see `./store.ts`. */
export interface AiCallRow {
  userId: string;
  convId: string;
  /** ISO 8601, UTC. WHEN, unambiguously. */
  at: string;
  /** `YYYY-MM-DD` in the container's TZ. WHICH DAY'S BUDGET this came out of. */
  day: string;
  model: string;
  tokIn: number;
  tokOut: number;
  tokCached: number;
  usd: number;
  ms: number;
  outcome: AiCallOutcome;
}

/**
 * Whatever writes the ledger. `Store` implements it.
 *
 * An interface rather than the class, for the same reason `SearchLogSink` is one: the rule
 * above and the mapping below are testable without standing up a database, and nothing here
 * needs to know that the ledger is SQLite.
 */
export interface AiCallSink {
  recordAiCall(row: AiCallRow): void;
  /** Total USD this person has spent on the given local day. */
  aiSpendUsd(userId: string, day: string): number;
}

/** The shape of a finished run, as much of it as the ledger cares about. */
export interface ChargeableRun {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  ms: number;
  failure?: "max_turns" | "max_tool_calls" | "error";
}

/** What a run's ending is called in the ledger. */
export function outcomeOf(run: Pick<ChargeableRun, "failure">): AiCallOutcome {
  return run.failure ?? "ok";
}

/**
 * Turn a finished run into a ledger row and write it. EVERY outcome, including the failures.
 *
 * Separate from `aiGate` because they run at opposite ends of a conversation and must not be
 * able to drift: the gate reads the ledger before the call, this writes to it afterwards,
 * and the day stamp both use comes from the same `localDay`.
 */
export function chargeRun(
  sink: AiCallSink,
  ctx: { userId: string; convId: string; now?: Date },
  run: ChargeableRun,
): AiCallRow {
  const now = ctx.now ?? new Date();
  const row: AiCallRow = {
    userId: ctx.userId,
    convId: ctx.convId,
    at: now.toISOString(),
    day: localDay(now),
    model: run.model,
    tokIn: run.promptTokens,
    tokOut: run.completionTokens,
    tokCached: run.cachedTokens,
    usd: run.costUsd,
    ms: Math.round(run.ms),
    outcome: outcomeOf(run),
  };
  sink.recordAiCall(row);
  return row;
}

/** A refusal that was never a call: the gate said no before any money was spent. */
export function chargeRefusal(
  sink: AiCallSink,
  ctx: { userId: string; convId: string; model: string; now?: Date },
): AiCallRow {
  const now = ctx.now ?? new Date();
  const row: AiCallRow = {
    userId: ctx.userId,
    convId: ctx.convId,
    at: now.toISOString(),
    day: localDay(now),
    model: ctx.model,
    tokIn: 0,
    tokOut: 0,
    tokCached: 0,
    usd: 0,
    ms: 0,
    outcome: "refused",
  };
  sink.recordAiCall(row);
  return row;
}

/**
 * `beta_admin_only` was the third of these and is GONE, not deprecated.
 *
 * Nothing produces it since the audience widened on 2026-09-05, so leaving it in the union
 * would keep every consumer carrying a branch for a refusal that cannot happen -- and the
 * client's 403 handler is exactly where a dead branch survives a rewrite unnoticed. The
 * browser still copes with an unrecognised reason, because a cached bundle can outlive a
 * deploy in either direction; see `refusalFrom`.
 */
export type AiGateReason = "not_configured" | "over_daily_limit";

export type AiGateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: AiGateReason;
      /** What the person is told. Never a wall-clock time; see `resetDelta`. */
      message: string;
      /** Present only for `over_daily_limit`. */
      spentUsd?: number;
      limitUsd?: number;
      /** Never negative -- an overshoot is $0.00 left, not minus four cents. */
      remainingUsd?: number;
      /** For `Retry-After`. At least 1, never 0 -- 0 invites an instant retry. */
      retryAfterSeconds?: number;
    };

export interface AiGateInput {
  role: Role;
  /**
   * Whether the DEPLOYMENT opted in, by providing an OpenRouter key.
   *
   * No key means the feature does not exist rather than that it failed -- the shape `tmdb`
   * already ships: read the config, log why it is going dark, offer nothing.
   */
  configured: boolean;
  /** USD per local day. Zero or less is UNLIMITED, the same reading every limit here uses. */
  limitUsd: number;
  /**
   * Reads the day's spend from the ledger.
   *
   * A thunk rather than a number, because it is a database query and the cases that skip it
   * -- no key, not an admin during the beta, an admin, no configured limit -- are the
   * ordinary ones. Injecting it is also what lets every branch below be tested without a
   * Store.
   */
  spentToday: () => number;
  now?: Date;
}

/**
 * Whether this person may make one more model call today.
 *
 * The order is deliberate and it is cheapest-first as well as most-fundamental-first: an
 * unconfigured deployment and a non-admin during the beta are both answered without
 * touching the database.
 */
export function aiGate(input: AiGateInput): AiGateVerdict {
  if (!input.configured) {
    return {
      allowed: false,
      reason: "not_configured",
      message: "The assistant is not enabled on this instance.",
    };
  }

  /*
    THE AUDIENCE IS EVERY SIGNED-IN ACCOUNT, and the only condition is the deployment key.

    aannarr, 2026-09-05: *"make assistant available to all users if key etc are set."* This
    was an ADMIN-ONLY beta until that instruction, and the paragraph that stood here argued
    at length that it must stay one until a per-account opt-in existed. That argument is
    recorded below rather than deleted, because the concern it names did not go away -- it
    was overruled, which is a different thing, and a reader who cannot tell the two apart
    will "restore" the gate as a bugfix.

    > [!IMPORTANT] WHAT WAS TRADED, so nobody re-derives it or quietly reverts it
    > A question typed into finderr is sent to a third party, so what somebody searches for
    > leaves the house. While the audience was administrators there was nobody to ask who had
    > not already consented by turning the feature on. That is no longer true: an invited
    > household member now has a box that ships their words to OpenRouter, and nothing asks
    > them first. The composer's standing note ("It can start real downloads. Kept on this
    > device only.") describes the LOCAL transcript and says nothing about the upstream call.
    >
    > The per-account opt-in is therefore still worth building and is still the right shape:
    > each account decides, and an admin enabling the feature globally does not decide for
    > anybody else. It is now a FOLLOW-UP rather than a precondition. Do not re-add a role
    > check in its place -- that is not the missing piece, and it was removed deliberately.

    What remains true is the deployment gate above: no key means the feature does not exist,
    for everybody, which is the `tmdb` shape and is unchanged.
  */

  /*
    Admins are exempt from the DAILY LIMIT and from nothing else.

    They still need the deployment key, they are still logged to the same ledger, and they
    still run under the same turn caps. The exemption is narrow on purpose: an admin
    benchmarking a model is the person most likely to spend, and the person least likely to
    be doing it by accident.

    > [!IMPORTANT] THE CAP IS LIVE FOR THE FIRST TIME, AND NOTHING BELOW HAS EVER FIRED IN PRODUCTION
    > While the audience was administrators and administrators were exempt, the two decisions
    > composed into NOBODY BEING CAPPED -- every branch under here was reachable and
    > unit-tested and none of it ran. Widening the audience is what switches it on, per
    > account, at `ai.dailyLimitUsd` (default $1/day, and `FINDERR_AI_DAILY_LIMIT_USD` is not
    > set on the live deployment as of 2026-09-05, so the default is what applies).
    >
    > `spentToday` is scoped to ONE user id by every caller, so this is a per-account budget
    > rather than a shared pot -- one person exhausting theirs does not refuse anybody else.
  */
  if (input.role === "admin") return { allowed: true };

  return dailyCapVerdict(input);
}

/**
 * The money half of the gate, on its own.
 *
 * Split out because during the admin-only beta `aiGate` can never reach it: the only people
 * who pass the role check are the people exempt from the cap. A rule that production cannot
 * execute is a rule that rots, so it is a function with its own tests rather than a branch
 * nothing runs -- and when the audience widens, widening is deleting one early return above
 * rather than writing this.
 *
 * The check is `spent > limit`: landing exactly on the cap has not exceeded it.
 */
export function dailyCapVerdict(input: {
  limitUsd: number;
  spentToday: () => number;
  now?: Date;
}): AiGateVerdict {
  // Zero or less is unlimited, matching `RateLimiter.take` and `quotaVerdict`. It also makes
  // a typo that lands a 0 in the env open the gate rather than lock everybody out.
  if (input.limitUsd <= 0) return { allowed: true };

  const spent = input.spentToday();
  if (spent <= input.limitUsd) return { allowed: true };

  const now = input.now ?? new Date();
  const remaining = Math.max(0, input.limitUsd - spent);
  const msLeft = nextLocalMidnight(now).getTime() - now.getTime();
  return {
    allowed: false,
    reason: "over_daily_limit",
    spentUsd: spent,
    limitUsd: input.limitUsd,
    remainingUsd: remaining,
    retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)),
    message:
      `Daily AI budget spent -- ${usd(spent)} of ${usd(input.limitUsd)} used today, ` +
      `${usd(remaining)} left. Resets in ${resetDelta(now)}. ` +
      "Search, browse and requests are unaffected.",
  };
}
