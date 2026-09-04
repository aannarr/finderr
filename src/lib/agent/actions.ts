/**
 * The one thing the agent can DO rather than read.
 *
 * Every other tool in this directory is pure over local SQLite. `request` reaches Radarr and
 * Sonarr and genuinely starts downloads, so it is the only place in the agent surface where
 * a hallucination costs something that has to be undone by hand.
 *
 * aannarr chose EXECUTE over propose-then-confirm on 2026-09-04, with the fan-out risk stated
 * in front of him. That decision is honoured here: nothing in this file asks a human to
 * approve anything. What it does instead is make the blast radius COUNTABLE and BOUNDED, on
 * the grounds that a decision to skip confirmation is not a decision to skip arithmetic.
 *
 * > [!IMPORTANT] THE CAP IS A RUNAWAY GUARD, NOT A CONFIRMATION GATE
 * > It exists because "request every good Star Trek episode" is one sentence that resolves to
 * > nine series and several hundred episodes, and because a model that misreads a filter can
 * > emit that fan-out believing it is being helpful. The cap does not ask permission and it
 * > does not pause -- it refuses the tail of a batch that has already gone past what any
 * > single answer should be allowed to start, and it TELLS THE MODEL it was truncated so the
 * > answer says so too.
 * >
 * > A silent truncation would be worse than no cap at all: the reader would be told they got
 * > everything. So `capped` rides in the result and the system prompt requires reporting it.
 *
 * The capability is OPTIONAL on `AgentContext`. A context without it does not merely refuse
 * `request` -- it is never OFFERED the tool at all (`toolSchemasFor`), which is what keeps
 * the benchmark harness honestly read-only rather than measuring a model's response to a
 * permanent error.
 */

/** A grain of thing that can be asked for. The three the request routes already support. */
export type RequestGrain = "movie" | "series" | "episode";

/** One thing the agent asked for, and what actually happened to it. */
export interface RequestOutcome {
  tconst: string;
  title: string;
  grain: RequestGrain;
  /** Season and episode, for the episode grain only. */
  season?: number;
  episode?: number;
  /**
   * `queued` is the only success. Everything else is a refusal the MODEL should read and
   * report rather than retry -- none of them become true by asking again in the same run.
   */
  status: "queued" | "already_have" | "already_requested" | "not_found" | "refused";
  /** Why, when it is not `queued`. Written for a model to relay to a person. */
  reason?: string;
}

export interface RequestResult {
  results: RequestOutcome[];
  /** How many were queued. The number the answer should lead with. */
  queued: number;
  /**
   * Set when the cap truncated the batch. NEVER omit this from the answer.
   *
   * `asked` is what the model tried to request, `limit` is what it was allowed; the
   * difference is what was silently NOT started, and saying so is the whole point.
   */
  capped?: { asked: number; limit: number; remaining: number };
}

/**
 * How much one CONVERSATION may start.
 *
 * Per conversation rather than per call, so a model cannot walk around it by making five
 * calls of twenty. It is deliberately generous enough that an honest "get me season 3"
 * never touches it and tight enough that a runaway is capped inside one answer.
 *
 * This is NOT the daily request quota. That one is per PERSON per DAY, lives in
 * `../request-quota.ts`, is counted from the request log, and still applies underneath this
 * -- a user at their daily limit is refused by it whatever this says. Two different
 * questions: "is this person allowed more today" and "did this one answer run away".
 */
export const MAX_REQUESTS_PER_CONVERSATION = 40;

/**
 * The write capability, as the tool layer sees it.
 *
 * An interface rather than a concrete class because the implementation needs the store, the
 * request worker, the live index and the asking principal -- none of which belong in
 * `AgentContext`, and all of which the server already has wired. `src/server/agent-actions.ts`
 * implements it; the tools stay testable against a fake.
 */
export interface AgentActions {
  /** Ask for whole titles. A film or a series; the grain the front page's button uses. */
  requestTitles(tconsts: string[]): RequestOutcome[];
  /**
   * Ask for individual episodes of ONE series.
   *
   * Takes `(season, number)` pairs rather than episode ids, because the ids the agent can see
   * come from the IMDb index and the ids Sonarr needs come from its own mirror. Season and
   * number are the only thing both agree on, and the implementation does that join -- against
   * the mirror, which is the authority on what aired and what we hold.
   */
  requestEpisodes(parent: string, episodes: { season: number; number: number }[]): RequestOutcome[];
  /** How many more this conversation may start before the cap bites. */
  remaining(): number;
  /** Spend against the conversation budget. Called by the tool, never by the implementation. */
  spend(n: number): void;
  /**
   * Everything this conversation actually did, in order.
   *
   * THE ROUTE READS THIS RATHER THAN THE ANSWER TEXT, and that is the point: the prose is a
   * model's account of what it did, this is the record of what happened. When they disagree
   * the record is right. A model that forgets to mention a download cannot hide it from the
   * UI, and one that claims a request it never made cannot manufacture it.
   *
   * It is also why this lives on the actions object rather than on the tool trace: the trace
   * keeps only a byte count, and widening it to carry payloads would grow every tool's
   * record to serve one.
   */
  performed(): RequestOutcome[];
}

/**
 * The conversation budget, on its own so it can be tested without an arr.
 *
 * Counts DOWN from the cap and never below zero. A refusal is not a charge -- only work we
 * actually started is spent, so a batch of thirty that finds twenty already in the library
 * costs ten.
 */
export class ConversationBudget {
  private spent = 0;

  constructor(private readonly limit: number = MAX_REQUESTS_PER_CONVERSATION) {}

  remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  spend(n: number): void {
    this.spent += Math.max(0, n);
  }

  /** Split a batch into what may proceed and what the cap refuses. */
  admit<T>(items: T[]): { allowed: T[]; capped?: { asked: number; limit: number; remaining: number } } {
    const room = this.remaining();
    if (items.length <= room) return { allowed: items };
    return {
      allowed: items.slice(0, room),
      capped: { asked: items.length, limit: this.limit, remaining: room },
    };
  }
}
