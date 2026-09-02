#!/usr/bin/env bun
/**
 * Read the search log and say what it means for the scorer.
 *
 * ```
 * bun run search:report              # replay against the live index -- answers Q3
 * bun run search:report --no-replay  # counts only, no index needed
 * bun run search:report --limit 5000
 * ```
 *
 * A JOB rather than a route, and it is the reason the log is worth keeping: without a
 * reader, `search_log` is a table nobody looks at. It opens the index READ-ONLY through the
 * ordinary `SearchEngine`, so the tiers it reports are the tiers a searcher would get.
 *
 * > [!IMPORTANT] Its output is the input to the retune, not the retune
 * > The "canary candidates" section lists real queries whose reader had to look past the
 * > top row. Those are the cases that have earned a place in `CANARY_CASES`; deciding to
 * > add one, and what `want` should be, is a person's call. See `../lib/search-report.ts`.
 *
 * WHAT IT CANNOT SEE, said here so nobody reads a silence as a zero: which facet CHIPS were
 * clicked. A search row carries the query, a timestamp and a result count and nothing else
 * (the D4 ruling on the tuning card), and the filters live in the request's query string.
 * `retypedRefinements` measures the other half of that question -- people narrowing a
 * search by typing more -- and is the closest this log can get.
 */

import { loadConfig, paths } from "../lib/config";
import { SearchEngine } from "../lib/search";
import { buildSearchReport, formatSearchReport, type Replayed } from "../lib/search-report";
import { prepareSqlite } from "../lib/spellfix";
import { Store } from "../lib/store";

/** How many rows to read when `--limit` is not given. The whole ceiling, so nothing is missed. */
const DEFAULT_LIMIT = 50_000;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export function main(argv: readonly string[] = Bun.argv.slice(2)): void {
  const cfg = loadConfig();
  const limit = Number.parseInt(flagValue(argv, "--limit") ?? String(DEFAULT_LIMIT), 10);
  const wantReplay = !argv.includes("--no-replay");

  const store = new Store(cfg);
  let engine: SearchEngine | undefined;
  try {
    const searches = store.searchLogRows(limit);
    const clicks = store.searchClickRows(limit);

    let replay: ((query: string) => Replayed) | undefined;
    if (wantReplay) {
      // Before the engine opens anything -- the fuzzy tier needs an extension-permitting
      // libsqlite3 and that choice is process-global. Without it every typo query would
      // report as `fts` and the tier counts would be quietly wrong. Same order as `runCanary`.
      prepareSqlite();
      engine = new SearchEngine(paths(cfg).db, cfg);
      engine.prepareFuzzy();
      const live = engine;
      replay = (query) => {
        // No facets: this asks which tier answered, and computing facet counts for 50,000
        // queries is work nothing here reads.
        const res = live.search(query, { limit: 1, facets: false });
        return { tier: res.tier, top: res.hits[0]?.title ?? null };
      };
    }

    console.log(formatSearchReport(buildSearchReport(searches, clicks, replay), wantReplay));
  } finally {
    engine?.close();
    store.close();
  }
}

if (import.meta.main) main();
