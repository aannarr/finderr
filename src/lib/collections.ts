/**
 * A collection as a NODE: every member we hold, assembled from the facet cache.
 *
 * The `collection` facet is stored per TITLE -- one cached row per film, each naming the
 * collection and listing the OTHER films in it (`collectionWithParts` drops self, because
 * the title page's pane says "other movies in this collection"). A collection PAGE asks
 * the reverse question, so it reads those same rows from the other end: every row naming
 * this collection contributes its own subject as a member plus everyone it lists.
 *
 * That union is what makes one cached film enough. Viewing The Matrix caches a row whose
 * subject is `tt0133093` and whose parts are the other three, so `/collection/tmdb:2344`
 * is complete from that single row -- no second fetch, and no "we only know three of four
 * because you have not opened the fourth yet".
 *
 * NOTHING HERE TOUCHES THE NETWORK. These are pure functions over rows the resolver has
 * already cached and rows the index already holds, which is what lets a collection page
 * obey the governing rule the same way search and the person page do.
 */

import type { FacetShapes } from "./facets";
import { normalize } from "./normalize";
import type { TitleRow } from "./search";
import type { FacetContributionRow } from "./store";

/** A collection named by the facet cache, with no membership attached. */
export interface CollectionSummary {
  id: string;
  name: string;
}

export interface CollectionPage {
  collection: CollectionSummary;
  /** The members we hold an index row for, in release order. */
  titles: TitleRow[];
  /**
   * Members we know exist and cannot render.
   *
   * A count rather than a list of stubs: a tile with no poster, no library state and no
   * request button is a dead end wearing a poster frame (the same judgement the pane
   * makes). But an unexplained gap is worse than a number, so "3 of 4" is said out loud.
   */
  missing: number;
}

/** How a cached `collection` row parses. `data` is JSON on disk. */
type CollectionFacet = FacetShapes["collection"];

/**
 * One collection page, or `null` for an id nothing in the cache names.
 *
 * `rows` must already be narrowed to live contributions for ONE collection -- the caller
 * owns which plugins still count (`isLiveContribution`) because that is the registry's
 * judgement, not this module's.
 *
 * `byTconst` is injected rather than reached for, so the whole assembly is testable
 * against a handful of rows instead of the 1.27M-row index.
 */
export function collectionPage(
  rows: readonly FacetContributionRow[],
  byTconst: (tconst: string) => TitleRow | null,
): CollectionPage | null {
  const parsed = parseRows(rows);
  if (parsed.length === 0) return null;

  const { tconsts, unlinkable } = membersOf(parsed);

  const titles: TitleRow[] = [];
  for (const tconst of tconsts) {
    const row = byTconst(tconst);
    if (row) titles.push(row);
  }

  // An entry with no IMDb id upstream is unlookupable, so it is missing UNLESS another
  // row already produced the same film by id -- otherwise a collection where one member
  // arrives both ways would report a phantom gap.
  const rendered = new Set(titles.map((t) => normalize(t.title)));
  const unlinkableMissing = [...unlinkable].filter((title) => !rendered.has(normalize(title))).length;

  return {
    collection: namedBy(parsed),
    titles: titles.sort(byReleaseOrder),
    missing: tconsts.size - titles.length + unlinkableMissing,
  };
}

/**
 * Collections whose name matches what somebody typed, best match first.
 *
 * FOLDED, not exact: TMDB's names end in "Collection", so nobody types one. "lord of the
 * rings" has to find "The Lord of the Rings Collection", and the same fold that makes
 * that work also makes "THE MATRIX" and "the matrix" one query.
 *
 * Every match is RETURNED rather than the best one being picked here. Names are neither
 * unique nor stable, and sending a reader to the wrong franchise is worse than asking
 * which one they meant -- so ambiguity is the caller's to show, never this module's to
 * guess away.
 */
export function collectionsMatchingName(
  rows: readonly FacetContributionRow[],
  query: string,
): CollectionSummary[] {
  const wanted = normalize(query);
  if (wanted.length === 0) return [];

  const byId = new Map<string, CollectionSummary>();
  for (const facet of parseRows(rows).map((p) => p.facet)) {
    if (!byId.has(facet.id)) byId.set(facet.id, { id: facet.id, name: facet.name });
  }

  return [...byId.values()]
    .map((c) => ({ collection: c, rank: nameRank(normalize(c.name), wanted) }))
    .filter((m) => m.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.collection.name.localeCompare(b.collection.name))
    .map((m) => m.collection);
}

// --- internals -------------------------------------------------------------

/** A cached row, with its JSON read once. */
interface ParsedRow {
  subject: string;
  resolvedAt: string;
  facet: CollectionFacet;
}

/**
 * Read the rows we can, and drop the ones we cannot.
 *
 * A row whose JSON does not parse is one bad write, and losing the collection page over
 * it would be a worse outcome than rendering the rest of the franchise.
 */
function parseRows(rows: readonly FacetContributionRow[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const row of rows) {
    if (row.outcome !== "ok" || row.data === null) continue;
    try {
      const facet = JSON.parse(row.data) as CollectionFacet;
      if (typeof facet?.id === "string" && typeof facet.name === "string") {
        out.push({ subject: row.entity_id, resolvedAt: row.resolved_at, facet });
      }
    } catch {
      // Unparseable JSON is not a collection. The next row may well be.
    }
  }
  return out;
}

/**
 * The collection's identity, taken from the row resolved most recently.
 *
 * Rows are written independently per film, so an upstream rename leaves old and new
 * names side by side. Newest wins, with the subject id breaking a tie so the answer is
 * the same on every call rather than depending on SQLite's row order.
 */
function namedBy(rows: readonly ParsedRow[]): CollectionSummary {
  const newest = rows.reduce((best, row) =>
    row.resolvedAt > best.resolvedAt || (row.resolvedAt === best.resolvedAt && row.subject > best.subject)
      ? row
      : best,
  );
  return { id: newest.facet.id, name: newest.facet.name };
}

/** Every member these rows know about, split by whether we can look it up at all. */
function membersOf(rows: readonly ParsedRow[]): { tconsts: Set<string>; unlinkable: Set<string> } {
  const tconsts = new Set<string>();
  const unlinkable = new Set<string>();

  for (const row of rows) {
    // The subject of the row is itself a member -- that is the fact the reverse read
    // exists for, and it is the only reason one cached film yields a whole collection.
    tconsts.add(row.subject);
    for (const part of row.facet.parts ?? []) {
      if (part.tconst) tconsts.add(part.tconst);
      // No IMDb id upstream: countable by title, never linkable.
      else if (part.title) unlinkable.add(part.title);
    }
  }
  return { tconsts, unlinkable };
}

/** Release order, which for a franchise is the order anyone would read it in. */
function byReleaseOrder(a: TitleRow, b: TitleRow): number {
  // A year we do not hold sorts last rather than first: an unreleased or unknown entry
  // belongs at the end of a franchise, not in front of the film that started it.
  const ay = a.year ?? Number.POSITIVE_INFINITY;
  const by = b.year ?? Number.POSITIVE_INFINITY;
  return ay - by || a.title.localeCompare(b.title);
}

/** Lower is better. `null` means this name does not match at all. */
function nameRank(name: string, wanted: string): number | null {
  if (name === wanted) return 0;
  if (name.startsWith(wanted)) return 1;
  if (name.includes(wanted)) return 2;
  return null;
}
