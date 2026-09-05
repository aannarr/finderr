/**
 * The nine tools an LLM agent meets, over the local index and nothing else.
 *
 * Design and rationale: `.claude/docs/agent-tools-design.md`. The short version, because
 * the shape here only makes sense with it:
 *
 * - **T0 resolves a NAME to an id plus enough metadata to disambiguate.** Everything past
 *   T0 takes ids only, which is what makes skipping resolution a schema violation rather
 *   than a bad habit. That constraint is the whole design; descriptions are advice, a type
 *   is a wall.
 * - **When OUR OWN threshold is what emptied a result, the response says so.**
 *   `loose_would_match` on the resolvers, `hiddenByFloor` on browse, `status` on
 *   `findConnections`. A tool may return nothing; it may never let nothing be mistaken for
 *   absence. This is the house rule and it exists because a model that reads an empty
 *   result as "does not exist" will state that as a fact about the world.
 * - **Arrays in, union OR intersection out.** N titles in one call, and the intersection is
 *   computed in SQL rather than by the model paying for every row to keep two.
 *
 * Every function here is pure over its `AgentContext` and touches nothing but local SQLite,
 * which is the governing rule of the product applied to the agent surface.
 */

import type { Database } from "bun:sqlite";
import type { BrowseSort, SearchEngine, TitleRow } from "../search.js";
import type { AgentActions, RequestResult } from "./actions.js";

/**
 * What the tools read through.
 *
 * `db` is a SECOND read-only handle on the same file the engine holds, because
 * `SearchEngine.db` is private and the cast-graph walk needs raw SQL the engine does not
 * expose. That is safe for the harness -- one host, read-only, and SQLite's WAL readers are
 * documented to coexist -- but it is NOT how this should be wired into the server.
 *
 * > [!CAUTION] In the server this must go through `LiveIndex`, not a second `new Database`
 * > After `promote()` an independently-opened handle either throws `SQLITE_IOERR_VNODE` or,
 * > under load, silently serves a row from yesterday's file. A second owner of `titles.db`
 * > in the server process inherits exactly that on every daily refresh.
 */
export interface AgentContext {
  db: Database;
  engine: SearchEngine;
  /**
   * The write capability. ABSENT means read-only, and that is the default.
   *
   * Optional rather than always-present because the benchmark harness must not be able to
   * start a download, and because "the tool is not offered" is a cleaner read-only mode than
   * "the tool is offered and always errors" -- `toolSchemasFor` never advertises `request`
   * to a context without this, so a model is never taught to reach for something that
   * cannot work. See `./actions.ts`.
   */
  actions?: AgentActions;
  /**
   * The deployment's language preference, already through `languageFilter`.
   *
   * On the CONTEXT rather than read from config inside the tool, for the reason every other
   * capability here follows: these functions are pure over what they are handed, so a test
   * sets a preference by constructing a context rather than by mutating global config. It
   * is also what keeps `makeContext` the one place the fail-open rule is applied.
   *
   * Absent or empty = no preference, which is the default and the behaviour before this.
   */
  languages?: readonly string[];
}

/** How much the caller trusts the string it is passing. Never about spelling ability. */
export type MatchMode = "exact" | "strict" | "loose";

/** Which tier actually answered. `fuzzy` means the spellfix tier was needed. */
export type MatchedBy = string;

export const TITLE_KINDS = ["movie", "tvSeries", "tvMovie", "tvMiniSeries"] as const;
export type TitleKind = (typeof TITLE_KINDS)[number];

/** Extras a caller may opt into on `findTitle`. Local seeks only -- never a facet. */
export const TITLE_FIELDS = ["genres", "runtime", "rating", "orig", "origin"] as const;
export type TitleField = (typeof TITLE_FIELDS)[number];

/** Extras a caller may opt into on `findPerson`. */
export const PERSON_FIELDS = ["known_for", "credit_count"] as const;
export type PersonField = (typeof PERSON_FIELDS)[number];

/**
 * A resolved title as an agent sees it.
 *
 * `orig` and `end_year` are present CONDITIONALLY -- absent means "same as title" and
 * "still running". Conditional presence is right for both: the common case costs no tokens
 * and the informative case is self-describing.
 *
 * > [!CAUTION] `runtime` means two different things and nothing in the column says which
 * > Measured 2026-09-04: `Modern Family` reports 22 (per episode), `The Bear` reports 1611
 * > (the whole run). Same column, same `kind`. It is IMDb's data, not a builder bug, and an
 * > agent that reads it for a series will tell somebody a half-hour comedy runs 27 hours.
 * > It is opt-in via `fields` for that reason, and the schema description says FILM ONLY.
 */
export interface TitleRef {
  tconst: string;
  title: string;
  orig?: string;
  year: number | null;
  end_year?: number;
  kind: string;
  votes: number;
  matched_by?: MatchedBy;
  genres?: string[];
  runtime?: number | null;
  rating?: number;
  /**
   * ISO 639-1 original languages, opt-in via `fields: ["origin"]`.
   *
   * ABSENT means not asked for; `[]` means asked for and nobody knows. A model must be able
   * to tell those apart, because the second is a fact about the title and the first is a
   * fact about the call it made.
   */
  lang?: string[];
  /** ISO 3166-1 countries of origin, opt-in on the same field. Same absent-vs-empty rule. */
  country?: string[];
}

export interface PersonRef {
  nconst: string;
  name: string;
  birth_year: number | null;
  death_year: number | null;
  matched_by?: MatchedBy;
  known_for?: TitleRef[];
  credit_count?: number;
}

/**
 * What every resolver returns.
 *
 * `loose_would_match` is present ONLY when `found` is empty AND a looser mode would have
 * matched. It is a COUNT rather than the rows: cheap to produce, and it makes "we stopped
 * looking" impossible to confuse with "it does not exist" without paying for results the
 * caller did not ask for.
 */
export interface Resolution<T> {
  found: T[];
  searched: string;
  loose_would_match?: number;
}

export interface FindTitleArgs {
  name: string;
  year?: number;
  years?: [number, number];
  kind?: TitleKind[];
  match?: MatchMode;
  fields?: TitleField[];
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function clamp(n: number | undefined, def: number, max: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

/** Case- and whitespace-insensitive equality, which is all `exact` promises. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function toTitleRef(
  ctx: AgentContext,
  row: TitleRow,
  fields: readonly TitleField[] = [],
  matchedBy?: string,
): TitleRef {
  const want = new Set(fields);
  const ref: TitleRef = {
    tconst: row.tconst,
    title: row.title,
    year: row.year,
    kind: row.kind,
    votes: row.votes,
  };
  if (matchedBy) ref.matched_by = matchedBy;
  // Conditional, not opt-in: absent means "same as title", which costs nothing to say.
  if (row.orig && row.orig !== row.title) ref.orig = row.orig;
  if (want.has("genres")) ref.genres = row.genres ? row.genres.split(",").filter(Boolean) : [];
  if (want.has("runtime")) ref.runtime = row.runtime;
  if (want.has("rating")) ref.rating = row.rating;
  if (want.has("origin")) {
    // One extra seek per row, which is why it is opt-in. An index with no origin stage
    // leaves both fields ABSENT rather than empty -- see `SearchEngine.originOf`: "I cannot
    // tell you" and "nobody knows" must not arrive looking the same.
    const origin = ctx.engine.originOf(row.tconst);
    if (origin) {
      ref.lang = origin.lang;
      ref.country = origin.country;
    }
  }
  return ref;
}

/**
 * Name -> title, with the metadata that tells two candidates apart.
 *
 * `match` gates on the tier the ENGINE reports rather than re-implementing a matcher:
 * `strict` refuses an answer that needed the spellfix tier, and says how many it refused.
 * One search call serves both halves -- the refused hits ARE the `loose_would_match` count,
 * so the honest-empty answer costs nothing extra.
 */
export function findTitle(ctx: AgentContext, args: FindTitleArgs): Resolution<TitleRef> {
  const limit = clamp(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const mode: MatchMode = args.match ?? "strict";
  const kinds = args.kind && args.kind.length > 0 ? new Set<string>(args.kind) : null;

  const result = ctx.engine.search(args.name, {
    limit: Math.max(limit * 4, 40),
    facets: false,
    // The engine takes ONE kind; a multi-kind ask is filtered below rather than run N times.
    ...(kinds?.size === 1 ? { kind: [...kinds][0] } : {}),
    ...(args.year ? { year: args.year } : {}),
  });

  let hits = result.hits.filter((h) => {
    if (kinds && !kinds.has(h.kind)) return false;
    if (args.years) {
      if (h.year === null) return false;
      if (h.year < args.years[0] || h.year > args.years[1]) return false;
    }
    return true;
  });

  if (mode === "exact") {
    hits = hits.filter((h) => sameName(h.title, args.name) || (h.orig ? sameName(h.orig, args.name) : false));
  }

  // `strict` refuses the spellfix tier. The refusal is REPORTED, never silent.
  if (mode === "strict" && result.tier === "fuzzy") {
    return { found: [], searched: args.name, loose_would_match: hits.length };
  }

  const found = hits.slice(0, limit).map((h) => {
    const ref = toTitleRef(ctx, h, args.fields ?? [], result.tier);
    const end = endYearOf(ctx.db, h.tconst);
    if (end !== null) ref.end_year = end;
    return ref;
  });

  if (found.length === 0 && mode !== "loose") {
    const loose = ctx.engine.search(args.name, { limit: 5, facets: false });
    if (loose.hits.length > 0) {
      return { found: [], searched: args.name, loose_would_match: loose.hits.length };
    }
  }
  return { found, searched: args.name };
}

/** `end_year` is not on `TitleRow`, and "still running" is a fact worth carrying. */
function endYearOf(db: Database, tconst: string): number | null {
  const row = db.query("select end_year from title where tconst = ?").get(tconst) as
    | { end_year: number | null }
    | undefined;
  return row?.end_year ?? null;
}

export interface FindPersonArgs {
  name: string;
  match?: MatchMode;
  fields?: PersonField[];
  limit?: number;
}

/**
 * Name -> person. `birth_year` is what makes this usable at all.
 *
 * A name is not unique across 353k people; a name plus a birth year effectively is. So the
 * disambiguator is always present and `known_for` -- three sub-rows per person -- is opt-in.
 *
 * Returns a resolution with an explicit `unavailable` reason when the index predates the
 * person search stage, rather than an empty list: "this index cannot answer" and "no such
 * person" are different facts and an agent must not merge them.
 */
export function findPerson(
  ctx: AgentContext,
  args: FindPersonArgs,
): Resolution<PersonRef> & { unavailable?: string } {
  const limit = clamp(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const hits = ctx.engine.searchPeople(args.name, { limit: limit * 2 });

  if (hits === null) {
    return {
      found: [],
      searched: args.name,
      unavailable:
        "This index was built before the person-search stage; names cannot be resolved to people. " +
        "Person ids from other tools still work.",
    };
  }

  let rows = hits;
  if ((args.match ?? "strict") === "exact") rows = rows.filter((p) => sameName(p.name, args.name));

  const want = new Set(args.fields ?? []);
  const found: PersonRef[] = rows.slice(0, limit).map((p) => {
    const ref: PersonRef = {
      nconst: p.nconst,
      name: p.name,
      birth_year: p.birthYear,
      death_year: p.deathYear,
    };
    if (want.has("credit_count")) ref.credit_count = p.credits;
    if (want.has("known_for")) {
      const page = ctx.engine.personPage(p.nconst, { limit: 3, sort: "votes" });
      ref.known_for = (page?.credits ?? []).map((c) => toTitleRef(ctx, c));
    }
    return ref;
  });
  return { found, searched: args.name };
}

export type MergeMode = "union" | "intersection";

export interface ListCastArgs {
  tconst: string[];
  roles?: string[];
  mode?: MergeMode;
  limit?: number;
}

export interface CastRow {
  nconst: string;
  name: string;
  role: string;
  /** IMDb billing order. The only signal for who the lead is -- "the guy from X" is a lead. */
  billing: number;
  seen_in: string[];
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

/**
 * Who is in these titles. ARRAY in, union or intersection out.
 *
 * `limit` is a TOTAL across every id, never per id -- three titles at 20 each is a 60-row
 * response nobody asked for, and it is the easiest thing here to implement wrongly.
 */
export function listCast(ctx: AgentContext, args: ListCastArgs): CastRow[] {
  const ids = [...new Set(args.tconst)].filter(Boolean);
  if (ids.length === 0) return [];
  const limit = clamp(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const holes = ids.map(() => "?").join(",");
  const roleClause = args.roles?.length ? ` and tp.category in (${args.roles.map(() => "?").join(",")})` : "";
  const having = args.mode === "intersection" ? "having count(distinct t.tconst) = ?" : "";

  const sql = `
    select p.nconst, p.name,
           min(tp.ordering) as billing,
           group_concat(distinct tp.category) as roles,
           group_concat(distinct t.tconst) as seen_in
    from title t
    join title_principal tp on tp.title_rowid = t.rowid_
    join person p on p.rowid_ = tp.person_rowid
    where t.tconst in (${holes})${roleClause}
    group by p.rowid_
    ${having}
    order by billing asc
    limit ?`;

  const params: (string | number)[] = [...ids, ...(args.roles ?? [])];
  if (args.mode === "intersection") params.push(ids.length);
  params.push(limit);

  const rows = ctx.db.query(sql).all(...params) as {
    nconst: string;
    name: string;
    billing: number;
    roles: string;
    seen_in: string;
  }[];

  return rows.map((r) => ({
    nconst: r.nconst,
    name: r.name,
    role: r.roles.split(",")[0] ?? "",
    billing: r.billing,
    seen_in: r.seen_in.split(","),
  }));
}

export interface ListCreditsArgs {
  nconst: string[];
  kind?: TitleKind[];
  years?: [number, number];
  roles?: string[];
  mode?: MergeMode;
  limit?: number;
}

export interface CreditRow {
  tconst: string;
  title: string;
  year: number | null;
  kind: string;
  votes: number;
  role: string;
  seen_with: string[];
}

/**
 * What these people have been in. The mirror of `listCast`, and the recency lever.
 *
 * "A new film by that actor" is `years: [2025, 2026]` here -- a filter, not a tool. The
 * index is rebuilt daily from IMDb, so this is the one question a model's weights are
 * reliably wrong about and this table is reliably right about.
 */
export function listCredits(ctx: AgentContext, args: ListCreditsArgs): CreditRow[] {
  const ids = [...new Set(args.nconst)].filter(Boolean);
  if (ids.length === 0) return [];
  const limit = clamp(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const holes = ids.map(() => "?").join(",");

  const where: string[] = [`p.nconst in (${holes})`];
  const params: (string | number)[] = [...ids];
  if (args.roles?.length) {
    where.push(`tp.category in (${args.roles.map(() => "?").join(",")})`);
    params.push(...args.roles);
  }
  if (args.kind?.length) {
    where.push(`t.kind in (${args.kind.map(() => "?").join(",")})`);
    params.push(...args.kind);
  }
  if (args.years) {
    where.push("t.year between ? and ?");
    params.push(args.years[0], args.years[1]);
  }
  const having = args.mode === "intersection" ? "having count(distinct p.nconst) = ?" : "";
  if (args.mode === "intersection") params.push(ids.length);
  params.push(limit);

  const sql = `
    select t.tconst, t.title, t.year, t.kind, t.votes,
           group_concat(distinct tp.category) as roles,
           group_concat(distinct p.nconst) as seen_with
    from person p
    join title_principal tp on tp.person_rowid = p.rowid_
    join title t on t.rowid_ = tp.title_rowid
    where ${where.join(" and ")}
    group by t.rowid_
    ${having}
    order by t.votes desc
    limit ?`;

  const rows = ctx.db.query(sql).all(...params) as {
    tconst: string;
    title: string;
    year: number | null;
    kind: string;
    votes: number;
    roles: string;
    seen_with: string;
  }[];

  return rows.map((r) => ({
    tconst: r.tconst,
    title: r.title,
    year: r.year,
    kind: r.kind,
    votes: r.votes,
    role: r.roles.split(",")[0] ?? "",
    seen_with: r.seen_with.split(","),
  }));
}

export interface BrowseArgs {
  genre?: string;
  kind?: TitleKind;
  year?: number;
  decade?: number;
  /** Inclusive `[from, to]`, for the span no decade expresses -- "the last fifteen years". */
  years?: [number, number];
  min_votes?: number;
  /**
   * Lift the deployment's language preference for this one call.
   *
   * `true` means "show me everything regardless of language", and it is the agent's half of
   * the same escape hatch `min_votes: 0` is for the vote floor -- the tool reports
   * `hidden_by_language` and the model may then ask again without it. There is deliberately
   * no way to REQUEST a language here: the preference is the deployment's, and a model
   * choosing its own would be inventing an answer to a question nobody asked it.
   */
  any_language?: boolean;
  sort?: BrowseSort;
  limit?: number;
}

/**
 * Discovery with NO name anchor -- "good sci-fi from the 80s".
 *
 * Without this the whole class has no entry point, because T0 is name-anchored. It is a
 * thin wrapper over `browseIndex`, which means it inherits `hiddenByFloor` for free: the
 * same honesty rule as `loose_would_match`, already shipped.
 */
export function browseTitles(ctx: AgentContext, args: BrowseArgs) {
  const limit = clamp(args.limit, 10, MAX_LIST_LIMIT);
  const res = ctx.engine.browse({
    genre: args.genre,
    kind: args.kind,
    year: args.year,
    decade: args.decade,
    years: args.years,
    minVotes: args.min_votes,
    // The preference comes from the CONTEXT, never from the model. `any_language` can only
    // remove it -- see `BrowseArgs.any_language`.
    languages: args.any_language ? [] : ctx.languages,
    sort: args.sort ?? "votes",
    limit,
  });
  return {
    titles: res.rows.map((r) => toTitleRef(ctx, r, ["genres", "rating"])),
    total: res.total,
    ...(res.hiddenByFloor
      ? { hidden_by_floor: { titles: res.hiddenByFloor.titles, min_votes: res.hiddenByFloor.minVotes } }
      : {}),
    ...(res.hiddenByLanguage
      ? {
          hidden_by_language: {
            titles: res.hiddenByLanguage.titles,
            languages: res.hiddenByLanguage.languages,
          },
        }
      : {}),
  };
}

/** Everything local about one title, including whether we HAVE it. Never a facet. */
export function getTitle(ctx: AgentContext, tconst: string): (TitleRef & { genres: string[] }) | null {
  const row = ctx.engine.byTconst(tconst);
  if (!row) return null;
  const ref = toTitleRef(ctx, row, ["genres", "runtime", "rating", "origin"]) as TitleRef & {
    genres: string[];
  };
  const end = endYearOf(ctx.db, tconst);
  if (end !== null) ref.end_year = end;
  return ref;
}

export function getPerson(ctx: AgentContext, nconst: string, opts: { credits?: number } = {}) {
  const page = ctx.engine.personPage(nconst, { limit: clamp(opts.credits, 10, 50), sort: "votes" });
  if (!page) return null;
  return {
    nconst: page.person.nconst,
    name: page.person.name,
    birth_year: page.person.birthYear,
    death_year: page.person.deathYear,
    credit_count: page.total,
    top_credits: page.credits.map((c) => toTitleRef(ctx, c)),
    collaborators: ctx.engine.frequentCollaborators(nconst, { limit: 5 }).map((c) => ({
      nconst: c.nconst,
      name: c.name,
      shared: c.shared,
    })),
  };
}

export interface ListEpisodesArgs {
  tconst: string;
  season?: number;
  min_rating?: number;
  min_votes?: number;
  limit?: number;
}

/**
 * The episodes of one series, with their own IMDb scores.
 *
 * Reads the episode stage of the index -- see `SearchEngine.episodesOf`. Local SQLite like
 * every other read here; no provider, no call.
 *
 * > [!IMPORTANT] AN UNRATED EPISODE HAS `rating: null`, AND NULL IS NOT A LOW SCORE
 * > A brand-new episode has almost no votes, and one that aired last night may have no
 * > ratings row at all. `min_rating` therefore EXCLUDES nulls rather than treating them as
 * > zero -- but they are still returned when no filter is applied, because "the last two
 * > have no score yet" is a true and useful answer and silently dropping them would make
 * > the newest episodes invisible in exactly the week people ask about them.
 * >
 * > This is also why the index floors on the SERIES rather than the episode. An
 * > episode-level vote floor would delete the newest episodes permanently.
 */
export function listEpisodes(ctx: AgentContext, args: ListEpisodesArgs) {
  if (!ctx.engine.hasEpisodes) {
    return {
      error:
        "This index has no episode data. It was built before the episode stage existed and " +
        "will have it after the next nightly rebuild. Answer at the series level instead.",
    };
  }
  const rows = ctx.engine.episodesOf(args.tconst, {
    season: args.season,
    minRating: args.min_rating,
    minVotes: args.min_votes,
    limit: clamp(args.limit, 200, 500),
  });
  if (rows.length === 0) {
    // An honest empty, in the shape the other tools use: say WHY nothing came back, so the
    // model reports "no episodes clear 8.0" rather than inventing some that do.
    return {
      tconst: args.tconst,
      episodes: [],
      note: "No episodes matched. The series may not be in the episode index, or nothing clears the filter.",
    };
  }
  return {
    tconst: args.tconst,
    episodes: rows.map((e) => ({
      tconst: e.tconst,
      season: e.season,
      episode: e.number,
      title: e.title,
      rating: e.rating,
      votes: e.votes,
    })),
    /*
      Counted here rather than left for the model to work out.

      A model asked "how many are over 8" that has to count a 73-row list itself will
      sometimes get it wrong, and the miscount reads as a fact about the library. The
      database already knows.
    */
    total: rows.length,
    unrated: rows.filter((e) => e.rating === null).length,
  };
}

export interface RequestArgs {
  tconst: string | string[];
  episodes?: { season: number; episode: number }[];
}

/**
 * THE ONLY TOOL THAT CHANGES ANYTHING. It starts real downloads.
 *
 * Everything else in this file answers a question. This one spends disk, bandwidth and an
 * indexer's goodwill, and undoing it is a human deleting things in Radarr. aannarr chose
 * immediate execution over a confirmation step on 2026-09-04 with that trade stated; the
 * guard rails are in `./actions.ts` and are about BOUNDING a runaway rather than asking
 * permission.
 *
 * Two grains in one tool, deliberately -- "get me the series" and "get me these six
 * episodes of it" are the same verb with a different object, and splitting them would give
 * one rule two implementations to drift apart in. That is the same reasoning
 * `/api/requests/season` already applies to a list of seasons.
 */
export function requestTitles(ctx: AgentContext, args: RequestArgs): RequestResult | { error: string } {
  const actions = ctx.actions;
  if (!actions) {
    return { error: "This session cannot make requests." };
  }

  const ids = (Array.isArray(args.tconst) ? args.tconst : [args.tconst]).filter(
    (t): t is string => typeof t === "string" && t.startsWith("tt"),
  );
  if (ids.length === 0) {
    return { error: "Expected tt… ids. This tool never takes names -- call find_title first." };
  }

  // The episode grain is scoped to ONE series, because an episode number means nothing
  // without the series it belongs to and a flat list of pairs across several would be
  // ambiguous in exactly the way that starts the wrong download.
  if (args.episodes && args.episodes.length > 0) {
    if (ids.length !== 1) {
      return { error: "Requesting episodes takes exactly one series tconst." };
    }
    const wanted = args.episodes
      .filter((e) => Number.isInteger(e?.season) && Number.isInteger(e?.episode))
      .map((e) => ({ season: e.season, number: e.episode }));
    if (wanted.length === 0) return { error: "episodes must be {season, episode} integer pairs." };

    const { allowed, capped } = admitted(actions, wanted);
    const results = allowed.length > 0 ? actions.requestEpisodes(ids[0] as string, allowed) : [];
    return finish(actions, results, capped);
  }

  const { allowed, capped } = admitted(actions, ids);
  const results = allowed.length > 0 ? actions.requestTitles(allowed) : [];
  return finish(actions, results, capped);
}

/** Apply the conversation cap before anything is started, never after. */
function admitted<T>(actions: AgentActions, items: T[]) {
  const room = actions.remaining();
  if (items.length <= room) return { allowed: items, capped: undefined };
  return {
    allowed: items.slice(0, room),
    capped: { asked: items.length, limit: room + 0, remaining: room },
  };
}

/**
 * Charge the budget for what actually STARTED, and report the cap when it bit.
 *
 * Only `queued` is charged: a title already in the library cost nothing to refuse, and
 * charging for it would let a reader's existing collection eat the allowance for the one
 * thing they actually wanted.
 */
function finish(
  actions: AgentActions,
  results: RequestResult["results"],
  capped: RequestResult["capped"],
): RequestResult {
  const queued = results.filter((r) => r.status === "queued").length;
  actions.spend(queued);
  return { results, queued, ...(capped ? { capped } : {}) };
}

/** The "...and now show me" verb. Terminal: an agent that navigates mid-reasoning thrashes the screen. */
export function navigate(id: string): { ok: boolean; path?: string; error?: string } {
  if (/^tt\d+$/.test(id)) return { ok: true, path: `/title/${id}/` };
  if (/^nm\d+$/.test(id)) return { ok: true, path: `/person/${id}/` };
  return { ok: false, error: `Not an id. Expected tt… or nm…, got ${JSON.stringify(id)}` };
}
