#!/usr/bin/env bun
/**
 * Replay the search log's CLICKS against the index this checkout would serve.
 *
 * ```
 * FINDERR_DATA_DIR=/abs/path bun run search:replay
 * ```
 *
 * The companion to `search:report`, and the half of the tuning card that a report cannot do:
 * `search:report` says which queries failed a reader when they ran them, this says whether
 * they still would. Change one constant in `SearchEngine.rank`, run it again, and the
 * difference in `mean rank` is what that constant was worth -- Q2's "change the cap, replay
 * these queries, count how many rank failures move", made into one command.
 *
 * Opens the index READ-ONLY through the ordinary `SearchEngine`, exactly as `search:report`
 * does, so the ranks it prints are the ranks a searcher would get. See that job's header for
 * the `FINDERR_DATA_DIR` invocation and the warning about opening a live data directory.
 */

import { loadConfig, paths } from "../lib/config";
import { SearchEngine } from "../lib/search";
import { buildReplayReport, formatReplayReport, RANK_WINDOW } from "../lib/search-replay";
import { prepareSqlite } from "../lib/spellfix";
import { Store } from "../lib/store";

/** How many click rows to read. The whole table, so nothing is missed. */
const DEFAULT_LIMIT = 50_000;

export function main(): void {
  const cfg = loadConfig();
  const store = new Store(cfg);

  // Before the engine opens anything -- the fuzzy tier needs an extension-permitting
  // libsqlite3 and that choice is process-global. Same order as `runCanary`.
  prepareSqlite();
  const engine = new SearchEngine(paths(cfg).db, cfg);
  engine.prepareFuzzy();

  try {
    const clicks = store.searchClickRows(DEFAULT_LIMIT);
    const report = buildReplayReport(clicks, (query, tconst) => {
      // No facets: this asks where one title sits, and facet counts are work nothing reads.
      const hits = engine.search(query, { limit: RANK_WINDOW, facets: false }).hits;
      const at = hits.findIndex((h) => h.tconst === tconst);
      return at === -1 ? null : at;
    });
    console.log(formatReplayReport(report));
  } finally {
    engine.close();
    store.close();
  }
}

if (import.meta.main) main();
