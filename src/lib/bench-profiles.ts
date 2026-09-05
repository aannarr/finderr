/**
 * STORAGE PROFILES -- the same index, shaped for two different kinds of disk.
 *
 * This file exists to answer ONE question with measurements instead of intuition: does
 * finderr want a different index shape on spinning disks than it wants on NVMe? It is a
 * BENCH-ONLY artifact. Nothing in the server imports it, no build reads it, and shipping a
 * `storage` config knob is a decision that comes AFTER the matrix, not before it.
 *
 * ## The two profiles, and why they are the shapes they are
 *
 * `shipped` is `allIndexes()` verbatim -- the baseline, not a variant. Every widening in it
 * was measured and is commented where it lives (`index-builder.ts` § INDEXES). It follows
 * aannarr's standing rule that bytes are the cheap axis on a file written once and read
 * forever, so it covers aggressively: trailing payload columns so a seek never reaches into
 * the table's own pages.
 *
 * `slim` narrows every one of those widenings back to its key columns. It is NOT a
 * strawman -- each narrow form here is either the shape that shipped before somebody widened
 * it, or the exact comparison an existing comment already names. `ix_ep_parent`'s slim form
 * is quoted in that index's own docstring as the thing it was benchmarked against.
 *
 * ## What each profile is BETTING on, stated so the matrix can refute it
 *
 * - `shipped` bets that a page fetched from the table is expensive, so paying bytes to avoid
 *   it wins. On a 7200rpm array a random page is ~10ms, so this should win big COLD.
 * - `slim` bets that the bytes themselves are the cost -- a smaller file prefaults faster,
 *   occupies less page cache and survives memory pressure longer. On a box whose RAM
 *   comfortably holds the whole index, every read is from cache and the covering columns buy
 *   nothing but footprint.
 *
 * **These two bets are not symmetric, and that is the interesting part.** `warmPageCache`
 * (`../server/live-index.ts`) already reads the entire index sequentially at boot and after
 * every swap, precisely because sequential is what a striped array is good at. If that
 * prefault works as designed then the cold window `shipped` optimises for barely exists in
 * production, and the axis that survives is footprint -- which is `slim`'s bet. The harness
 * measures cold, prefaulted and warm separately so the three states can disagree.
 *
 * ## Deliberately not a config setting yet
 *
 * A `storage: "hdd" | "nvme"` knob in `config.ts` would need a stage recipe, a rebuild path
 * and a second row in every plan test. All of that is cheap ONCE there is a number saying it
 * is worth having. Until then this stays here, where it costs one file nobody imports.
 */

import { POPULAR_TITLE_INDEX } from "./search-stopwords";

/**
 * Every index the `slim` profile builds, in the same order `allIndexes()` emits them.
 *
 * An index that is ALREADY minimal appears here unchanged -- the list is complete rather
 * than a diff, so a reader can see the whole shape without holding two files in their head,
 * and so a new index added to `INDEXES` shows up as missing here rather than being silently
 * inherited. `assertProfilesAgree` is what turns that into a failure instead of a surprise.
 */
const SLIM_INDEXES: readonly string[] = [
  // --- rank layer -------------------------------------------------------------------
  // Unchanged: already two key columns and no payload.
  "create index ix_rank on title(kind, rank desc)",
  // Was `(genre, rank desc, kind, title_rowid, votes)`. Drops the covered filter column and
  // the +9.9 MB payload pair. The (genre, rank desc) ORDER is kept -- that part was measured
  // at 807ms vs 0.11ms and is a plan fix, not a size trade. Narrowing it would test the wrong
  // thing.
  "create index ix_tg_rank on title_genre(genre, rank desc)",
  // Unchanged.
  "create index ix_rank_all on title(rank desc)",
  // Was `(genre, votes desc, kind)`. Drops the covered `kind` filter.
  "create index ix_tg_votes on title_genre(genre, votes desc)",

  // --- secondary --------------------------------------------------------------------
  // Unchanged.
  "create index ix_votes on title(votes desc)",
  // Was `(year, votes desc)`. This is the pre-widening shape, named in its own comment.
  // NOTE the comment's warning: the widening and the ten-seek decade split are one change.
  // Narrowing here without touching `decadeRows` is exactly what the matrix should price.
  "create index ix_year on title(year)",
  // Was `(kind, votes desc)`. Also a documented pre-widening shape.
  "create index ix_kind on title(kind)",
  // POPULAR_TITLE_INDEX is a PURE covering index -- its whole purpose is answering
  // `title like 'the %'` from index pages without fetching a row. There is no narrower
  // version that does anything, so slim drops it entirely and pays the row fetch.
  // (Absent, deliberately. See `search-stopwords.ts`.)
  "create index ix_tg_title on title_genre(title_rowid)",
  "create index ix_tp_person on title_principal(person_rowid)",
  "create index ix_tp_title on title_principal(title_rowid)",
  "create index ix_person_name on person(name)",
  // Was `(parent, season, number, tconst, title, rating, votes, year)`. THIS narrow form is
  // quoted verbatim in `ix_ep_parent`'s own docstring as what it was benchmarked against --
  // "20-30% slower warm, 4-13 ms cold on a title page, and up to 496 ms cold on a
  // 15,456-episode soap". Which machine produced those numbers is not recorded, and that
  // omission is a reason this harness exists.
  "create index ix_ep_parent on episode(parent, season, number)",
];

/** A named index shape to measure. `shipped` is filled by the runner from `allIndexes()`. */
export interface StorageProfile {
  name: string;
  /** One-line description, printed in the report header so a result explains itself. */
  what: string;
  /** `null` means "whatever this checkout builds" -- the baseline. */
  indexes: readonly string[] | null;
}

export const STORAGE_PROFILES: Record<string, StorageProfile> = {
  shipped: {
    name: "shipped",
    what: "allIndexes() verbatim -- wide, covering, the current build",
    indexes: null,
  },
  slim: {
    name: "slim",
    what: "every covering widening narrowed to its key columns; ix_pop_title dropped",
    indexes: SLIM_INDEXES,
  },
};

/**
 * The index NAMES a profile is expected to account for, so a drift is loud.
 *
 * Adding an index to `INDEXES` and forgetting it here would make `slim` silently inherit the
 * WIDE version of it -- and the matrix would then report a difference that is smaller than
 * the real one, in the direction that argues against doing anything. A benchmark that fails
 * safe has to fail towards noticing.
 *
 * Returns the mismatches rather than throwing, because the runner wants to print them beside
 * the profile header where somebody will read them.
 */
export function profileDrift(shipped: readonly string[]): { missing: string[]; extra: string[] } {
  const nameOf = (sql: string): string => sql.match(/create index (?:if not exists )?(\w+)/i)?.[1] ?? sql;
  const shippedNames = new Set(shipped.map(nameOf));
  // ix_pop_title is dropped on purpose, so it is not "missing" -- it is the one deliberate
  // absence and is named here rather than being an unexplained hole in the list.
  const deliberatelyAbsent = new Set([nameOf(POPULAR_TITLE_INDEX)]);
  const slimNames = new Set(SLIM_INDEXES.map(nameOf));
  return {
    missing: [...shippedNames].filter((n) => !slimNames.has(n) && !deliberatelyAbsent.has(n)),
    extra: [...slimNames].filter((n) => !shippedNames.has(n)),
  };
}
