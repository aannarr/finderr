/**
 * WHAT THE RENDER PATH ACTUALLY ASKS THE INDEX -- one named scenario per question.
 *
 * This is the maintainable half of the speed harness (`src/jobs/bench-index.ts` is the
 * runner). A scenario is a NAME, an example ARGUMENT set, and a call into the real code.
 *
 * > [!IMPORTANT] A scenario names a QUESTION; it never restates the SQL
 * > The obvious way to build a query benchmark is a list of SQL strings with example
 * > parameters. It is also wrong here, for the reason this repo keeps re-learning: a copy of
 * > a query is a second owner of it, and the copy is the one nobody updates. A benchmark
 * > whose SQL has drifted from the shipping SQL reports on a query that no longer exists,
 * > and it reports it in a green table that nobody re-reads.
 * >
 * > So a scenario CALLS the real function, and the runner captures whatever statements that
 * > call actually ran (see `recordingDb`). Change a query in `search.ts` and the benchmark
 * > measures the new one on the next run, with no edit here. What needs maintaining is only
 * > the list of QUESTIONS worth asking, which is a product decision and changes far more
 * > slowly than the SQL under it.
 *
 * **Adding a scenario is one entry.** Keep the arguments realistic -- `Drama` is the largest
 * genre and `2010` the densest decade, chosen because a benchmark on the easy case is how a
 * slow path stays hidden. Where a cheap and an expensive form of one question both exist,
 * include both: `browse decade` and `browse year` differ by two orders of magnitude and the
 * pair is what shows why.
 */

import type { SearchEngine } from "./search";

/** One named question, and the call that asks it. */
export interface Scenario {
  /** Stable id -- the report is diffed across runs, so this must not drift casually. */
  id: string;
  /** Which surface pays for it, so a regression can be read as a page rather than a query. */
  surface: "discover" | "search" | "browse" | "title" | "person" | "lists";
  /** The example arguments, printed in the report so a number can be reproduced by hand. */
  args: string;
  run: (engine: SearchEngine) => unknown;
}

/**
 * Ids used as arguments, resolved from the index at run time rather than hardcoded.
 *
 * A hardcoded `tt0111161` is a fact about the IMDb dump that can stop being true, and a
 * benchmark that silently measures a miss is worse than one that fails -- a `byTconst` that
 * finds nothing is fast for the wrong reason. The runner fills these from the top of the
 * index and passes them in.
 */
export interface BenchFixtures {
  /** A well-known title, from the top of the ranked list. */
  tconst: string;
  /** A series with episodes, so the episode scenarios measure rows rather than an empty set. */
  seriesTconst: string;
  /** A person with a long filmography. */
  nconst: string;
  /** The genre the index actually has most of. */
  genre: string;
}

export function scenarios(f: BenchFixtures): Scenario[] {
  return [
    // --- the front page. Every one of these runs before anything is on screen.
    { id: "discover.topGenres", surface: "discover", args: "limit=6", run: (e) => e.topGenres(6) },
    { id: "discover.topRated", surface: "discover", args: "limit=30", run: (e) => e.topRated({ limit: 30 }) },
    {
      id: "discover.newThisDecade",
      surface: "discover",
      args: "limit=30",
      run: (e) => e.newThisDecade({ limit: 30 }),
    },
    {
      id: "discover.topRatedInGenre",
      surface: "discover",
      args: `genre=${f.genre} limit=30`,
      run: (e) => e.topRatedInGenre(f.genre, { limit: 30 }),
    },
    // Off the front page today, but still a public method and still 25 ms -- kept so the
    // number stays visible if anybody puts the shelf back.
    {
      id: "discover.hiddenGems",
      surface: "discover",
      args: "limit=30",
      run: (e) => e.hiddenGems({ limit: 30 }),
    },
    // The N+1 every shelf runs: one lookup per id, thirty times.
    {
      id: "discover.shelfHydrate",
      surface: "discover",
      args: "30 x byTconst",
      run: (e) => {
        const ids = e.topRated({ limit: 30 }).map((r) => r.tconst);
        return ids.map((id) => e.byTconst(id));
      },
    },

    // --- search. The tiers differ by an order of magnitude, so one query is not a sample.
    {
      id: "search.exact",
      surface: "search",
      args: 'q="inception"',
      run: (e) => e.search("inception", { limit: 20 }),
    },
    {
      id: "search.multiword",
      surface: "search",
      args: 'q="the matrix"',
      run: (e) => e.search("the matrix", { limit: 20 }),
    },
    {
      id: "search.series",
      surface: "search",
      args: 'q="breaking bad"',
      run: (e) => e.search("breaking bad", { limit: 20 }),
    },
    // A stopword-led query -- the case `ix_pop_title` exists for.
    { id: "search.stopword", surface: "search", args: 'q="the"', run: (e) => e.search("the", { limit: 20 }) },
    // Typo: the fuzzy tier. Needs spellfix1 loaded or this measures an absent feature.
    {
      id: "search.fuzzy",
      surface: "search",
      args: 'q="incepton"',
      run: (e) => e.search("incepton", { limit: 20 }),
    },
    {
      id: "search.broad",
      surface: "search",
      args: 'q="star wars"',
      run: (e) => e.search("star wars", { limit: 20 }),
    },

    // --- browse. The grid, and every filter shape that reaches it.
    {
      id: "browse.kind",
      surface: "browse",
      args: "kind=movie",
      run: (e) => e.browse({ kind: "movie", limit: 40 }),
    },
    {
      id: "browse.genreVotes",
      surface: "browse",
      args: `genre=${f.genre} sort=votes`,
      run: (e) => e.browse({ genre: f.genre, limit: 40 }),
    },
    // The 807 ms one. Every computed top list is this shape.
    {
      id: "browse.genreRank",
      surface: "browse",
      args: `genre=${f.genre} sort=rank`,
      run: (e) => e.browse({ genre: f.genre, sort: "rank", limit: 40 }),
    },
    // Paging a top list -- the offset is where the old plan hurt most (1074 ms).
    {
      id: "browse.genreRankDeep",
      surface: "browse",
      args: `genre=${f.genre} sort=rank offset=200`,
      run: (e) => e.browse({ genre: f.genre, sort: "rank", limit: 40, offset: 200 }),
    },
    // The no-genre ranked list -- "finderr Top 250" itself.
    {
      id: "browse.rankAll",
      surface: "browse",
      args: "sort=rank",
      run: (e) => e.browse({ sort: "rank", limit: 40 }),
    },
    // A decade is a RANGE and is split into ten seeks; a single year is one seek. The pair
    // is deliberate -- it is what shows the split is doing something.
    {
      id: "browse.decade",
      surface: "browse",
      args: "decade=2010",
      run: (e) => e.browse({ decade: 2010, limit: 40 }),
    },
    {
      id: "browse.year",
      surface: "browse",
      args: "year=1995",
      run: (e) => e.browse({ year: 1995, limit: 40 }),
    },
    // The floored-empty page: a narrow year that trips the second, unfloored count.
    {
      id: "browse.sparseYear",
      surface: "browse",
      args: "year=1901",
      run: (e) => e.browse({ year: 1901, limit: 40 }),
    },
    {
      id: "browse.genreAndKind",
      surface: "browse",
      args: `genre=${f.genre} kind=movie`,
      run: (e) => e.browse({ genre: f.genre, kind: "movie", limit: 40 }),
    },

    // --- lists. `/lists` asks for the head of every computed list at once.
    {
      id: "lists.rankedMembers",
      surface: "lists",
      args: `genre=${f.genre} size=250`,
      run: (e) => e.rankedMembers({ genre: f.genre }, 250),
    },

    // --- the title page's local half: everything on screen at t=0.
    { id: "title.byTconst", surface: "title", args: f.tconst, run: (e) => e.byTconst(f.tconst) },
    { id: "title.externalIds", surface: "title", args: f.tconst, run: (e) => e.idsFor(f.tconst) },
    {
      id: "title.episodes",
      surface: "title",
      args: `${f.seriesTconst} all seasons`,
      run: (e) => e.episodesOf(f.seriesTconst),
    },
    {
      id: "title.episodesTopRated",
      surface: "title",
      args: `${f.seriesTconst} minRating=8`,
      run: (e) => e.episodesOf(f.seriesTconst, { minRating: 8 }),
    },

    // --- person pages: the reverse edge.
    { id: "person.page", surface: "person", args: f.nconst, run: (e) => e.personPage(f.nconst) },
    {
      id: "person.collaborators",
      surface: "person",
      args: f.nconst,
      run: (e) => e.frequentCollaborators(f.nconst),
    },
    { id: "person.search", surface: "person", args: 'q="nolan"', run: (e) => e.searchPeople("nolan") },
  ];
}
