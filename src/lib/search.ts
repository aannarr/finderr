/**
 * The search engine.
 *
 * Three tiers, escalated AUTOMATICALLY on zero rows / low score / low coverage /
 * thin margin. The user never asks for fuzzy matching -- they just type badly and
 * get the right answer.
 *
 *   1. FTS    AND over normalized title + original title + despaced blob   0-5ms
 *   2. OR     same, OR'd, stopwords dropped, gated on token coverage       30-70ms
 *   3. FUZZY  spellfix1 over the vocabulary in the index file              ~12ms
 *
 * There used to be a fourth tier. `LEV` ran a Levenshtein scan across an in-memory
 * pool for short queries, because the trigram index that served tier 4 is blind under
 * about six characters. Both tiers were backed by a trigram index rebuilt in RAM on
 * every boot -- 205k entries, ~9M live objects, 1,514 MB, which cost 14.5% of a core
 * in GC on an idle container. spellfix1 does edit distance and phonetic matching from
 * one disk-backed table, so the two tiers collapsed into one that holds nothing.
 *
 * `Tier` keeps `lev` in its union deliberately: it is serialised into the search API
 * response, and an old client or a stored log line may still carry it.
 */

import { Database } from "bun:sqlite";
import type { Config } from "./config";
import { type TitleIds, titleIds } from "./crosswalk";
import { despace, normalize, normalizeStripped, similarity, trigrams } from "./normalize";
import {
  type Collaborator,
  type CollaboratorOptions,
  frequentCollaborators,
  nconstsByNameForTitle,
  type PersonCreditsOptions,
  type PersonPage,
  personPage,
} from "./people";
import { kindScore, type ParsedQuery, parseQuery, recencyScore, yearScore } from "./query-parser";
import { STOPWORD_VOTE_FLOOR, STOPWORDS, stopwordTokens } from "./search-stopwords";
import { loadSpellfix, SPELLFIX_MAP_TABLE, SPELLFIX_TABLE } from "./spellfix";

/**
 * Which escalation answered a query, as a value list rather than a bare union.
 *
 * The list is here and the type is derived from it because the tier travels to the browser
 * and comes back on a click report (`parseClickBody` in `./search-log.ts`), so something
 * has to be able to CHECK a string against the vocabulary at runtime. A second hand-written
 * array beside a union is two copies of one fact, and the copy is always the stale one.
 */
export const TIERS = ["fts", "or", "lev", "fuzzy", "stopword", "empty"] as const;

export type Tier = (typeof TIERS)[number];

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

export interface TitleRow {
  tconst: string;
  title: string;
  orig: string | null;
  year: number | null;
  kind: string;
  votes: number;
  rating: number;
  genres: string;
  runtime: number | null;
}

export interface Hit extends TitleRow {
  score: number;
  /** Fraction of query tokens found in the title. Drives the escalation gate. */
  coverage: number;
}

export interface Facets {
  genre: { value: string; count: number }[];
  decade: { value: number; count: number }[];
  year: { value: number; count: number }[];
  kind: { value: string; count: number }[];
}

export interface SearchResult {
  hits: Hit[];
  facets: Facets;
  tier: Tier;
  parsed: ParsedQuery;
  ms: number;
  /** Total candidates considered before the page was cut. */
  candidates: number;
}

export interface SearchOptions {
  limit?: number;
  genre?: string;
  decade?: number;
  year?: number;
  kind?: string;
  /** Skip facet computation when the caller only wants rows. */
  facets?: boolean;
}

/**
 * Stopwords are a LATENCY bug as much as a quality one: `"the"*` prefix-matches
 * nearly every title in the index. Leaving it in an OR clause cost 1138ms.
 *
 * The set itself lives in `search-stopwords.ts`, which also owns the answer for a query
 * made of nothing but stopwords -- the index builder needs the same vocabulary and must
 * not import `SearchEngine` to get it.
 */

/** Number of rows pulled from FTS before ranking. Facet counts are computed over this. */
const CANDIDATE_WINDOW = 400;

/**
 * The decade a year falls in -- 1994 is in the 1990s.
 *
 * One owner for the floor division. It was spelled out inline in four places before,
 * which is three chances for a browse query and the facet count beside it to disagree
 * about which decade a title belongs to.
 *
 * `web/src/lib/search-params.ts` keeps its own copy on purpose: importing this one
 * would pull a server module into the browser bundle, which is a build-config
 * decision rather than a de-duplication.
 */
export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * How many spellfix1 candidates to pull for the fuzzy tier.
 *
 * Matches the window the old in-memory trigram tier used, so the ranking layer below
 * sees the same amount of material to work with and scores are comparable across the
 * change.
 */
const FUZZY_WINDOW = 300;

export class SearchEngine {
  private db: Database;

  /** Whether the fuzzy tier is available: extension loaded AND vocabulary present. */
  private fuzzyReady = false;
  private vocabWords = 0;

  /**
   * Trigram sets for CANDIDATE titles, memoized across queries.
   *
   * Only rows that reach `rank()` land here -- a few hundred per query, not the corpus.
   * The bound is deliberately small: this is a micro-optimisation worth a few
   * microseconds per candidate, and it is not worth handing the garbage collector a
   * million more objects to trace. The in-RAM pool this class used to carry is the
   * cautionary tale -- 9M live objects cost 14.5% of a core in GC on an idle box.
   */
  private trigramCache = new Map<number, Set<string>[]>();

  /**
   * Whether this index carries the cast tables.
   *
   * **An index built before they existed is still perfectly valid**, and the server has to
   * keep serving it -- the cast stage is additive precisely so a running deployment
   * survives the upgrade and picks people up at its next nightly rebuild. Without this
   * check every person query would throw `no such table: person` against exactly the index
   * most likely to be live during a rollout.
   *
   * Assigned in the CONSTRUCTOR BODY, not as a field initializer. Initializers run before
   * the body, so `= this.tableExists(...)` here ran while `this.db` was still undefined
   * and took down every SearchEngine construction -- including the canary gate, which is
   * where it was caught. Declared here and set below.
   *
   * Answered once from `sqlite_master` rather than per request: the file is opened
   * read-only and its schema cannot change under us.
   */
  readonly hasPeople: boolean;

  /**
   * Whether this index carries the computed `rank` column.
   *
   * **The index a deploy meets is almost always the OLD one.** A redeploy keeps its data
   * directory, so `titles.db` is whatever the last refresh built and the rank column does
   * not appear until the next one -- which is up to a day later. Without this check the
   * front page's ranked shelf would throw `no such column: rank` on every `/api/discover`
   * for that whole window, on the one path every visitor hits.
   *
   * Exactly the shape `hasPeople` above was bought with, including the reason it is
   * answered ONCE from the schema rather than per request: the file is opened read-only and
   * cannot change under us. And, like that one, it is assigned in the CONSTRUCTOR BODY --
   * a field initializer runs before the body and would read `this.db` while it is still
   * undefined.
   */
  readonly hasRank: boolean;

  /**
   * Whether this index carries the bulk-loaded id crosswalk.
   *
   * The third of these guards, for the third additive stage, and the reason is the one
   * `hasPeople` states at length: the index a deploy meets is the one the LAST refresh
   * built, so `title_ids` is missing for up to a day after this ships. Without the check
   * every title page would throw `no such table: title_ids` in exactly that window.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasIds: boolean;

  /**
   * Whether `title_genre` carries its own copy of `votes`.
   *
   * The fourth guard, for the same reason as the three above: the index a deploy meets is
   * the one the LAST refresh built, and this column arrived on 2026-09-02. Without the
   * check every genre browse would throw `no such column: g.votes` for the up-to-a-day
   * window before the rebuild lands -- on the single most common list in the product.
   *
   * Unlike the others it degrades to something SLOW rather than to something absent: a
   * false here means a genre browse reads `title.votes` through the join and sorts, which
   * is precisely the 3.66s this column was added to remove. That is the correct trade for
   * one refresh cycle, and it is why `rank`'s recipe was bumped rather than left alone --
   * an index without this column is stale by the stamp, so boot ORDERS the rebuild instead
   * of waiting for a dump to drift.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasGenreVotes: boolean;

  /**
   * Every title kind this index actually holds, read once at construction.
   *
   * Read from the FILE rather than from `cfg.index.titleTypes`, which is what the next
   * build would produce: the index a running server holds is whatever the last build made,
   * so a config edit would otherwise have `rankedSeek` querying for a kind that is not in
   * there (harmless) or -- the one that matters -- skipping one that is, which silently
   * drops a quarter of every shelf. `select distinct kind from title` is a covering-index
   * scan of `ix_kind` and costs 0.03ms, measured.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  private readonly kinds: readonly string[];

  constructor(
    dbPath: string,
    private cfg: Config,
  ) {
    this.db = new Database(dbPath, { readonly: true });
    this.db.run("pragma temp_store = memory");
    this.db.run("pragma cache_size = -64000"); // 64 MB page cache
    this.hasPeople = this.tableExists("title_principal") && this.tableExists("person");
    this.hasRank = this.columnExists("title", "rank") && this.columnExists("title_genre", "rank");
    this.hasIds = this.tableExists("title_ids");
    this.hasGenreVotes = this.columnExists("title_genre", "votes");
    this.kinds = (this.db.query("select distinct kind from title").all() as { kind: string }[]).map(
      (r) => r.kind,
    );
  }

  /**
   * The external ids we already hold for a title, from the bulk crosswalk.
   *
   * `{}` for an index built before the crosswalk existed, and `{}` for a title the
   * crosswalk does not cover -- the caller cannot tell those apart and does not need to,
   * because the answer to both is the same: let the provider look it up as it always did.
   */
  idsFor(tconst: string): TitleIds {
    return this.hasIds ? titleIds(this.db, tconst) : {};
  }

  /**
   * Attach the fuzzy tier.
   *
   * This used to build a trigram index in RAM on every boot: 205k entries, ~9 million
   * live objects, 1,514 MB resident, 4-11 seconds of startup. It was the single most
   * expensive thing in the product, and the cost was not the memory -- it was that
   * JavaScriptCore must re-mark every one of those objects forever, which burned 14.5%
   * of a core on a container serving no traffic.
   *
   * Now the vocabulary is built once by the index builder and lives in the index file
   * (`vendor/sqlite-spellfix/README.md` has the measurements). All this does is load
   * the extension and confirm the table is there, so it costs a few milliseconds and
   * holds nothing.
   *
   * Degrades rather than throws: without the extension, search still serves the FTS
   * tiers and only loses typo tolerance.
   */
  prepareFuzzy(log: (m: string) => void = () => {}): void {
    const t0 = Bun.nanoseconds();
    if (!loadSpellfix(this.db, log).ok) {
      log("fuzzy: DISABLED -- spellfix1 did not load. Exact and prefix search still work.");
      return;
    }

    // An index built before the vocabulary existed is still perfectly serviceable; it
    // just has no fuzzy tier until the next rebuild. Say so rather than throwing.
    const present = this.db
      .query("select count(*) c from sqlite_master where type in ('table','view') and name = ?")
      .get(SPELLFIX_TABLE) as { c: number };
    if (present.c === 0) {
      log(`fuzzy: DISABLED -- no '${SPELLFIX_TABLE}' table in this index. Rebuild it to enable typo search.`);
      return;
    }

    this.vocabWords = (
      this.db.query(`select count(*) c from ${SPELLFIX_MAP_TABLE}`).get() as { c: number }
    ).c;
    this.fuzzyReady = true;

    // The vocabulary was built at whatever floor was configured AT BUILD TIME. If the
    // running config has moved since, fuzzy coverage is not what config says it is --
    // and the only symptom would be one obscure title becoming unfindable, which nobody
    // notices. Say it out loud instead.
    const builtFloor = this.db.query("select value from meta where key = 'vocab_min_votes'").get() as
      | { value: string }
      | undefined;
    if (builtFloor && Number(builtFloor.value) !== this.cfg.index.fuzzyMinVotes) {
      log(
        `fuzzy: WARNING -- vocabulary was built at votes >= ${builtFloor.value} but config says ` +
          `${this.cfg.index.fuzzyMinVotes}. Rebuild the index to apply the new floor.`,
      );
    }

    log(
      `fuzzy: spellfix1 ready, ${this.vocabWords.toLocaleString()} words ` +
        `in ${((Bun.nanoseconds() - t0) / 1e6).toFixed(0)}ms`,
    );
  }

  /** Trigram sets for a candidate's title variants, computed once and reused. */
  private variantTrigrams(rowid: number, variants: string[]): Set<string>[] {
    let cached = this.trigramCache.get(rowid);
    if (cached) return cached;
    cached = [];
    for (const v of variants) {
      cached.push(trigrams(v));
      cached.push(trigrams(v.replace(/ /g, "")));
    }
    // Bound the cache. 5,000 rowids is roughly 240k objects at the top end, which is a
    // rounding error next to a heap; the previous 50,000 was ten times that for a
    // saving measured in microseconds per candidate.
    if (this.trigramCache.size > 5_000) this.trigramCache.clear();
    this.trigramCache.set(rowid, cached);
    return cached;
  }

  close(): void {
    this.db.close();
  }

  get ready(): boolean {
    return this.fuzzyReady;
  }

  /**
   * What the fuzzy tier costs, as one short string for the resource log.
   *
   * Printed beside heap and GC on purpose. The previous implementation held 205k
   * entries and ~9M objects here, and seeing that count next to a GC percentage is
   * what makes the relationship legible without a profiler. It now reads `vocab N
   * words (disk)`, which is the whole point: the number is large and costs nothing.
   */
  poolStats(): string {
    if (!this.fuzzyReady) return "fuzzy off";
    return `vocab ${this.vocabWords.toLocaleString()} words (disk)`;
  }

  meta(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.query("select key, value from meta").all() as {
      key: string;
      value: string;
    }[]) {
      out[r.key] = r.value;
    }
    return out;
  }

  // -------------------------------------------------------------------------

  /**
   * Build an FTS5 MATCH expression.
   *
   * Two latency rules learned the hard way:
   *  - Stopwords are dropped whenever something else remains. `"the"*` prefix-matches
   *    nearly every title in the index; leaving it in cost 80-1138ms depending on tier.
   *    Dropping it is also harmless for recall, since the normalized columns already
   *    have leading articles stripped.
   *  - Tokens of <=2 chars get no `*`. `"io"*` alone cost 35ms.
   */
  private matchExpr(text: string, or: boolean): string | null {
    const all = normalize(text).split(" ").filter(Boolean);
    if (all.length === 0) return null;

    const meaningful = all.filter((t) => !STOPWORDS.has(t));
    /*
      A query that is NOTHING BUT stopwords gets no FTS expression at all, and this is the
      fix for the 1033ms `?q=the`. The branch that used to sit here put the stopwords back
      WITH their prefix star -- the one construction the comment above warns about -- on the
      only query shape that can never earn it back. `popularStopwordHits` answers instead;
      `search()` checks for that case before it ever asks for an expression, so returning
      null here is a second line of defence rather than the mechanism.
    */
    if (meaningful.length === 0) return null;

    let tokens = or ? meaningful.filter((t) => t.length > 2) : meaningful;
    // An OR pass whose meaningful tokens are ALL 1-2 chars still has to match something --
    // "io" is a real title. It falls back to the meaningful tokens, deliberately NOT to
    // every token: re-admitting the stopwords is what made this expensive.
    if (tokens.length === 0) tokens = meaningful;

    const parts = tokens.map((t) => (t.length <= 2 ? `"${t}"` : `"${t}"*`));
    return or ? parts.join(" OR ") : parts.join(" ");
  }

  /**
   * The most popular titles whose name STARTS with a stopword-only query.
   *
   * See `search-stopwords.ts` for why this exists, what it measured and why the floor and
   * the partial index are both required. Two properties matter at this call site:
   *
   *  - **The `like` pattern is built from a closed set.** `stopwordTokens` only returns
   *    tokens that are members of `STOPWORDS`, so no user text reaches the pattern and no
   *    `%` or `_` can be smuggled into it.
   *  - **The exact-title arm is a second `like`, NOT `=`, and that is not a style choice.**
   *    "It" and "Up" are real titles and `title like 'it %'` does not match a title that IS
   *    the word. But `title = 'it'` does not match it either: the token has been through
   *    `normalize` and is lower-case, while `title` holds "It" -- and SQLite's `=` is
   *    case-SENSITIVE where its `like` is not. Written as `=` first, and the test below
   *    caught it: the arm was dead code and `?q=it` answered "It Follows" while the actual
   *    film went unlisted.
   *
   * Rows come back in votes order and are NOT re-ranked. `rank()` scores text similarity,
   * which for a query carrying no information would reorder the list on noise; popularity
   * is the only honest signal here, so the SQL's order is the answer's order.
   */
  private popularStopwordHits(tokens: string[]): Hit[] {
    const phrase = tokens.join(" ");
    const rows = this.db
      .query(
        `select tconst, title, orig, year, kind, votes, rating, genres, runtime
         from title
         where votes >= ? and (title like ? or title like ?)
         order by votes desc
         limit ${CANDIDATE_WINDOW}`,
      )
      .all(STOPWORD_VOTE_FLOOR, `${phrase} %`, phrase) as TitleRow[];

    // `coverage: 1` because the query text genuinely IS present, at the front of the title.
    // The score keeps the same votes shaping the FTS ranker uses, so it stays monotonic with
    // the order the rows arrived in and a reader comparing tiers is not shown two scales.
    return rows.map((r) => ({ ...r, score: 1.6 * Math.log(r.votes + 10), coverage: 1 }));
  }

  private ftsCandidates(expr: string): (TitleRow & { rowid: number; ntitle: string; norig: string })[] {
    return this.db
      .query(
        `select t.rowid_ as rowid, t.tconst, t.title, t.orig, t.year, t.kind, t.votes, t.rating,
                t.genres, t.runtime, t.ntitle, t.norig, -bm25(tfts) as bm
         from tfts join title t on t.rowid_ = tfts.rowid
         where tfts match ?
         order by (-bm25(tfts)) + 1.6 * ln(t.votes + 10) desc
         limit ${CANDIDATE_WINDOW}`,
      )
      .all(expr) as (TitleRow & {
      rowid: number;
      bm: number;
      ntitle: string;
      norig: string;
    })[];
  }

  /**
   * The single scoring function. Every candidate goes through this regardless of
   * which tier produced it, so scores from FTS and from the fuzzy pool are directly
   * comparable and the tiers can be merged rather than chosen between.
   *
   * Text similarity is computed here (not taken from bm25) precisely so the scales
   * match; bm25 is used only to pick which 400 rows are worth scoring.
   */
  private rank(
    rows: (TitleRow & { rowid: number; ntitle?: string; norig?: string })[],
    p: ParsedQuery,
  ): Hit[] {
    const nq = normalizeStripped(p.text);
    const dq = despace(p.text);
    const gq = trigrams(nq);
    const gd = trigrams(dq);
    const qTokens = nq.split(" ").filter(Boolean);

    const seen = new Set<number>();
    const out: Hit[] = [];

    for (const r of rows) {
      if (seen.has(r.rowid)) continue;
      seen.add(r.rowid);

      const variants = [
        r.ntitle ?? normalizeStripped(r.title),
        r.norig ?? normalizeStripped(r.orig ?? ""),
      ].filter(Boolean);

      // How much of the query's text is actually present, 0..1.
      // Trigram sets are memoized -- recomputing them per candidate per query was
      // most of the cost of a fuzzy search.
      let textSim = 0;
      for (const set of this.variantTrigrams(r.rowid, variants)) {
        const s = Math.max(similarity(gq, set), similarity(gd, set));
        if (s > textSim) textSim = s;
      }

      // Token coverage: a separate signal from character similarity. "Budapest Hostel"
      // covers 1 of 2 tokens against "Hostel" -- that is what the escalation gate reads.
      let cov = 0;
      for (const v of variants) {
        let n = 0;
        for (const t of qTokens) if (v.includes(t)) n++;
        cov = Math.max(cov, qTokens.length ? n / qTokens.length : 0);
      }

      const ys = yearScore(r.year, p.year, p.decade);

      // Exact / prefix / coverage all measure THE SAME THING. Stacking them
      // (12 + 4 + 7 = 23) let a 439-vote "Interstelar" beat the 2.6M-vote
      // "Interstellar". Take the strongest single signal, never the sum.
      //
      // The year gate: an explicit year must be able to beat an exact title match,
      // or "The Matrix 2021" returns The Matrix (1999).
      let match: number;
      if (variants.includes(nq)) {
        // An exact match on an obscure title is SUSPICIOUS -- far more often a typo of
        // something famous than a deliberate search for a 439-vote film. Scale the
        // bonus by how plausible it is that anyone meant this title.
        match = p.year && ys < 0 ? 0 : 14 * Math.min(1, Math.log(r.votes + 10) / Math.log(50_000));
      } else if (variants.some((v) => v.startsWith(nq))) {
        match = 9;
      } else if (cov >= 0.999) {
        // Matching EVERY query word is qualitatively different from matching half of
        // them, and deserves more than a linear share. This is what lets "Nile City"
        // find NileCity 105.6 over the far more popular Sin City.
        match = 12;
      } else {
        match = 10 * cov;
      }

      const score =
        22 * textSim +
        match +
        // Popularity, saturating. The difference between 300k and 2.6M votes is not
        // informative -- both are famous -- but 439 vs 300k is decisive. Without the
        // cap, blockbusters bulldoze every correct-but-smaller match.
        2.4 * Math.log(Math.min(r.votes, 300_000) + 10) +
        ys +
        kindScore(r.kind, p.kind) +
        recencyScore(r.year);

      out.push({ ...r, score, coverage: cov } as Hit);
    }

    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Typo-tolerant candidates, straight out of the index.
   *
   * Replaces two in-memory tiers -- a Levenshtein scan over all 205k pool entries and a
   * trigram posting-list walk -- with one indexed query. spellfix1 does both jobs: its
   * edit-distance core handles the short queries trigrams are blind to ("sielo" vs
   * "silo"), and its phonetic bucketing handles the long ones.
   *
   * Candidates only. Everything about ORDER is still `rank()`'s job, exactly as before,
   * so scores stay comparable with the FTS tiers and the tuning above is untouched.
   *
   * Both title forms are in the vocabulary, so a query matching a Swedish original
   * resolves through the same path as an English one -- `vocab_map` collapses both back
   * to one title rowid, and the de-duplication happens in `rank()`.
   */
  private fuzzyCandidates(p: ParsedQuery, limit: number): number[] {
    if (!this.fuzzyReady) return [];
    const nq = normalizeStripped(p.text);
    if (nq.length === 0) return [];

    const rows = this.db
      .query(
        `select m.rowid_ as rowid from ${SPELLFIX_TABLE} v
         join ${SPELLFIX_MAP_TABLE} m on m.id = v.rowid
         where v.word match ? and v.top = ?`,
      )
      .all(nq, limit) as { rowid: number }[];

    // One title can appear twice (primary and original form); keep first occurrence,
    // which is the closer match since spellfix1 returns in distance order.
    const seen = new Set<number>();
    const out: number[] = [];
    for (const r of rows) {
      if (seen.has(r.rowid)) continue;
      seen.add(r.rowid);
      out.push(r.rowid);
    }
    return out;
  }

  /** Load full rows for a set of rowids, preserving nothing about order. */
  private hydrate(rowids: number[]): (TitleRow & { rowid: number; ntitle: string; norig: string })[] {
    if (rowids.length === 0) return [];
    const out: (TitleRow & { rowid: number; ntitle: string; norig: string })[] = [];
    // Chunk to stay under SQLite's variable limit on large candidate sets.
    for (let i = 0; i < rowids.length; i += 500) {
      const chunk = rowids.slice(i, i + 500);
      out.push(
        ...(this.db
          .query(
            `select rowid_ as rowid, tconst, title, orig, year, kind, votes, rating, genres, runtime, ntitle, norig
             from title where rowid_ in (${chunk.map(() => "?").join(",")})`,
          )
          .all(...chunk) as (TitleRow & {
          rowid: number;
          ntitle: string;
          norig: string;
        })[]),
      );
    }
    return out;
  }

  // -------------------------------------------------------------------------

  search(raw: string, opts: SearchOptions = {}): SearchResult {
    const t0 = Bun.nanoseconds();
    const limit = opts.limit ?? 25;
    const parsed = parseQuery(raw);
    const empty: Facets = { genre: [], decade: [], year: [], kind: [] };

    if (parsed.text.length === 0) {
      return {
        hits: [],
        facets: empty,
        tier: "empty",
        parsed,
        ms: 0,
        candidates: 0,
      };
    }

    // Candidates accumulate across tiers; rank() scores them all on one scale and the
    // best answer wins regardless of which tier found it. Choosing a tier and
    // discarding the others is how a 439-vote exact match beats a 2.6M-vote near match.
    const candidates = new Map<number, TitleRow & { rowid: number; ntitle: string; norig: string }>();
    const add = (rows: (TitleRow & { rowid: number; ntitle: string; norig: string })[]) => {
      for (const r of rows) if (!candidates.has(r.rowid)) candidates.set(r.rowid, r);
    };

    let tier: Tier = "fts";
    let ranked: Hit[];

    /**
     * Escalate when the top hit is weak, ambiguous, barely covers the query, OR is
     * obscure. The obscurity check is the one that catches "interstelar": an exact
     * title match on a 439-vote film looks confident but almost certainly means the
     * user typo'd something famous.
     */
    const weak = (hits: Hit[]): boolean =>
      hits.length === 0 ||
      hits[0].score < 20 ||
      hits[0].coverage < 0.6 ||
      hits[0].votes < 5000 ||
      (hits[1] !== undefined && hits[0].score - hits[1].score < 1.0 && hits[0].score < 26);

    /*
      A stopword-only query takes its own path and DOES NOT ESCALATE, which is the point.

      Every tier below exists to find a better match for text the reader meant. There is no
      better match for "the": the escalations would each run their own scan of a quarter of
      the index looking for meaning that is not in the query, which is how one keystroke
      came to cost the whole event loop for a second. `weak()` would be true here on every
      single call -- coverage is 1 but the top score is pure votes shaping -- so leaving
      this to fall through would guarantee the expensive path rather than risk it.
    */
    const stopwords = stopwordTokens(normalize(parsed.text));
    if (stopwords) {
      tier = "stopword";
      ranked = this.popularStopwordHits(stopwords);
    } else {
      const andExpr = this.matchExpr(parsed.text, false);
      if (andExpr) add(this.ftsCandidates(andExpr));

      ranked = this.rank([...candidates.values()], parsed);

      if (weak(ranked)) {
        const orExpr = this.matchExpr(parsed.text, true);
        if (orExpr && orExpr !== andExpr) {
          const before = candidates.size;
          add(this.ftsCandidates(orExpr));
          if (candidates.size > before) {
            ranked = this.rank([...candidates.values()], parsed);
            tier = "or";
          }
        }
      }

      // One fuzzy tier, not two. The old `lev` and `fuzzy` tiers existed because an
      // in-memory trigram index is blind under about six characters and needed a separate
      // Levenshtein scan beside it. spellfix1 covers both cases in a single query, so the
      // split has no meaning any more -- and a second escalation that could only ever add
      // what the first already found is pure latency.
      if (weak(ranked) && this.fuzzyReady) {
        const before = candidates.size;
        add(this.hydrate(this.fuzzyCandidates(parsed, FUZZY_WINDOW)));
        if (candidates.size > before) {
          ranked = this.rank([...candidates.values()], parsed);
          tier = "fuzzy";
        }
      }
    }

    const candidateCount = candidates.size;

    // Facet filters from the UI narrow the ranked set.
    let filtered = ranked;
    if (opts.genre) filtered = filtered.filter((h) => h.genres.split(",").includes(opts.genre as string));
    if (opts.decade !== undefined)
      filtered = filtered.filter((h) => h.year !== null && decadeOf(h.year) === opts.decade);
    if (opts.year !== undefined) filtered = filtered.filter((h) => h.year === opts.year);
    if (opts.kind) filtered = filtered.filter((h) => h.kind === opts.kind);

    const facets = opts.facets === false ? empty : computeFacets(ranked);

    return {
      hits: filtered.slice(0, limit),
      facets,
      tier: ranked.length === 0 ? "empty" : tier,
      parsed,
      ms: (Bun.nanoseconds() - t0) / 1e6,
      candidates: candidateCount || ranked.length,
    };
  }

  byTconst(tconst: string): TitleRow | null {
    return (
      (this.db
        .query(
          "select tconst, title, orig, year, kind, votes, rating, genres, runtime from title where tconst = ?",
        )
        .get(tconst) as TitleRow | undefined) ?? null
    );
  }

  /**
   * The top rows by the precomputed `rank`, ONE KIND AT A TIME, merged.
   *
   * > [!IMPORTANT] Pinning `kind` is the whole optimisation, and it is not optional
   * > `ix_rank` is `(kind, rank desc)` and `ix_tg_rank` is `(genre, kind, rank desc)`, so
   * > rank can only be READ IN ORDER once every column before it is fixed. A query that
   * > leaves `kind` free still uses the index to FIND its rows and then sorts them in a
   * > temp b-tree -- which is the 933ms "Best in Drama" this replaced. Seeking each of the
   * > four kinds separately and merging in JS is `4 x 0.2ms` plus a sort of a few hundred
   * > rows, measured 2026-09-01 against the real 1.27M-row index.
   *
   * **There is deliberately no `votes >= x and rating >= y` floor here**, and that is the
   * one behavioural difference from the queries this replaced. Those floors were a hand-cut
   * approximation of "rated well by enough people to mean something", which is exactly and
   * only what the Bayesian `rank` computes -- keeping both would be two owners of one rule.
   * They are also what made the seek slow again: a kind with too few titles clearing the
   * floor never fills its `limit`, so SQLite walks that kind's ENTIRE ranked list looking
   * for rows that are not there (67-143ms, measured). The floors survive on the `!hasRank`
   * fallback paths below, because there is nothing else to order those by.
   */
  private rankedSeek(opts: {
    genre?: string;
    kind?: string;
    minYear?: number;
    /** Rows to take PER KIND before merging. */
    perKind: number;
  }): TitleRow[] {
    const cols = "t.tconst, t.title, t.orig, t.year, t.kind, t.votes, t.rating, t.genres, t.runtime";
    // The genre form ranks off `title_genre`'s own denormalised copy, which is what lets the
    // seek happen without touching `title` until the rows are already chosen.
    const sql = opts.genre
      ? `select ${cols}, g.rank rank_ from title_genre g join title t on t.rowid_ = g.title_rowid
         where g.genre = ? and g.kind = ? and g.rank is not null
         order by g.rank desc limit ?`
      : `select ${cols}, t.rank rank_ from title t
         where t.kind = ? and t.rank is not null ${opts.minYear === undefined ? "" : "and t.year >= ?"}
         order by t.rank desc limit ?`;

    const merged: (TitleRow & { rank_: number })[] = [];
    for (const kind of opts.kind ? [opts.kind] : this.kinds) {
      const args = opts.genre
        ? [opts.genre, kind, opts.perKind]
        : opts.minYear === undefined
          ? [kind, opts.perKind]
          : [kind, opts.minYear, opts.perKind];
      merged.push(...(this.db.query(sql).all(...(args as never[])) as (TitleRow & { rank_: number })[]));
    }
    // One sort over a few hundred rows, not over the corpus. `rank_` is stripped rather than
    // returned: `TitleRow` is what reaches the browser and an internal sort key is not a fact
    // about the title.
    merged.sort((a, b) => b.rank_ - a.rank_);
    return merged.map(({ rank_: _rank, ...row }) => row);
  }

  /**
   * Discovery rows that cost ZERO API calls -- pure queries over data we already hold.
   * Seerr cannot do this at all.
   */
  topRated(
    opts: { minVotes?: number; kind?: string; limit?: number; excludeTconsts?: Set<string> } = {},
  ): TitleRow[] {
    const limit = opts.limit ?? 40;
    const rows = this.hasRank
      ? this.rankedSeek({ kind: opts.kind, perKind: limit * 3 })
      : (this.db
          .query(
            `select tconst, title, orig, year, kind, votes, rating, genres, runtime
         from title
         where votes >= ? and rating >= 7.5 ${opts.kind ? "and kind = ?" : ""}
         order by rating * ln(votes) desc
         limit ?`,
          )
          .all(
            ...([opts.minVotes ?? 50_000, ...(opts.kind ? [opts.kind] : []), limit * 3] as never[]),
          ) as TitleRow[]);
    const out = opts.excludeTconsts ? rows.filter((r) => !opts.excludeTconsts?.has(r.tconst)) : rows;
    return out.slice(0, limit);
  }

  /*
    THERE IS NO `anticipated()` HERE ANY MORE, AND THERE CANNOT HONESTLY BE ONE.

    It was `where year >= thisYear order by year asc, votes desc`, and on 2026-08-31 every
    one of the five titles it put at the top of "Coming soon" had been in cinemas for
    months -- Project Hail Mary (released 2026-03-15), The Odyssey (2026-07-15),
    Spider-Man: Brand New Day (2026-07-29), Backrooms (2026-05-27), Michael (2026-04-22).

    Not a tuning problem, a structural one, and both halves are worth knowing before
    anybody writes this query again:

      1. `title.basics` carries `startYear` and nothing finer, so "this year" cannot
         distinguish January from December. There is no date column to add.
      2. `votes desc` ranks the most-released titles first BY CONSTRUCTION -- a vote count
         measures how long a title has been out. And past the current year the signal is
         gone entirely: every indexed title dated 2027 or later carries exactly zero votes,
         so the ordering is arbitrary for precisely the titles the shelf is about.

    Upcoming is served from the `upcoming` mirror instead, filled from the arr calendars
    and TMDB by `src/lib/upcoming.ts`. See `discoveryShelves` for the four rows.
  */

  /**
   * Hidden gems: rated highly by the people who found them, but few people found them.
   *
   * This is the row Seerr structurally cannot produce -- it has no local corpus to
   * ask, so it can only show you what is already popular. The vote window is the whole
   * trick: a floor high enough that the rating means something, a ceiling low enough
   * that the title is genuinely obscure. Ordered by rating, NOT by rating x votes,
   * because weighting by votes would just re-rank the ceiling back toward the famous.
   */
  hiddenGems(opts: { minVotes?: number; maxVotes?: number; kind?: string; limit?: number } = {}): TitleRow[] {
    return this.db
      .query(
        `select tconst, title, orig, year, kind, votes, rating, genres, runtime
         from title
         where votes >= ? and votes <= ? and rating >= 7.6 ${opts.kind ? "and kind = ?" : ""}
         order by rating desc, votes desc
         limit ?`,
      )
      .all(
        ...([
          opts.minVotes ?? 2_000,
          opts.maxVotes ?? 30_000,
          ...(opts.kind ? [opts.kind] : []),
          opts.limit ?? 40,
        ] as never[]),
      ) as TitleRow[];
  }

  /**
   * Highly rated within one genre, excluding what is owned.
   *
   * Separate from `browse` because browse orders by votes -- fine for "show me
   * everything", wrong for a shelf, where the point is quality not familiarity.
   */
  topRatedInGenre(
    genre: string,
    opts: { minVotes?: number; limit?: number; excludeTconsts?: Set<string> } = {},
  ): TitleRow[] {
    const limit = opts.limit ?? 30;
    const rows = this.hasRank
      ? this.rankedSeek({ genre, perKind: limit * 3 })
      : (this.db
          .query(
            `select t.tconst, t.title, t.orig, t.year, t.kind, t.votes, t.rating, t.genres, t.runtime
         from title t join title_genre g on g.title_rowid = t.rowid_
         where g.genre = ? and t.votes >= ? and t.rating >= 7.0
         order by t.rating * ln(t.votes) desc
         limit ?`,
          )
          .all(...([genre, opts.minVotes ?? 20_000, limit * 3] as never[])) as TitleRow[]);
    const out = opts.excludeTconsts ? rows.filter((r) => !opts.excludeTconsts?.has(r.tconst)) : rows;
    return out.slice(0, limit);
  }

  /** Everything from the current decade, best first. */
  newThisDecade(opts: { limit?: number; excludeTconsts?: Set<string> } = {}): TitleRow[] {
    const decade = decadeOf(new Date().getFullYear());
    const limit = opts.limit ?? 30;
    const rows = this.hasRank
      ? this.rankedSeek({ minYear: decade, perKind: limit * 3 })
      : (this.db
          .query(
            `select tconst, title, orig, year, kind, votes, rating, genres, runtime
         from title
         where year >= ? and votes >= 5000 and rating >= 7.0
         order by rating * ln(votes) desc
         limit ?`,
          )
          .all(decade, limit * 3) as TitleRow[]);
    const out = opts.excludeTconsts ? rows.filter((r) => !opts.excludeTconsts?.has(r.tconst)) : rows;
    return out.slice(0, limit);
  }

  /** Which genres actually have enough good titles to be worth a shelf. */
  topGenres(limit = 6): string[] {
    return (
      this.db
        .query(
          `select g.genre, count(*) c
           from title_genre g join title t on t.rowid_ = g.title_rowid
           where t.votes >= 20000 and t.rating >= 7.0
           group by g.genre order by c desc limit ?`,
        )
        .all(limit) as { genre: string }[]
    ).map((r) => r.genre);
  }

  /**
   * Browse, DOWNGRADING a ranked sort on an index that cannot serve one.
   *
   * The downgrade lives here rather than in `browseIndex` because that function is pure
   * policy over a database somebody hands it, and "what can this particular file do" is a
   * property of the open index. A caller that must not show a votes-ordered list under a
   * ranked list's NAME asks `hasRank` first -- `discoveryShelves` does exactly that, since
   * "finderr Top 250" ordered by popularity is a wrong answer wearing a right one's label.
   * A generic `/browse` grid is happy with the fallback; a named list is not.
   */
  browse(opts: BrowseOptions): BrowseResult {
    const safe = opts.sort === "rank" && !this.hasRank ? { ...opts, sort: "votes" as const } : opts;
    // `genreVotes` is a CAPABILITY, so it comes from the open file and is never something a
    // caller passes in -- same split as the downgrade above: policy in `browseIndex`, "what
    // can this particular file do" here.
    return browseIndex(this.db, { ...safe, genreVotes: this.hasGenreVotes });
  }

  private tableExists(name: string): boolean {
    return this.db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== null;
  }

  /** Does `table` have `column`? Answers false for a table that does not exist at all. */
  private columnExists(table: string, column: string): boolean {
    if (!this.tableExists(table)) return false;
    return (this.db.query(`pragma table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );
  }

  /** A person and their filmography. `null` for an unknown id, or an index without people. */
  personPage(nconst: string, opts: PersonCreditsOptions = {}): PersonPage | null {
    return this.hasPeople ? personPage(this.db, nconst, opts) : null;
  }

  /** Who this person keeps working with. Empty for an index built before the cast tables. */
  frequentCollaborators(nconst: string, opts: CollaboratorOptions = {}): Collaborator[] {
    return this.hasPeople ? frequentCollaborators(this.db, nconst, opts) : [];
  }

  /** Our own ids for the names credited on a title, so a cast list can become links. */
  nconstsByNameForTitle(tconst: string): Map<string, string> {
    return this.hasPeople ? nconstsByNameForTitle(this.db, tconst) : new Map();
  }
}

/** What a browse query filters on. `minVotes` and paging are deliberately not in here. */
export interface BrowseFilters {
  genre?: string;
  decade?: number;
  year?: number;
  kind?: string;
}

/**
 * What a browse is ordered by.
 *
 * `votes` is the grid: most-familiar first, which is what "show me everything with this
 * filter" wants. `rank` is the LIST: the weighted rank the index build computed, which is
 * what "finderr Top 250" and every per-genre and per-decade list are made of. Both are
 * ordered columns with an index behind them, so neither is a sort.
 *
 * A closed union rather than a free string, because it reaches SQL as an ORDER BY.
 */
export type BrowseSort = "votes" | "rank";

export function isBrowseSort(v: unknown): v is BrowseSort {
  return v === "votes" || v === "rank";
}

export interface BrowseOptions extends BrowseFilters {
  /** Overrides the floor `browseVoteFloor` would pick. 0 means "show everything". */
  minVotes?: number;
  /** Defaults to `votes`. */
  sort?: BrowseSort;
  limit?: number;
  offset?: number;
  /**
   * Whether `title_genre` carries its own `votes` copy -- `SearchEngine.hasGenreVotes`.
   *
   * Defaults to FALSE, which is the slow-but-correct reading of `title.votes` through the
   * join. A capability defaulting to "present" would mean a caller that forgot to ask the
   * file gets `no such column` on a real index rather than a slower answer, and this
   * function is deliberately callable against any database somebody hands it.
   */
  genreVotes?: boolean;
}

/**
 * How many titles the vote floor removed, and how high that floor was.
 *
 * Without it the UI cannot tell "there are no 1901 films" apart from "there are eight
 * and a threshold nobody mentioned is hiding them", so it has to render the same dead
 * end for both. The floor carries its own value here so the copy that offers to lift
 * it never spells a second threshold that could drift from the one applied.
 */
export interface HiddenByFloor {
  titles: number;
  minVotes: number;
}

export interface BrowseResult {
  rows: TitleRow[];
  total: number;
  /** Present ONLY when the vote floor is the reason this query came back empty. */
  hiddenByFloor?: HiddenByFloor;
}

/**
 * The default vote floor for an unfiltered grid: below this, "all movies by votes"
 * opens on titles nobody has heard of.
 */
const BROWSE_VOTE_FLOOR = 1000;

/**
 * The vote floor a browse query gets when the caller does not name one.
 *
 * The floor is CURATION for a broad grid, and it stops being that the moment the
 * query pins a year or a decade: 94% of the index sits below 1000 votes, so
 * `?year=1901` returned nothing at all while eight 1901 shorts sat in the index, and
 * the user was given no way to learn they existed. A single year or decade cannot
 * flood anything -- the rows are ordered by votes and paged either way, so dropping
 * the floor changes the first page not at all and the last page completely.
 *
 * Genre and kind do NOT drop it: `?kind=movie` IS the broad grid.
 *
 * **A RANK-SORTED BROWSE TAKES NO FLOOR AT ALL, AND THAT IS NOT AN OVERSIGHT.** The
 * weighted rank is Bayesian, so the prior already does exactly the job a floor does, and
 * does it continuously instead of at a cliff: measured against the real index, a title
 * needs roughly 19,000 votes at a 9.5 rating before it can even reach a rank of 8.0, and
 * an unfloored top-250 sci-fi list comes back Inception, Interstellar, The Matrix,
 * Empire Strikes Back. A second threshold here would be a second owner of one rule -- the
 * thing this function exists to be the only one of -- and it would buy nothing, because
 * everything it would remove is already at the bottom of the list.
 *
 * The floor stays a decision of THIS function either way, so there is still exactly one
 * place that answers "what is hidden from a browse and why".
 */
export function browseVoteFloor(f: BrowseFilters, sort: BrowseSort = "votes"): number {
  if (sort === "rank") return 0;
  return f.year !== undefined || f.decade !== undefined ? 0 : BROWSE_VOTE_FLOOR;
}

/**
 * SQL shared by the row query and the count queries of one browse.
 *
 * `countFrom` is a SECOND from-clause and not a stylistic variant of the first. The rows
 * genuinely need `title` -- that is where the title, the year and the poster live. A COUNT
 * needs no column at all, so when every predicate is answerable from `title_genre` the
 * count can read that table alone and never touch `title`: **182ms to 2.5ms on the live
 * NAS index, same answer** (21,936), because SQLite goes from a primary-key lookup per
 * matching row to a covering scan of ix_tg_votes.
 *
 * The join it drops is safe to drop by CONSTRUCTION rather than by hope: every
 * `title_genre` row is written by `EXPLODE_GENRES` from an existing `title` row, keyed on
 * an INTEGER PRIMARY KEY, so the join can neither add a row nor remove one. SQLite cannot
 * work that out for itself -- there is no foreign key to tell it -- which is why this is
 * stated here rather than left to the planner.
 */
function browseSql(
  f: BrowseFilters,
  minVotes: number,
  sort: BrowseSort = "votes",
  genreVotes = false,
): { join: string; countFrom: string; where: string; order: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  // Set by any clause that names a column only `title` has. It is what decides whether the
  // count may drop the join, and it is a flag rather than a grep over the built SQL: a
  // predicate that quietly starts reading `t.` while a string test still passes is exactly
  // the bug that would make a count wrong instead of slow.
  let touchesTitle = false;
  let join = "";
  if (f.genre) {
    join = "join title_genre g on g.title_rowid = t.rowid_";
    where.push("g.genre = ?");
    args.push(f.genre);
  }
  /*
    WHICH TABLE'S COPY OF `votes` -- exactly the question `ranked` answers below for `rank`,
    and it decides the whole cost of a genre browse.

    `title_genre` carries `votes` denormalised from `title`, and `ix_tg_votes(genre, votes
    desc, kind)` covers the seek, the order and the kind filter together. Naming `t.votes`
    instead is the same numbers in the same sequence and a primary-key lookup into `title`
    per matching row to get there, then a temp b-tree -- 3.66s against a seek, measured on
    the live NAS index. So the join decides which column is named, not taste.

    `genreVotes` false is an index built before that column existed: it still answers every
    query correctly, on the old slow path, until the rebuild the stage stamp has ordered.
  */
  const voted = join && genreVotes ? "g.votes" : "t.votes";
  // `votes >= 0` is true for every row -- the column is `not null default 0` -- so
  // spelling it out only stops SQLite covering the count from an index. Omitting it is
  // what makes an unfloored per-genre list a pure seek.
  if (minVotes > 0) {
    where.push(`${voted} >= ?`);
    args.push(minVotes);
    if (voted.startsWith("t.")) touchesTitle = true;
  }
  // `year` is NOT denormalised onto title_genre, so a decade or year slice is the one
  // genre browse whose count still needs the join. Both take floor 0 and pin a narrow
  // range, so the row set is small and the lookup is cheap -- which is why the column was
  // not copied.
  if (f.decade !== undefined) {
    where.push("t.year >= ? and t.year <= ?");
    args.push(f.decade, f.decade + 9);
    touchesTitle = true;
  }
  if (f.year !== undefined) {
    where.push("t.year = ?");
    args.push(f.year);
    touchesTitle = true;
  }
  if (f.kind) {
    // `g.kind` on a join for the same reason as `voted` above: it is the trailing column of
    // ix_tg_votes, so the filter is answered from the index the seek is already in rather
    // than by reaching into `title` for every candidate row. ix_tg_rank carries it too, so
    // a ranked genre browse gains the same thing.
    where.push(join ? "g.kind = ?" : "t.kind = ?");
    args.push(f.kind);
    if (!join) touchesTitle = true;
  }

  /*
    The ORDER, and which table's copy of `rank` it reads.

    A genre browse joins `title_genre`, which carries its own `kind` and `rank` copied
    from `title` at build time, and `ix_tg_rank(genre, kind, rank desc)` covers all three.
    Ordering by `t.rank` instead would be the same numbers in the same sequence and a full
    sort to get there, which is the whole cost this layer was built to remove -- so the
    join decides which column is named, not taste.

    `rank is not null` is a MEMBERSHIP rule, not a filter: an unrated title has no rank, so
    it is not in the list. Without it `total` would count 1.2M unrated rows as members of
    "the top comedies" and paging far enough would eventually reach them.
  */
  const ranked = join ? "g.rank" : "t.rank";
  let order = `${voted} desc`;
  if (sort === "rank") {
    where.push(`${ranked} is not null`);
    order = `${ranked} desc`;
    if (!join) touchesTitle = true;
  }
  return {
    join,
    countFrom: join && !touchesTitle ? "title_genre g" : `title t ${join}`,
    // A browse with no filters at all and no floor has nothing to put in a WHERE.
    where: where.length > 0 ? where.join(" and ") : "1",
    order,
    args,
  };
}

function browseTotal(db: Database, sql: ReturnType<typeof browseSql>): number {
  return (
    db.query(`select count(*) c from ${sql.countFrom} where ${sql.where}`).get(...(sql.args as never[])) as {
      c: number;
    }
  ).c;
}

/**
 * Paginated browse over the index, ordered by votes or by the computed rank.
 *
 * Takes the database rather than reaching for one, so the floor policy and the
 * dead-end report can be exercised against a handful of rows in a temp file instead
 * of against the 1.27M-row production index.
 *
 * **Every computed top list in the product is this function with `sort: "rank"`**, which
 * is why the card that asked for those lists shipped no new query surface: "finderr Top
 * 250", "Top 250 sci-fi" and "best comedies of the 2020s" are three sets of filters, not
 * three endpoints.
 */
export function browseIndex(db: Database, opts: BrowseOptions): BrowseResult {
  const sort = opts.sort ?? "votes";
  const minVotes = opts.minVotes ?? browseVoteFloor(opts, sort);
  const sql = browseSql(opts, minVotes, sort, opts.genreVotes);
  const total = browseTotal(db, sql);
  const rows = db
    .query(
      `select t.tconst, t.title, t.orig, t.year, t.kind, t.votes, t.rating, t.genres, t.runtime
       from title t ${sql.join} where ${sql.where}
       order by ${sql.order} limit ? offset ?`,
    )
    .all(...([...sql.args, opts.limit ?? 60, opts.offset ?? 0] as never[])) as TitleRow[];

  // The second count only runs when the floor could be what emptied the page, so the
  // overwhelmingly common case -- a query that found rows -- pays for one count, not two.
  // A rank browse takes no floor, so it never reaches here and never offers a hatch it
  // has nothing behind: an empty ranked list is empty because nothing is ranked.
  if (total > 0 || minVotes === 0) return { rows, total };
  const unfloored = browseTotal(db, browseSql(opts, 0, sort, opts.genreVotes));
  return unfloored > 0 ? { rows, total, hiddenByFloor: { titles: unfloored, minVotes } } : { rows, total };
}

/**
 * Facet counts over the ranked candidate set.
 *
 * Done in JS rather than SQL because the candidate set is already in memory and
 * capped at CANDIDATE_WINDOW -- a second SQL pass would re-run the whole match.
 */
export function computeFacets(hits: Hit[]): Facets {
  const genre = new Map<string, number>();
  const decade = new Map<number, number>();
  const year = new Map<number, number>();
  const kind = new Map<string, number>();

  for (const h of hits) {
    for (const g of h.genres.split(",")) if (g) genre.set(g, (genre.get(g) ?? 0) + 1);
    if (h.year !== null) {
      const d = decadeOf(h.year);
      decade.set(d, (decade.get(d) ?? 0) + 1);
      year.set(h.year, (year.get(h.year) ?? 0) + 1);
    }
    kind.set(h.kind, (kind.get(h.kind) ?? 0) + 1);
  }

  const top = <T>(m: Map<T, number>, n: number, sort: "count" | "key" = "count") =>
    [...m.entries()]
      .sort((a, b) =>
        sort === "count" ? b[1] - a[1] || Number(b[0]) - Number(a[0]) : Number(b[0]) - Number(a[0]),
      )
      .slice(0, n)
      .map(([value, count]) => ({ value, count }));

  return {
    genre: top(genre, 10) as { value: string; count: number }[],
    decade: top(decade, 10, "key") as { value: number; count: number }[],
    year: top(year, 10) as { value: number; count: number }[],
    kind: top(kind, 5) as { value: string; count: number }[],
  };
}
