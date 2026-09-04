/**
 * Which stages an index carries, so an upgrade can notice it is missing one.
 *
 * ## The bug this exists to end
 *
 * Every stage added to the builder so far has been ADDITIVE and optional, and each one
 * grew its own capability probe in `SearchEngine` -- `hasPeople`, `hasRank`, `hasIds`. Those
 * probes are correct and they stay: an index built before a stage existed must keep serving
 * rather than throw `no such table`. But they only ever answer "can I read this?", and
 * nothing anywhere answered **"should this index have been able to?"**
 *
 * So the upgrade path was: pull the new image, restart, and run indefinitely on an index
 * that silently lacks the thing the release was about. Measured on 2026-09-01, on the live
 * deployment: the id crosswalk shipped, the container restarted onto it, `hasIds` was false,
 * and every render went on buying `/find` calls the crosswalk existed to remove. Nothing was
 * broken, nothing logged, and `/api/health` was entirely green.
 *
 * The daily refresh did not fix it either, and that is the second half. `build-index.ts`
 * only builds when a DUMP drifted upstream, and a newly downloaded crosswalk deliberately
 * does not count as drift. On a day when every IMDb dump answers 304, the crosswalk is
 * fetched and then ignored. It self-heals eventually because IMDb publishes daily -- by
 * accident, not by design, and an accident is not an upgrade path.
 *
 * ## What is stamped, and why a stage that found nothing still counts
 *
 * The build records every stage it RAN, with a recipe describing the configuration that
 * produced it. A stage that ran and found no source to read is still stamped: the crosswalk
 * being absent from disk is an answer, and re-running the build would produce the same
 * answer. Stamping only successful stages would mean a keyless or sourceless deployment
 * rebuilding its entire index on every single boot, forever.
 *
 * The recipe is what makes this more than a presence check. `cast` carries its categories
 * and vote floor, so widening `castCategories` is noticed at BOOT rather than whenever the
 * next dump happens to drift.
 *
 * ## Deliberately not a version number
 *
 * A monotonic `INDEX_VERSION` bumped by hand fails the same way a manual cache version
 * does -- silently, when somebody forgets. It also cannot express the case that actually
 * occurs here, which is one stage moving while the other four are untouched: a version
 * number would rebuild everything or nothing.
 */

import { Database } from "bun:sqlite";
import type { Config } from "./config";
// `index-builder` imports `stampStages` from this file, so this is a cycle -- and it is a
// SAFE one, because the only use is inside a recipe function that runs long after both
// modules have initialised. Written as an import rather than a second copy of the number on
// purpose: `browse_count.n_floor` is a count of rows clearing this floor, so a stamp holding
// a stale copy would report an index as current while its stored totals answered a different
// question. `index-builder.ts` owns the constant because the build bakes it into a column.
import { BROWSE_VOTE_FLOOR } from "./index-builder";
import { STOPWORD_VOTE_FLOOR } from "./search-stopwords";

/**
 * The `meta` key holding the stamp, as a JSON object of `stage -> recipe`.
 *
 * One key rather than one per stage, because the stamp is read as a SET -- "what does this
 * index carry?" is a single question, and answering it with `n` queries invites the two
 * halves to disagree about which stages exist.
 */
export const STAGES_META_KEY = "stages";

/**
 * Every stage this build knows how to produce, and what its output depends on.
 *
 * A stage belongs here once it can be ABSENT from an otherwise valid index -- which is the
 * same test as needing a capability probe in `SearchEngine` (`hasPeople`, `hasRank`,
 * `hasIds`, `hasPersonIds`, `hasPeopleSearch`, `hasEpisodes`) or, for `popularTitles`, of
 * being invisibly slower without it. A stage that every index has always had needs no
 * stamp: there is no version of the file without it.
 *
 * The recipe is a canonical string. Two builds of the same configuration must produce the
 * same one, so anything set-like is sorted -- an unsorted list would report a difference
 * every time somebody reordered a config array, and a stamp that always disagrees is a
 * stamp nobody can act on.
 */
export const INDEX_STAGES = {
  /**
   * `person` + `title_principal`. Reuses the SAME derivation the carry-forward decision
   * uses (`castRecipe`), so the two cannot disagree about what "the same cast" means.
   */
  cast: (cfg) =>
    JSON.stringify({
      categories: [...new Set(cfg.index.castCategories)].sort(),
      minVotes: cfg.index.castMinVotes,
    }),

  /**
   * The `rank` column on `title` and its copy on `title_genre` -- and, since `v: 2`, the
   * `votes` copy beside it plus `ix_tg_votes`.
   *
   * **`v: 3` (2026-09-05) reshaped `ix_tg_rank` and added `ix_rank_all`**, and it is the
   * clearest case yet for why this field exists. Nothing about the recipe's INPUTS changed --
   * same prior, same rows, same answers -- so without the bump an existing index would keep
   * serving every computed top list down a temp-b-tree path: 807 ms for `?genre=Drama&sort=rank`
   * against 0.11 ms, and 82 ms for the no-genre Top 250 against 0.06 ms. Green health, correct
   * results, the optimisation silently never adopted. Exactly the crosswalk's shape.
   *
   * The `v` is what makes an index built before 2026-09-02 STALE rather than merely slow.
   * Nothing about the recipe's inputs changed, so without it an old file would keep serving
   * a genre browse down the 3.66s path indefinitely -- correct, and quietly a hundred times
   * more expensive than the one this build produces. That is exactly the shape the crosswalk
   * shipped in and had to be fixed by hand: green health, right answers, the optimisation
   * silently never adopted. Bump it whenever this stage's OUTPUT changes shape, not only
   * when its configuration does.
   */
  rank: (cfg) => JSON.stringify({ v: 3, priorVotes: cfg.index.rankPriorVotes }),

  /**
   * `title_ids`, the bulk `tconst -> tmdb/tvdb` crosswalk.
   *
   * No configuration input at all, so the recipe is a constant -- present or absent is the
   * whole question. It is still a JSON object rather than a bare string so a knob arriving
   * later is an edit to this line and not a change of shape.
   */
  ids: () => JSON.stringify({ v: 1 }),

  /**
   * `person_external`, the bulk `TMDB person id -> nconst` crosswalk.
   *
   * Constant for the same reason `ids` is -- there is no knob, only present or absent. It
   * needs its own entry rather than riding on `ids` because the two load from different
   * files and either can be on disk without the other, so one stamp for both would report
   * an index as current while half of it was missing.
   */
  personIds: () => JSON.stringify({ v: 1 }),

  /**
   * `ix_pop_title`, the partial covering index that serves a stopword-only query.
   *
   * Like `rank`, this is a stage whose absence is INVISIBLE -- an index without it answers
   * `?q=the` correctly and about twenty times slower, which is precisely the shape the
   * crosswalk shipped in and had to be found by hand. Measured 2026-09-02 on the real
   * 1.27M-row index: the floored scan it replaces was a 51.8ms median with a 1461ms worst
   * case across the stopword set, and this is 2.0ms median / 2.4ms worst.
   *
   * The floor is IN the recipe because it is in the index's own `where` clause: moving
   * `STOPWORD_VOTE_FLOOR` without rebuilding would leave a partial index that no longer
   * covers the range the query asks for, and SQLite would silently fall back to the slow
   * scan rather than fail.
   */
  popularTitles: () => JSON.stringify({ v: 1, floor: STOPWORD_VOTE_FLOOR }),

  /**
   * `pfts` and the `top_votes`/`credits` columns it ranks by -- the people search.
   *
   * Constant like `ids`, because there is no knob: the layer is derived entirely from
   * `person` and `title_principal`, whose own configuration is already `cast`'s recipe.
   * Its own entry rather than riding on `cast` because the two are not the same question --
   * an index built by yesterday's image has the cast tables and no search over them, and
   * one stamp for both would report that index as current.
   *
   * It is also the case this stamp exists for. Without it the layer would appear only when
   * a dump happened to drift, and until then `hasPeopleSearch` would be false against a
   * perfectly green deployment -- search would simply go on finding no people, with nothing
   * anywhere saying why.
   */
  peopleSearch: () => JSON.stringify({ v: 1 }),

  /**
   * `episode` -- per-episode ratings, floored on the SERIES rather than on the episode.
   *
   * The floor is IN the recipe for the same reason `cast`'s categories are: it decides which
   * rows exist, so lowering it is a change that would otherwise be swallowed until a dump
   * happened to drift upstream. The symptom of that swallowing is the bad one -- a mid-sized
   * show whose episode list is simply absent reads as missing data rather than as a stale
   * index, and there is nothing on screen to say a threshold is responsible.
   *
   * It carries no `castRefreshDays` equivalent because there is nothing to carry forward:
   * the stage rebuilds from a 52 MB dump on every build, and its rows are keyed on tconst
   * rather than on a rowid, so there is no cheap copy that would be worth the machinery.
   */
  episodes: (cfg) => JSON.stringify({ v: 1, minVotes: cfg.index.episodeSeriesMinVotes }),

  /**
   * `ix_year` WIDENED to `(year, votes desc)`, the single-year seek a decade browse splits into.
   *
   * Invisible when absent, like `rank` and `popularTitles`: `browseIndex` still splits a
   * decade into ten per-year queries and still returns the right rows, each one just falls
   * back to the narrow `ix_year(year)` and sorts. Measured on the real index, `decade=2010`:
   * 0.92 ms with the widened index against 161 ms for the range scan it replaced.
   *
   * It needs its own stamp even though the index NAME is unchanged -- which is exactly why a
   * presence check would not do. An old file has an `ix_year` and would look complete.
   */
  yearVotes: () => JSON.stringify({ v: 1 }),

  /**
   * `meta.shelf_genres`, the front page's genre rows answered at build time.
   *
   * Its own entry rather than riding on `rank`, because the two are not the same question:
   * an index can carry every rank index and no precomputed genres, and `SearchEngine` would
   * then silently fall back to the 25 ms aggregate on every uncached front page -- correct,
   * and the exact "invisibly slower" shape this whole file exists to catch.
   *
   * The FLOORS are in the recipe because they decide the answer. Moving them without a
   * rebuild would leave a stored list that no longer means what the code believes it means,
   * and nothing on screen would say so.
   */
  shelfGenres: () => JSON.stringify({ v: 1, minVotes: 20_000, minRating: 7.0 }),

  /**
   * `browse_count`, every browse total answered at build time.
   *
   * Invisible when absent -- `browseTotal` falls back to the live count and returns the same
   * number, more slowly. Measured on the real index: a genre+decade count is 137.48 ms live
   * and 0.34 ms stored, an unfiltered ranked count 11.16 ms against 0.50 ms.
   *
   * **The floor is in the recipe because it is baked into a stored COLUMN.** `n_floor` is a
   * count of rows clearing `BROWSE_VOTE_FLOOR` at the moment of the build; moving that
   * constant without a rebuild would leave a table whose numbers quietly answer a different
   * question from the one the query is asking, and a wrong total is worse than a slow one --
   * it is printed to the reader as a fact.
   */
  browseCounts: () => JSON.stringify({ v: 1, floor: BROWSE_VOTE_FLOOR }),
  // `satisfies` rather than an annotation: the keys stay literal, so `INDEX_STAGES.cast` is
  // a function rather than a possibly-undefined index read, and a typo in a caller is a
  // compile error instead of a stage that silently never matches.
} satisfies Record<string, (cfg: Config) => string>;

/** The stamp this configuration would write: every known stage at its current recipe. */
export function currentStages(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, recipe] of Object.entries(INDEX_STAGES)) out[name] = recipe(cfg);
  return out;
}

/**
 * Write the stamp into an index being built.
 *
 * Called once, at the end of the build, over every stage rather than by each stage as it
 * finishes. A stage that writes its own stamp can leave one behind after a later stage
 * throws, and a partially stamped index is worse than an unstamped one: it claims to carry
 * something the file does not have.
 */
export function stampStages(db: Database, cfg: Config): void {
  db.query("insert or replace into meta (key, value) values (?, ?)").run(
    STAGES_META_KEY,
    JSON.stringify(currentStages(cfg)),
  );
}

/**
 * The stamp an index file carries, or `{}` for one built before stamping existed.
 *
 * Never throws. This runs at boot against a file that may be missing, mid-promote or
 * simply older than this code, and a startup check that can itself take the server down is
 * worse than the drift it was added to notice.
 */
export function stagesOf(path: string): Record<string, string> {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query(`select value from meta where key = '${STAGES_META_KEY}'`).get() as
        | { value: string }
        | undefined;
      if (!row) return {};
      const parsed = JSON.parse(row.value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
      return out;
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

/** One stage the index does not carry at the recipe this build would produce. */
export interface StaleStage {
  stage: string;
  /** What the index has, or `null` when it has no stamp for this stage at all. */
  had: string | null;
  /** What this configuration would produce. */
  wants: string;
}

/**
 * Stages the index at `path` is missing or carries under a superseded recipe.
 *
 * Empty for an index that is up to date, and empty for a file that does not exist -- a
 * MISSING index is not a stale one, it is the boot-build path's problem, and reporting it
 * here would have the caller rebuilding a file it is already building.
 *
 * An UNSTAMPED index reports every stage. That is the correct answer rather than a
 * conservative one: the stamp landed alongside no stage of its own, so an index without it
 * predates the newest stage by definition and one rebuild brings it fully current.
 */
export function staleStages(path: string, cfg: Config): StaleStage[] {
  const db = new Database(path, { readonly: true, create: false });
  db.close();

  const had = stagesOf(path);
  const wants = currentStages(cfg);
  const out: StaleStage[] = [];
  for (const [stage, recipe] of Object.entries(wants)) {
    if (had[stage] !== recipe) out.push({ stage, had: had[stage] ?? null, wants: recipe });
  }
  return out;
}

/**
 * `staleStages` for a path that may not exist, as the one-line form every caller wants.
 *
 * Returns `[]` when there is no file. Both callers -- the build job and the boot check --
 * would otherwise write the same `existsSync` guard, and the failure of forgetting it is a
 * thrown exception on a fresh install: the exact deployment least able to absorb one.
 */
export function staleStagesOf(path: string, cfg: Config): StaleStage[] {
  try {
    return staleStages(path, cfg);
  } catch {
    return [];
  }
}

/** A log line naming what is stale, short enough for a boot line. */
export function describeStale(stale: StaleStage[]): string {
  return stale.map((s) => (s.had === null ? s.stage : `${s.stage} (recipe changed)`)).join(", ");
}
