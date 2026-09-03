/**
 * What the search log actually says, as an answer to the questions it was collected for.
 *
 * The tuning card asks five things and every one of them was, until this file, a guess:
 * do people type years at all, or is the year branch dead code; how often does the fuzzy
 * tier fire rather than FTS; does anyone search in a non-English release title (that one
 * decides whether the 512 MB `title.akas` dump is worth buying); do people refine by chip
 * or by retyping; and which queries put the thing somebody wanted below the top row.
 *
 * PURE, and every collaborator is injected. Parsing is the real `parseQuery`, but the TIER
 * arrives through a `replay` function rather than by opening an index here -- so the whole
 * report can be tested against fixed rows with no 1.27M-row database, and the job that does
 * own an index is the only thing that has to construct one.
 *
 * > [!IMPORTANT] It reports; it does not retune
 * > Nothing here changes a scoring constant, and nothing here writes to the canary. The
 * > card's constraint is that a case earns its place in `CANARY_CASES` by being a query
 * > somebody actually typed -- so this names the candidates and a human decides. Promoting
 * > them automatically would be the canary grading its own homework again, one level up.
 */

import { parseQuery } from "./query-parser";
import { TIERS, type Tier } from "./search";
import type { ClickRow, SearchFilters, SearchRow } from "./search-log";
import { FILTER_KEYS, TYPING_WINDOW_MS } from "./search-log";

type FilterKey = (typeof FILTER_KEYS)[number];

/** What replaying one query against a real index says about it. */
export interface Replayed {
  tier: Tier;
  /** The title that came top, for eyeballing whether the answer was the right one. */
  top: string | null;
}

/** One query, and how often it was run. */
export interface QueryCount {
  query: string;
  n: number;
}

/** Which facet key was narrowing a search, and how often. */
export type ChipCounts = Record<FilterKey, number>;

/**
 * Q4's chip half: whether anybody uses the facet bar at all.
 *
 * Three numbers rather than one, because "nobody clicks a chip" and "everybody clicks
 * `kind` and nothing else" are different findings about the same bar.
 */
export interface ChipUsage {
  /** Searches that carried at least one chip. */
  searches: number;
  byKey: ChipCounts;
  /**
   * A search NARROWED by adding a chip: the same query text re-run with a filter it did not
   * have before. The counterpart of `retypedRefinements` -- the two together say which
   * gesture people reach for when a result set is too wide.
   */
  refinements: number;
}

/** A query whose reader had to look past the first row to find what they wanted. */
export interface RankFailure {
  query: string;
  /** The deepest rank clicked for this query. Deeper is worse. */
  worstRank: number;
  clicks: number;
  /** The title they went to, so the case can be written down as `{ query, want }`. */
  tconst: string;
}

export interface SearchReport {
  /** Epoch milliseconds of the oldest and newest logged query. Null when there are none. */
  window: { from: number; to: number } | null;
  searches: number;
  distinct: number;
  /** Q1: queries carrying a year the parser recognised. */
  withYear: number;
  /** Queries carrying a movie/series hint. */
  withKind: number;
  /** Q5: queries containing a character outside ASCII. */
  nonAscii: QueryCount[];
  /** Queries that came back with nothing at all, worst first. The clearest failures. */
  zeroResult: QueryCount[];
  /**
   * Q4, one half: a query that EXTENDS an earlier one, long after the typing window closed.
   * Somebody narrowing a search by retyping it rather than by clicking a chip.
   */
  retypedRefinements: number;
  /** Q4, the other half: how a chip was actually used, from the `filters` on a row. */
  chips: ChipUsage;
  /** Q3: which tier answered, from replay. Empty when no index was supplied. */
  tiers: Record<Tier, number>;
  mostRun: QueryCount[];
  clicks: {
    total: number;
    /** How many clicks landed at each rank, index 0 first. */
    byRank: number[];
    /** Clicks on anything but the top row -- the ranking failures, as one number. */
    belowTop: number;
  };
  /** Candidate canary cases: the real queries the scorer ranked worst. Worst first. */
  rankFailures: RankFailure[];
}

/** How many entries each "worst first" list carries. Long enough to act on, short enough to read. */
const LIST_LIMIT = 20;

function countBy(rows: readonly { query: string }[], keep: (q: string) => boolean): QueryCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!keep(r.query)) continue;
    counts.set(r.query, (counts.get(r.query) ?? 0) + 1);
  }
  return [...counts]
    .map(([query, n]) => ({ query, n }))
    .sort((a, b) => b.n - a.n || a.query.localeCompare(b.query))
    .slice(0, LIST_LIMIT);
}

/**
 * Queries that narrow an earlier one long after anybody could still be typing it.
 *
 * The typing window is what separates this from `settledSearches`, which uses the same
 * prefix test for the opposite purpose: inside the window an extension is one query being
 * typed, outside it, it is a second search that gave up on the first.
 *
 * AN UNCHANGED QUERY IS NOT A REFINEMENT, and the prefix test alone cannot say so because a
 * string starts with itself. Somebody arriving back on the same search -- from the Back
 * button, or by clicking a chip, which re-runs the identical text -- narrowed nothing by
 * typing, and counting them here would report the chip's own gesture as evidence that the
 * chips go unused.
 */
function countRetypedRefinements(rows: readonly SearchRow[]): number {
  const byTime = [...rows].sort((a, b) => a.at - b.at);
  let n = 0;
  for (let i = 1; i < byTime.length; i++) {
    const previous = byTime[i - 1].query.toLowerCase();
    const current = byTime[i].query.toLowerCase();
    if (byTime[i].at - byTime[i - 1].at <= TYPING_WINDOW_MS) continue;
    if (current !== previous && current.startsWith(previous)) n++;
  }
  return n;
}

/** Does `wider` hold every filter `narrower` holds, and fewer of them? */
function isNarrowedBy(wider: SearchFilters, narrower: SearchFilters): boolean {
  const added = FILTER_KEYS.filter((k) => narrower[k] !== undefined && wider[k] === undefined);
  const kept = FILTER_KEYS.every((k) => wider[k] === undefined || wider[k] === narrower[k]);
  return added.length > 0 && kept;
}

/**
 * How the facet bar was used: how many searches carried a chip, which ones, and how often a
 * chip was what NARROWED a search somebody had already run.
 *
 * The narrowing test is the chip's answer to `countRetypedRefinements`, and it needs no
 * typing window: clicking a chip involves no typing, so the two rows it produces are a
 * second apart or a minute apart for reasons that say nothing about intent. What identifies
 * it is that the query text is unchanged and a filter appeared.
 */
function chipUsageOf(rows: readonly SearchRow[]): ChipUsage {
  const byKey = Object.fromEntries(FILTER_KEYS.map((k) => [k, 0])) as ChipCounts;
  let searches = 0;
  for (const row of rows) {
    if (!row.filters) continue;
    searches++;
    for (const key of FILTER_KEYS) if (row.filters[key] !== undefined) byKey[key]++;
  }

  const byTime = [...rows].sort((a, b) => a.at - b.at);
  let refinements = 0;
  for (let i = 1; i < byTime.length; i++) {
    const previous = byTime[i - 1];
    const current = byTime[i];
    if (current.query.toLowerCase() !== previous.query.toLowerCase()) continue;
    if (current.filters && isNarrowedBy(previous.filters ?? {}, current.filters)) refinements++;
  }

  return { searches, byKey, refinements };
}

/** The worst rank each query's readers had to reach, for the queries where that was not 0. */
function rankFailuresOf(clicks: readonly ClickRow[]): RankFailure[] {
  const worst = new Map<string, RankFailure>();
  for (const c of clicks) {
    const held = worst.get(c.query);
    if (!held) {
      worst.set(c.query, { query: c.query, worstRank: c.rank, clicks: 1, tconst: c.tconst });
      continue;
    }
    held.clicks++;
    if (c.rank > held.worstRank) {
      held.worstRank = c.rank;
      held.tconst = c.tconst;
    }
  }
  return [...worst.values()]
    .filter((f) => f.worstRank > 0)
    .sort((a, b) => b.worstRank - a.worstRank || b.clicks - a.clicks)
    .slice(0, LIST_LIMIT);
}

function emptyTierCounts(): Record<Tier, number> {
  return Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
}

export function buildSearchReport(
  searches: readonly SearchRow[],
  clicks: readonly ClickRow[],
  replay?: (query: string) => Replayed,
): SearchReport {
  const tiers = emptyTierCounts();
  let withYear = 0;
  let withKind = 0;

  // One pass, one parse per row: `parseQuery` is the same work the engine does per request
  // and a report over 50,000 rows should not do it three times.
  for (const row of searches) {
    const parsed = parseQuery(row.query);
    if (parsed.year !== undefined) withYear++;
    if (parsed.kind !== undefined) withKind++;
    if (replay) tiers[replay(row.query).tier]++;
  }

  const byRank: number[] = [];
  for (const c of clicks) byRank[c.rank] = (byRank[c.rank] ?? 0) + 1;
  for (let i = 0; i < byRank.length; i++) byRank[i] ??= 0;

  const zeroResult = countBy(
    searches.filter((r) => r.results === 0),
    () => true,
  );

  return {
    window: searches.length
      ? { from: Math.min(...searches.map((r) => r.at)), to: Math.max(...searches.map((r) => r.at)) }
      : null,
    searches: searches.length,
    distinct: new Set(searches.map((r) => r.query.toLowerCase())).size,
    withYear,
    withKind,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the test.
    nonAscii: countBy(searches, (q) => /[^\x00-\x7F]/.test(q)),
    zeroResult,
    retypedRefinements: countRetypedRefinements(searches),
    chips: chipUsageOf(searches),
    tiers,
    mostRun: countBy(searches, () => true),
    clicks: {
      total: clicks.length,
      byRank,
      belowTop: clicks.filter((c) => c.rank > 0).length,
    },
    rankFailures: rankFailuresOf(clicks),
  };
}

const pct = (n: number, of: number): string => (of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`);

const list = (title: string, rows: readonly QueryCount[]): string =>
  rows.length === 0
    ? `${title}: none`
    : [`${title}:`, ...rows.map((r) => `  ${r.n}x  ${r.query}`)].join("\n");

/**
 * The report as something a person reads in a terminal.
 *
 * Separate from `buildSearchReport` so the numbers can be asserted on without going through
 * prose, and so a later consumer that wants JSON does not have to parse this back.
 */
export function formatSearchReport(r: SearchReport, replayed: boolean): string {
  if (r.searches === 0) {
    return "No queries logged yet. Check `searchLog` in /api/health -- it may be switched off.";
  }
  const window = r.window
    ? `${new Date(r.window.from).toISOString()} .. ${new Date(r.window.to).toISOString()}`
    : "";

  return [
    `${r.searches} queries (${r.distinct} distinct) over ${window}`,
    "",
    `Q1  years typed:         ${r.withYear} (${pct(r.withYear, r.searches)})`,
    `    kind hints typed:    ${r.withKind} (${pct(r.withKind, r.searches)})`,
    `Q3  tiers:               ${
      replayed
        ? TIERS.map((t) => `${t} ${r.tiers[t]}`).join("  ")
        : "not measured -- re-run without --no-replay"
    }`,
    `Q4  retyped refinements: ${r.retypedRefinements} -- narrowed by typing more, where a chip would have done`,
    `    chip refinements:    ${r.chips.refinements} -- narrowed by clicking a chip instead`,
    `    searches with chips: ${r.chips.searches} (${pct(r.chips.searches, r.searches)}), by chip: ${FILTER_KEYS.map(
      (k) => `${k} ${r.chips.byKey[k]}`,
    ).join("  ")}`,
    `Q5  non-English queries: ${r.nonAscii.reduce((n, q) => n + q.n, 0)} (${r.nonAscii.length} distinct)`,
    "",
    `clicks: ${r.clicks.total}, of which ${r.clicks.belowTop} below the top row (${pct(
      r.clicks.belowTop,
      r.clicks.total,
    )})`,
    `        by rank: ${r.clicks.byRank.map((n, i) => `${i}:${n}`).join(" ") || "none"}`,
    "",
    list("Ran most", r.mostRun),
    "",
    list("Found NOTHING", r.zeroResult),
    "",
    list("Searched in a non-English title", r.nonAscii),
    "",
    r.rankFailures.length === 0
      ? "Ranking failures: none -- every click was on the top row"
      : [
          "Ranking failures -- CANARY CANDIDATES, worst first. A case earns its place by",
          "being one of these, never by being invented:",
          ...r.rankFailures.map(
            (f) =>
              `  rank ${f.worstRank}  ${f.tconst}  ${f.query}  (${f.clicks} click${f.clicks === 1 ? "" : "s"})`,
          ),
        ].join("\n"),
    "",
    "Q2 (is the 300k vote saturation cap right?) is NOT answerable from a log. It needs an",
    "experiment: change the cap, replay these queries, and count how many rank failures move.",
  ].join("\n");
}
