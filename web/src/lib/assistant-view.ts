/**
 * The assistant panel's pure rules: what a number reads as, and what a list of tool calls
 * is called.
 *
 * Split out for the same reason `facet-panes.ts` is split from the panes: none of this
 * needs a DOM to be right or wrong, and the two rules worth defending -- a `null` score is
 * never a zero, and a request is never described vaguely -- are testable as strings.
 */

import type { AgentRequested, AgentToolCall, RequestedStatus } from "./agent-api";
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

// --- a tool call, in a reader's words --------------------------------------

/**
 * WHAT EACH TOOL IS CALLED ON SCREEN.
 *
 * `list_episodes` is an identifier, not a sentence, and a transcript built out of
 * identifiers reads as a log file somebody left on the page. The names come from the tool
 * DESCRIPTIONS in `src/lib/agent/schemas.ts`, shortened to the noun phrase a reader would
 * use -- "Episode list", not "Every episode of ONE series with its own IMDb score".
 *
 * A tool missing from this table falls back to its own identifier with the underscores
 * taken out, which is the forward-compatible answer: the server growing a twelfth tool must
 * put a slightly ugly row in the transcript rather than a blank one.
 */
const TOOL_LABEL: Record<string, string> = {
  find_title: "Title search",
  find_person: "People search",
  list_cast: "Cast list",
  list_credits: "Credits",
  get_title: "Title details",
  get_person: "Person details",
  browse_titles: "Browsed the index",
  find_connections: "Connection search",
  navigate: "Opened a page",
  list_episodes: "Episode list",
  request: "Download request",
};

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name.replace(/_/g, " ");
}

/**
 * The one argument worth reading in the collapsed row: WHAT it was asked about.
 *
 * A tool row saying "Title search" and nothing else is a row that could be about anything.
 * Saying `Title search · "Heat" · 1995` costs one line and turns the transcript into
 * something a reader can follow, which is the entire ask.
 *
 * The keys are per-tool and ORDERED, because the interesting argument differs: a browse is
 * described by its genre and decade, a cast list by which titles it covered. Anything not
 * named here is diagnostics and lives in the expandable detail instead.
 */
const SUBJECT_KEYS: Record<string, readonly string[]> = {
  find_title: ["name", "year", "decade"],
  find_person: ["name"],
  list_cast: ["tconst", "roles"],
  list_credits: ["nconst", "kind"],
  get_title: ["tconst"],
  get_person: ["nconst"],
  browse_titles: ["genre", "kind", "decade", "year"],
  find_connections: ["from", "to"],
  navigate: ["id"],
  list_episodes: ["tconst", "season"],
  request: ["tconst"],
};

export function toolSubject(name: string, args: Record<string, unknown>): string {
  const keys = SUBJECT_KEYS[name] ?? Object.keys(args).slice(0, 2);
  const parts: string[] = [];
  for (const k of keys) {
    if (!(k in args)) continue;
    const v = formatArgValue(args[k], 48);
    if (v) parts.push(v);
  }
  return parts.join(" · ");
}

/**
 * `min_rating` -> `min rating`, and the two id spaces get their real names.
 *
 * `tconst` and `nconst` are IMDb's words for "a title id" and "a person id" and they appear
 * nowhere a reader would have learnt them. Everything else is an underscore away from
 * English already.
 */
const ARG_LABEL: Record<string, string> = {
  tconst: "title",
  nconst: "person",
  q: "query",
  n: "count",
};

export function argLabel(key: string): string {
  return ARG_LABEL[key] ?? key.replace(/_/g, " ");
}

/**
 * One argument value, legibly -- NOT `JSON.stringify`.
 *
 * A string keeps its quotes so an empty one is visible as `""` rather than as a blank cell.
 * An array becomes a comma list, because `["actor","actress"]` on screen is punctuation a
 * reader has to parse past to reach two words. An object is the one case that stays JSON:
 * `{season: 2, episode: 9}` has no shorter honest spelling and it is rare.
 *
 * Truncated, because arguments are context rather than content -- a 900-character blob
 * would push the answer off the screen it belongs on.
 */
export function formatArgValue(value: unknown, max = 120): string {
  if (value === null || value === undefined) return "—";
  let text: string;
  if (typeof value === "string") text = `"${value}"`;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (Array.isArray(value)) text = value.map((v) => formatArgValue(v, max)).join(", ");
  else {
    try {
      text = JSON.stringify(value) ?? "—";
    } catch {
      // Cannot arrive off the wire, but this runs inside a render and the declared type is
      // `unknown`.
      return "{…}";
    }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Every argument as a `label: value` pair, for the expanded row. Order is the sender's. */
export function toolArgFields(args: Record<string, unknown>): { label: string; value: string }[] {
  return Object.entries(args).map(([k, v]) => ({ label: argLabel(k), value: formatArgValue(v) }));
}

/**
 * What a finished call gets to say about its result.
 *
 * The server's own `summary` where it sent one -- it read the payload and we did not, so a
 * count invented here would be a second, worse answer. `null` means it sent none, and the
 * row then prints only its duration rather than a guess like "done".
 */
export function toolResultText(
  summary: string | null | undefined,
  error: string | null | undefined,
): string | null {
  if (error) return error;
  return summary && summary.trim().length > 0 ? summary.trim() : null;
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

/**
 * The two halves of a `requested` list, and splitting them is not cosmetic.
 *
 * `queued` is the only status that spent anything. The other four -- we already have it,
 * somebody already asked, the id did not resolve, the arr said no -- are things the
 * assistant TRIED and did not do, and drawing them under "Started downloading" would be a
 * claim about disk and bandwidth that nobody can check from the panel.
 *
 * **An ABSENT status counts as queued.** The contract this client was built against carried
 * no status at all, so treating "did not say" as a refusal would silently demote every real
 * download on such a server to a footnote -- the more dangerous of the two mistakes.
 */
export function queuedOf(requested: readonly AgentRequested[]): AgentRequested[] {
  return requested.filter((r) => (r.status ?? "queued") === "queued");
}

export function declinedOf(requested: readonly AgentRequested[]): AgentRequested[] {
  return requested.filter((r) => (r.status ?? "queued") !== "queued");
}

/**
 * What each non-`queued` status says, in a reader's words rather than the enum's.
 *
 * `refused` deliberately does not try to say WHY: the reason travels in `RequestOutcome`
 * but not on this payload, and the model has already been told to relay it in the prose
 * above -- inventing a cause here would be a second, worse answer beside a real one.
 */
const DECLINED_PHRASE: Record<Exclude<RequestedStatus, "queued">, string> = {
  already_have: "already in your library",
  already_requested: "already requested",
  not_found: "not found",
  refused: "refused",
};

export function declinedPhrase(status: RequestedStatus | undefined): string {
  return status && status !== "queued" ? (DECLINED_PHRASE[status] ?? "not requested") : "not requested";
}

/** `S02E09` for an episode grain, or null for a whole title. Both fields or neither. */
export function requestedDetail(r: AgentRequested): string | null {
  return r.season !== undefined && r.episode !== undefined ? episodeCode(r.season, r.episode) : null;
}

/**
 * The heading over the things that ACTUALLY went out.
 *
 * Counts the queued list, never the whole `requested` array -- a turn that tried four and
 * queued one says one.
 */
export function requestedHeading(queued: readonly AgentRequested[]): string {
  if (queued.length === 1) {
    return `Started downloading 1 ${requestedNoun(queued[0].kind)}`;
  }
  return `Started downloading ${queued.length} titles`;
}

// --- the thinking disclosure's open/closed rule -----------------------------

/**
 * WHETHER A THINKING BLOCK IS OPEN, as a state machine rather than as a boolean.
 *
 * It has to satisfy three things that pull against each other: open itself while the tokens
 * are arriving, fold itself away when they stop, and never overrule a reader who clicked.
 * Two booleans and a nullable third is the whole of it, and it is here rather than inline in
 * the component because the failure below is invisible to a render test.
 *
 * > [!CAUTION] `<details>` FIRES `toggle` FOR ITS OWN ATTRIBUTE, NOT ONLY FOR A HUMAN
 * > This shipped without `sync` for about an hour on 2026-09-05 and was caught by driving a
 * > real turn in a browser, not by the suite: React setting `open` on a live block fires
 * > `toggle`, `toggled` latched `true`, and the block could then never fold -- a settled
 * > answer buried under three open blocks of working, which is the exact state the file
 * > header says must not happen. There is no `isTrusted` to filter on; a programmatic
 * > toggle and a real one are the same event.
 * >
 * > So a CHANGE in `live` spends the reader's choice. It is the only thing that does.
 */
export interface Disclosure {
  /** What the reader last chose, or `null` if they have not chosen since `live` changed. */
  choice: boolean | null;
  /** What `live` was when `choice` was recorded, so a change to it can be noticed. */
  seenLive: boolean;
}

export function disclosureFor(live: boolean): Disclosure {
  return { choice: null, seenLive: live };
}

/** The stream started or stopped writing this block: whatever was chosen was about the other state. */
export function syncDisclosure(d: Disclosure, live: boolean): Disclosure {
  return d.seenLive === live ? d : { choice: null, seenLive: live };
}

/** The reader (or React) moved the disclosure. */
export function toggleDisclosure(d: Disclosure, open: boolean): Disclosure {
  return { ...d, choice: open };
}

/** Open while it is being written, unless the reader has said otherwise since. */
export function disclosureOpen(d: Disclosure, live: boolean): boolean {
  return syncDisclosure(d, live).choice ?? live;
}
