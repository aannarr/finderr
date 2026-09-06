/**
 * The award pages, assembled from local SQLite and nothing else.
 *
 * Split out of `index.ts` for the same reason `shelves.ts` was: these two payloads are the
 * single owner of what an awards screen contains, and both handlers plus anything that
 * ever wants to report on them read the same functions. No handler here reaches a
 * provider, waits on a network call, or opens `titles.db` itself -- the engine arrives as
 * an argument so the live swap stays in charge of it.
 *
 * The one shape rule worth stating up front: **a nomination carries ids, and the ROWS come
 * separately.** A film's poster, its library state and its Request button all live on a
 * decorated index row, and none of them are facts the award tables hold. So both payloads
 * send a `titles` map keyed by tconst, and the client links a name only when the map has
 * it. That is the dead-end rule expressed as a data shape: a title we do not index has no
 * entry, so the browser has nothing to render a link out of and prints plain text.
 */

import { type AwardDef, anchorNoun } from "../lib/award-registry";
import {
  type AwardPersonClass,
  type AwardSourceMeta,
  awardPeopleBoards,
  type CategoryGroup,
  type CeremonySummary,
  ceremonyTimeline,
  groupByCategory,
  type Nomination,
  orderPersonClasses,
} from "../lib/awards";
import type { PersonLeaderboard } from "../lib/people-leaderboard";
import type { TitleRow } from "../lib/search";
import type { Store } from "../lib/store";

/** Just enough of `SearchEngine` to resolve an id, so tests need no index. */
export interface TitleLookup {
  byTconst(tconst: string): TitleRow | null;
}

/** Turns index rows into cards. `decorate` in `index.ts` is the real one. */
export type Decorate = <T extends TitleRow>(rows: T[]) => (T & { inLibrary: boolean })[];

export interface AwardsDeps {
  store: Store;
  engine: TitleLookup;
  decorate: Decorate;
  /** WHICH award these payloads are about. Everything award-specific is read off it. */
  def: AwardDef;
  source: AwardSourceMeta | null;
}

/**
 * What the browser needs to draw an award's own screens without a second copy of the
 * registry.
 *
 * The definition is not sent wholesale: the SPARQL query and the repo path are the import
 * job's business and would be dead weight on every page load. These four fields are what the
 * headings, the edition links and the completion sentence are built from.
 */
export interface AwardIdentity {
  id: string;
  title: string;
  /** "Best Picture", "Palme d'Or" -- what the anchor prize is called on screen. */
  anchorLabel: string;
  /** `ordinal` prints "96th"; `year` prints the year alone. See `AwardEdition`. */
  editionKey: "ordinal" | "year";
  editionOne: string;
  editionMany: string;
}

export function awardIdentity(def: AwardDef): AwardIdentity {
  return {
    id: def.id,
    title: def.title,
    anchorLabel: def.anchorLabel,
    editionKey: def.edition.key,
    editionOne: def.edition.one,
    editionMany: def.edition.many,
  };
}

export interface TimelinePayload {
  award: AwardIdentity;
  source: AwardSourceMeta | null;
  totals: {
    ceremonies: number;
    nominations: number;
    wins: number;
    /**
     * Distinct people the nominations name, and therefore whether the leaderboards exist.
     *
     * On this payload because the timeline is what LINKS to them, and a link to a page with
     * nothing on it is the dead end this product refuses to draw: a Wikidata award records
     * who won and names no people at all, so it must not offer a people page. Counted rather
     * than inferred from `nominations === wins` -- that equality says the source is
     * winner-only, which is a different fact and only accidentally the same answer.
     */
    people: number;
  };
  /**
   * The completion count for the anchor prize -- "you own 61 of 98 Best Picture winners".
   *
   * The one number Seerr structurally cannot answer, and it is affordable only because the
   * nominations and the library mirror are in the same file. `total` counts winners with a
   * tconst rather than editions: a winner we cannot identify cannot be owned or not owned,
   * and counting it in the denominator would make 100% unreachable for a reason no reader
   * could see.
   */
  anchor: { noun: string; owned: number; total: number };
  ceremonies: CeremonySummary[];
  /** Decorated rows for the anchor titles we hold. Keyed by tconst; absent means unlinkable. */
  titles: Record<string, unknown>;
}

/**
 * The whole timeline in one payload.
 *
 * Every ceremony ships at once -- 98 rows of counts is a few KB, and paging a timeline
 * whose entire point is that you can see the shape of a century would be paging for the
 * sake of it. The posters are what cost bytes, and those are `<img>` requests the browser
 * paces itself.
 */
export function timelinePayload({ store, engine, decorate, def, source }: AwardsDeps): TimelinePayload {
  const ceremonies = ceremonyTimeline(store, def);

  // One lookup per anchor title, against the live index. A title that is not indexed yields
  // no row and therefore no card -- the edition still renders with its title as text.
  const rows: TitleRow[] = [];
  for (const c of ceremonies) {
    const row = c.anchorTconst ? engine.byTconst(c.anchorTconst) : null;
    if (row) rows.push(row);
  }
  const decorated = decorate(rows);

  const anchorIds = ceremonies.flatMap((c) => (c.anchorTconst ? [c.anchorTconst] : []));

  return {
    award: awardIdentity(def),
    source,
    totals: {
      ceremonies: ceremonies.length,
      nominations: ceremonies.reduce((n, c) => n + c.nominations, 0),
      wins: ceremonies.reduce((n, c) => n + c.wins, 0),
      people: store.awardPersonCount(def.id),
    },
    anchor: {
      noun: anchorNoun(def),
      // Counted against the library mirror rather than against the decorated rows: a
      // winner we do not INDEX could still be in Radarr, and the ownership question is
      // about the library, not about our corpus.
      owned: store.ownedCount(anchorIds),
      total: anchorIds.length,
    },
    ceremonies,
    titles: byTconst(decorated),
  };
}

export interface AwardPeoplePayload {
  award: AwardIdentity;
  source: AwardSourceMeta | null;
  /** Every class this award's people appear in, so a chip is only offered where it leads. */
  classes: AwardPersonClass[];
  /** The class the boards are narrowed to, or `null` for all of them. Echoed so the page
   *  draws the chip that is actually in force rather than the one it asked for. */
  className: string | null;
  boards: PersonLeaderboard[];
}

/**
 * Which people an award's nominations describe, ranked three ways.
 *
 * NO `titles` map and no index lookup, unlike every other payload here: a board names people
 * and no films, so there is nothing to decorate and nothing to ask the live index about. It
 * reads the nomination tables and the registry, which is the whole of it.
 *
 * There is also no headshot. `person_image` is filled as a side effect of somebody opening a
 * title, so coverage grows with use and is never complete -- a column of twenty-five faces
 * that are mostly initials reads as a broken page rather than as an honest one, and the names
 * are what a leaderboard is for.
 *
 * `null` for a class this award does not use, which the caller answers with a 404 exactly as
 * it does for an edition we do not hold. The check lives here rather than in the handler so
 * the classes are read ONCE and the expensive tally is never computed for a URL that is about
 * to be refused.
 */
export function peoplePayload(
  { store, def, source }: AwardsDeps,
  className: string | null,
): AwardPeoplePayload | null {
  const classes = orderPersonClasses(store.awardPersonClasses(def.id));
  if (className !== null && !classes.some((c) => c.className === className)) return null;

  return {
    award: awardIdentity(def),
    source,
    classes,
    className,
    boards: awardPeopleBoards(store.awardPersonTallies(def.id, className), def),
  };
}

/** One nomination as the ceremony page draws it. Ids only; the rows travel beside it. */
export interface NominationView {
  seq: number;
  category: string;
  rawCategory: string;
  /**
   * The source's coarse grouping -- `Acting`, `Production`, `Directing`, ...
   *
   * On the wire because the CEREMONY PAGE reads it: it decides whether a category's rows
   * lead with the person or with the film, and that has to be one answer per category
   * rather than per row. See `isPersonLed` in `web/src/lib/awards-format.ts` for the bug
   * that made it necessary.
   */
  className: string;
  won: boolean;
  films: { title: string; tconst: string | null }[];
  nominees: { name: string; nconst: string | null }[];
  detail: string | null;
  note: string | null;
}

export interface CeremonyPayload {
  award: AwardIdentity;
  ceremony: number;
  year: string;
  nominations: number;
  wins: number;
  categories: number;
  films: number;
  filmsOwned: number;
  /** The edition's headline win, when we know which row it is. */
  anchorFilm: { title: string; tconst: string | null } | null;
  groups: { category: string; nominations: NominationView[] }[];
  titles: Record<string, unknown>;
  /** Which editions exist either side, so the page can step without a second request. */
  prev: number | null;
  next: number | null;
}

/** One edition, every category, winner first. `null` for an edition we do not hold. */
export function ceremonyPayload(deps: AwardsDeps, ceremony: number): CeremonyPayload | null {
  const { store, engine, decorate, def } = deps;
  const rows = store.awardCeremonyRows(def.id, ceremony);
  if (rows.length === 0) return null;

  const groups = groupByCategory(rows, def.anchorCategory);

  // Every title this edition names, resolved once. A `Set` because a film nominated in
  // nine categories must not be looked up nine times, and because the decorated map is
  // keyed by tconst anyway.
  const ids = new Set(rows.flatMap((r) => r.filmIds.filter((id): id is string => id !== null)));
  const indexed: TitleRow[] = [];
  for (const id of ids) {
    const row = engine.byTconst(id);
    if (row) indexed.push(row);
  }

  // ONE call, held in a local. It was called twice -- once here and once for the neighbours
  // below -- and the second call's comment already claimed it used "the counts we already
  // hold", which is exactly what this now makes true. Measured on the real app database: the
  // aggregate is 4.4 ms (a `count(distinct)` over every nomination for the award, plus a join
  // to the library mirror), so the duplicate was most of a ceremony page's query budget spent
  // computing an answer already in memory.
  const ceremonyCounts = store.awardCeremonyCounts(def.id);
  const counts = ceremonyCounts.find((c) => c.ceremony === ceremony);
  // The anchor category when the award has one, and otherwise the edition's first win --
  // which for a one-prize award is the only win there is.
  const anchorGroup =
    def.anchorCategory === null ? groups[0] : groups.find((g) => g.category === def.anchorCategory);
  const anchor = anchorGroup?.nominations.find((n) => n.won);

  // Neighbours from the counts we already hold, so stepping through editions costs no
  // extra query and cannot walk off either end.
  const all = ceremonyCounts.map((c) => c.ceremony);

  return {
    award: awardIdentity(def),
    ceremony,
    year: rows[0]?.year ?? "",
    nominations: counts?.nominations ?? rows.length,
    wins: counts?.wins ?? rows.filter((r) => r.won).length,
    categories: counts?.categories ?? groups.length,
    films: counts?.films ?? ids.size,
    filmsOwned: counts?.filmsOwned ?? 0,
    anchorFilm: anchor ? { title: anchor.films[0] ?? "", tconst: anchor.filmIds[0] ?? null } : null,
    groups: groups.map(toGroupView),
    titles: byTconst(decorate(indexed)),
    // `all` is edition-DESCENDING, so the newer neighbour sits at the lower index.
    prev: all.find((c) => c < ceremony) ?? null,
    next: [...all].reverse().find((c) => c > ceremony) ?? null,
  };
}

function toGroupView(g: CategoryGroup): { category: string; nominations: NominationView[] } {
  return { category: g.category, nominations: g.nominations.map(toNominationView) };
}

/**
 * The wire shape of one nomination.
 *
 * The parallel arrays are zipped HERE rather than in the browser, because the pairing rule
 * -- position, with a hole meaning "no id for this one" -- is the same rule the store
 * round-trips, and it should have one owner on the way out as well as on the way in.
 */
export function toNominationView(n: Nomination): NominationView {
  return {
    seq: n.seq,
    category: n.category,
    rawCategory: n.rawCategory,
    className: n.className,
    won: n.won,
    films: n.films.map((title, i) => ({ title, tconst: n.filmIds[i] ?? null })),
    nominees: n.nominees.map((name, i) => ({ name, nconst: n.nconsts[i] ?? null })),
    detail: n.detail,
    note: n.note,
  };
}

/** Index decorated rows by tconst. The client's "can I link this?" lookup. */
function byTconst<T extends TitleRow>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [r.tconst, r]));
}
