/**
 * The assistant panel's pure rules: what a number reads as, and what a list of tool calls
 * is called.
 *
 * Split out for the same reason `facet-panes.ts` is split from the panes: none of this
 * needs a DOM to be right or wrong, and the two rules worth defending -- a `null` score is
 * never a zero, and a request is never described vaguely -- are testable as strings.
 */

import type { AgentRequested, AgentToolCall } from "./agent-api";
import { formatAge } from "./timestamps";

/** `S02E09`. Zero-padded so a season list lines up, which is the whole point of the form. */
export function episodeCode(season: number, number: number): string {
  const pad = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(2, "0");
  return `S${pad(season)}E${pad(number)}`;
}

/**
 * WHAT AN ABSENT SCORE SAYS, and it is the one rule in this file worth a comment.
 *
 * IMDb has no rating for an episode nobody has voted on, and `null` is that answer. Every
 * shortcut for rendering it -- `?? 0`, `?.toFixed(1) ?? ""`, an empty cell -- reads on
 * screen as a score of zero beside episodes scoring 8.9, which is a claim about the episode
 * that we invented. Saying so in words is the only honest option.
 */
export function episodeScore(rating: number | null): string {
  return rating === null ? "no score yet" : rating.toFixed(1);
}

/** Is that a real score, or the sentence standing in for one? Decides which style it wears. */
export function hasScore(rating: number | null): boolean {
  return rating !== null;
}

/**
 * What the assistant DID, in the summary line of the collapsed disclosure.
 *
 * The count and the total time, because those are the two things worth seeing without
 * opening it: whether it looked anything up at all, and whether the wait was its own
 * thinking or ours.
 */
export function toolCallSummary(calls: readonly AgentToolCall[]): string {
  const total = calls.reduce((sum, c) => sum + (Number.isFinite(c.ms) ? c.ms : 0), 0);
  const noun = calls.length === 1 ? "1 lookup" : `${calls.length} lookups`;
  return `${noun} · ${formatDuration(total)}`;
}

/**
 * An argument object on one line, for the disclosure body.
 *
 * Truncated hard, because a tool call's arguments are diagnostics rather than content and a
 * 900-character blob would push the answer off the screen it belongs on.
 */
export function formatToolArgs(args: Record<string, unknown>, max = 140): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "{}";
  } catch {
    // A cyclic object cannot come off the wire, but the API's own type says
    // `Record<string, unknown>` and this runs inside a render.
    return "{…}";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `412ms` under a second, `2.4s` over it. Nothing here is ever worth a minute. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * What one turn cost, in dollars.
 *
 * Four decimals because a turn is routinely a fraction of a cent and `$0.00` for every
 * answer would make the number pointless. Under a hundredth of a cent it says so rather
 * than rounding to nothing.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "—";
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}

/**
 * When the budget comes back, in the reader's own words.
 *
 * `formatAge` (`./timestamps.ts`) is the owner of turning a delta into "in 2 hours", so
 * this converts the contract's seconds into the instant it already takes rather than
 * growing a second relative formatter beside it. `now` is a parameter for the same reason
 * it is one there.
 */
export function retryPhrase(seconds: number, now: Date = new Date()): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return formatAge(new Date(now.getTime() + seconds * 1000).toISOString(), now);
}

/**
 * The sentence for something the assistant ASKED FOR, and it is deliberately blunt.
 *
 * A request spends disk and bandwidth and cannot be undone from this panel, so the reader
 * has to be able to tell at a glance that one happened -- "Requested" beside a title is a
 * word that could equally mean it looked one up. The noun follows the KIND, because
 * "started downloading a series" and "an episode" are different sizes of commitment.
 */
const REQUESTED_NOUN: Record<AgentRequested["kind"], string> = {
  movie: "film",
  series: "series",
  episode: "episode",
};

export function requestedNoun(kind: AgentRequested["kind"]): string {
  return REQUESTED_NOUN[kind] ?? "title";
}

export function requestedHeading(requested: readonly AgentRequested[]): string {
  if (requested.length === 1) {
    return `Started downloading 1 ${requestedNoun(requested[0].kind)}`;
  }
  return `Started downloading ${requested.length} titles`;
}
