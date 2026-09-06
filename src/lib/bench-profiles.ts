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
  // UNCHANGED, and there is no narrower form to test. `title_lang` has exactly two columns
  // and the EXISTS predicate needs both -- `title_rowid` to seek and `lang` to test -- so
  // this index is entirely key and carries no payload for a slim profile to drop.
  "create index ix_lang on title_lang(title_rowid, lang)",
  // UNCHANGED for the same reason as its sibling above: both columns are key, so there is no
  // payload to narrow. It is 16.5 MB of pure key, and the language lists are 138.4 ms without
  // it against 81.0 ms with -- which makes it a candidate for a future SIZE profile ("what if
  // you dropped it entirely?"), not for this one.
  "create index ix_lang_code on title_lang(lang, title_rowid)",
  // Was `(parent, season, number, tconst, title, rating, votes, year)`. THIS narrow form is
  // quoted verbatim in `ix_ep_parent`'s own docstring as what it was benchmarked against --
  // "20-30% slower warm, 4-13 ms cold on a title page, and up to 496 ms cold on a
  // 15,456-episode soap". Which machine produced those numbers is not recorded, and that
  // omission is a reason this harness exists.
  "create index ix_ep_parent on episode(parent, season, number)",
];

/**
 * PAYLOAD ONLY -- the honest test of "do the covering bytes earn their keep?".
 *
 * > [!IMPORTANT] `slim` above turned out to conflate TWO different changes, and the Mac run proved it
 * > Measured 2026-09-05 on the M1 Max: `slim` was **278x slower warm** on `browse.decade` and
 * > **73x** on `browse.year`. That is not the covering columns being missed -- it is `ix_year`
 * > losing its `votes desc` SORT column, which `decadeRows`' ten-seek split depends on
 * > absolutely. The index's own comment warned that the widening and the split are one change,
 * > and `slim` broke the pair.
 * >
 * > So `slim`'s totals answer a question nobody asked: "what if you also broke an ordering?".
 * > This profile drops **trailing payload columns and nothing else** -- every key column and
 * > every sort column stays, so the query PLANS are the same shape and only the row fetch
 * > changes. That is the actual NVMe-vs-HDD trade, isolated.
 *
 * Keep both. `slim` is still worth having as the outer bound, and the gap between the two is
 * itself the finding: it separates "bytes we pay to avoid a fetch" from "bytes that are load
 * bearing for the plan".
 */
const SLIM_PAYLOAD_INDEXES: readonly string[] = [
  "create index ix_rank on title(kind, rank desc)",
  // Drops the `title_rowid, votes` payload pair (+9.9 MB) and KEEPS `kind`, which is a covered
  // filter rather than payload -- and keeps the (genre, rank desc) ordering intact.
  "create index ix_tg_rank on title_genre(genre, rank desc, kind)",
  "create index ix_rank_all on title(rank desc)",
  // Unchanged: `kind` here is a covered filter and the sort column is already minimal.
  "create index ix_tg_votes on title_genre(genre, votes desc, kind)",
  "create index ix_votes on title(votes desc)",
  // Unchanged, deliberately -- `votes desc` is a SORT column here, not payload. This is the
  // exact line `slim` got wrong.
  "create index ix_year on title(year, votes desc)",
  "create index ix_kind on title(kind, votes desc)",
  // Still dropped: ix_pop_title is nothing BUT a covering index, so it belongs to this
  // question rather than to the ordering one.
  "create index ix_tg_title on title_genre(title_rowid)",
  "create index ix_tp_person on title_principal(person_rowid)",
  "create index ix_tp_title on title_principal(title_rowid)",
  "create index ix_person_name on person(name)",
  // Unchanged for the reason `slim` gives: two columns, both key, no payload to drop.
  "create index ix_lang on title_lang(title_rowid, lang)",
  "create index ix_lang_code on title_lang(lang, title_rowid)",
  // Drops five payload columns, keeps the whole key. The pure case, and the one whose
  // docstring already claims 20-30% warm and up to 496 ms cold.
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
  slimPayload: {
    name: "slimPayload",
    what: "trailing PAYLOAD columns dropped, every key and sort column kept -- the isolated trade",
    indexes: SLIM_PAYLOAD_INDEXES,
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
export function profileDrift(
  shipped: readonly string[],
  profile: StorageProfile,
): { missing: string[]; extra: string[] } {
  if (!profile.indexes) return { missing: [], extra: [] }; // the baseline cannot drift from itself
  const nameOf = (sql: string): string => sql.match(/create index (?:if not exists )?(\w+)/i)?.[1] ?? sql;
  const shippedNames = new Set(shipped.map(nameOf));
  // ix_pop_title is dropped on purpose by both variants, so it is not "missing" -- it is the
  // one deliberate absence and is named here rather than being an unexplained hole in a list.
  const deliberatelyAbsent = new Set([nameOf(POPULAR_TITLE_INDEX)]);
  const has = new Set(profile.indexes.map(nameOf));
  return {
    missing: [...shippedNames].filter((n) => !has.has(n) && !deliberatelyAbsent.has(n)),
    extra: [...has].filter((n) => !shippedNames.has(n)),
  };
}
