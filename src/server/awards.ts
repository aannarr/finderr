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

import {
  type AwardSourceMeta,
  type CategoryGroup,
  type CeremonySummary,
  ceremonyTimeline,
  groupByCategory,
  type Nomination,
  OSCARS,
  TIMELINE_ANCHOR,
} from "../lib/awards";
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
  source: AwardSourceMeta | null;
}

export interface TimelinePayload {
  award: string;
  source: AwardSourceMeta | null;
  totals: { ceremonies: number; nominations: number; wins: number };
  /**
   * The completion count for the anchor category -- "you own 61 of 98 Best Picture winners".
   *
   * The one number Seerr structurally cannot answer, and it is affordable only because the
   * nominations and the library mirror are in the same file. `total` counts winners with a
   * tconst rather than ceremonies: a winner we cannot identify cannot be owned or not owned,
   * and counting it in the denominator would make 100% unreachable for a reason no reader
   * could see.
   */
  anchor: { category: string; owned: number; total: number };
  ceremonies: CeremonySummary[];
  /** Decorated rows for the anchor films we hold. Keyed by tconst; absent means unlinkable. */
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
export function timelinePayload({ store, engine, decorate, source }: AwardsDeps): TimelinePayload {
  const ceremonies = ceremonyTimeline(store, OSCARS);

  // One lookup per anchor film, against the live index. A film that is not indexed yields
  // no row and therefore no card -- the ceremony still renders with its title as text.
  const rows: TitleRow[] = [];
  for (const c of ceremonies) {
    const row = c.bestPictureTconst ? engine.byTconst(c.bestPictureTconst) : null;
    if (row) rows.push(row);
  }
  const decorated = decorate(rows);

  const anchorIds = ceremonies.flatMap((c) => (c.bestPictureTconst ? [c.bestPictureTconst] : []));

  return {
    award: OSCARS,
    source,
    totals: {
      ceremonies: ceremonies.length,
      nominations: ceremonies.reduce((n, c) => n + c.nominations, 0),
      wins: ceremonies.reduce((n, c) => n + c.wins, 0),
    },
    anchor: {
      category: TIMELINE_ANCHOR,
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
  award: string;
  ceremony: number;
  year: string;
  nominations: number;
  wins: number;
  categories: number;
  films: number;
  filmsOwned: number;
  bestPicture: { title: string; tconst: string | null } | null;
  groups: { category: string; nominations: NominationView[] }[];
  titles: Record<string, unknown>;
  /** Which ceremonies exist either side, so the page can step without a second request. */
  prev: number | null;
  next: number | null;
}

/** One ceremony, every category, winner first. `null` for a ceremony we do not hold. */
export function ceremonyPayload(deps: AwardsDeps, ceremony: number): CeremonyPayload | null {
  const { store, engine, decorate } = deps;
  const rows = store.awardCeremonyRows(OSCARS, ceremony);
  if (rows.length === 0) return null;

  const groups = groupByCategory(rows);

  // Every film this ceremony names, resolved once. A `Set` because a film nominated in
  // nine categories must not be looked up nine times, and because the decorated map is
  // keyed by tconst anyway.
  const ids = new Set(rows.flatMap((r) => r.filmIds.filter((id): id is string => id !== null)));
  const indexed: TitleRow[] = [];
  for (const id of ids) {
    const row = engine.byTconst(id);
    if (row) indexed.push(row);
  }

  const counts = store.awardCeremonyCounts(OSCARS).find((c) => c.ceremony === ceremony);
  const anchor = groups.find((g) => g.category === TIMELINE_ANCHOR)?.nominations.find((n) => n.won);

  // Neighbours from the counts we already hold, so stepping through ceremonies costs no
  // extra query and cannot walk off either end.
  const all = store.awardCeremonyCounts(OSCARS).map((c) => c.ceremony);

  return {
    award: OSCARS,
    ceremony,
    year: rows[0]?.year ?? "",
    nominations: counts?.nominations ?? rows.length,
    wins: counts?.wins ?? rows.filter((r) => r.won).length,
    categories: counts?.categories ?? groups.length,
    films: counts?.films ?? ids.size,
    filmsOwned: counts?.filmsOwned ?? 0,
    bestPicture: anchor ? { title: anchor.films[0] ?? "", tconst: anchor.filmIds[0] ?? null } : null,
    groups: groups.map(toGroupView),
    titles: byTconst(decorate(indexed)),
    // `all` is ceremony-DESCENDING, so the newer neighbour sits at the lower index.
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
