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
import { statSync } from "node:fs";
import { BREAKOUT_META, BREAKOUT_SHELF } from "./breakout";
import type { Config } from "./config";
import { ENGLISH_LANG, type TitleIds, titleIds, UNKNOWN_LANG } from "./crosswalk";
import type { PersonCredit } from "./facets";
// The builder is already in the server's module graph (`src/server/index.ts` imports
// `rollback`), so sharing the shelf-genre owner costs no new dependency -- and sharing it is
// the point: the live fallback and the build must compute the same answer or the precompute
// silently changes what the front page draws.
import { BROWSE_VOTE_FLOOR, computeShelfGenres, SHELF_GENRES_META_KEY } from "./index-builder";
// Every `has*` field below is one of these. The probes live there rather than here because
// the PROMOTE GATE has to ask the same questions of a file it is about to replace, and two
// copies of "does this index carry people search" would drift the day a stage moved -- see
// the module docstring on `./index-capabilities.ts` for the build that lost its vocabulary.
import { capabilitiesOf, type IndexCapability } from "./index-capabilities";
import { detectMemoryBudget, resolveTuning, type StorageTuning } from "./memory-budget";
import { despace, normalize, normalizeStripped, similarity, trigrams } from "./normalize";
import {
  type Collaborator,
  type CollaboratorOptions,
  type CreditTally,
  creditTally,
  frequentCollaborators,
  nconstsByNameForTitle,
  nconstsForCredits,
  type PersonCreditsOptions,
  type PersonHit,
  type PersonLinks,
  type PersonPage,
  type PersonSearchOptions,
  personPage,
  searchPeople,
} from "./people";
import {
  anticipationWeight,
  kindScore,
  type ParsedQuery,
  parseQuery,
  recencyScore,
  yearScore,
} from "./query-parser";
import { STOPWORD_VOTE_FLOOR, STOPWORDS, stopwordTokens } from "./search-stopwords";
import { loadSpellfix, SPELLFIX_MAP_TABLE, SPELLFIX_MISSING, SPELLFIX_TABLE } from "./spellfix";
import { type TitleRow, titleCols } from "./title-cols";
import {
  rarestTrigrams,
  TRIGRAM_DF_TABLE,
  TRIGRAM_TABLE,
  trigramMatchExpr,
  trigramShortlistSql,
  trigramsOf,
} from "./vocab-trigrams";

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

/**
 * `TitleRow` and `titleCols` live in `./title-cols`, and are re-exported here.
 *
 * The move was mechanical rather than editorial: this module imports `personPage` from
 * `./people` as a value, so `people.ts` importing the column list back would close a
 * runtime cycle. The re-export keeps every `import type { TitleRow } from "./search"` in
 * the tree correct. That file's docstring owns why the two belong together.
 */
export type { TitleRow } from "./title-cols";

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

/**
 * How far from the query a spellfix1 candidate may be and still be RANKED.
 *
 * > [!CAUTION] Without this, a query matching nothing returned the most famous films in the corpus
 * > spellfix1 always hands back its `top` N, however bad they are, and `rank()` scores a
 * > candidate that shares no query token on `22 * textSim + popularity(votes)` -- where a
 * > phonetic-bucket stranger has `textSim` of 0 and a blockbuster has 30 points of votes. So
 * > the tier had no way to say "nothing here". Measured on the real index, 2026-09-06:
 * > `"xyzzyplughfoo"` returned **Casablanca**, `"qwertzuiopasdf"` returned **Spirited Away**,
 * > and `"andrenochrome"` returned Ender's Game, Andrei Rublev and Antichrist.
 *
 * > [!IMPORTANT] 300 is the MIDDLE OF AN EMPTY BAND, not a tuning knob
 * > Measured across every typo case in the canary plus the reported ones, 2026-09-06. The
 * > distance of the title the reader actually meant, worst first: `budapest hotell` 246,
 * > `eternl sunshien of the spotles mind` 225, `nile city` 224, `strager thigs` 200,
 * > `brigerton` 100, `matrics` 90, `andrenochrome` 85, `izombee` 40, `seven samuri` 20,
 * > `interstelar` 10, `solstollarna` 0. The best candidate for a string that means nothing:
 * > `xyzzyplughfoo` **401**, `qwertzuiopasdf` **485**.
 * >
 * > So real matches stop at 246 and nonsense starts at 401, and **nothing at all was observed
 * > between them**. 300 sits in the middle of that 155-wide gap rather than against either
 * > edge. A first attempt at 150 looked reasonable and was wrong: it cut `strager thigs`,
 * > which is two ordinary typos, and the canary caught it in one run.
 *
 * If a future query lands inside the band, the honest fix is a canary case naming it, not a
 * quiet nudge to this number -- that is what the suite is for.
 */
const FUZZY_MAX_DISTANCE = 300;

/**
 * The scope for the SECOND pass on an index WITHOUT the trigram tables, taken only when the
 * first finds nothing within the floor.
 *
 * spellfix1 shortlists on a prefix of the phonetic hash -- `scope` characters of it, THREE
 * by default in the vendored source (`x.iScope = 3`; the upstream docs say four and the
 * comments here used to repeat that) -- so a letter inserted near the FRONT of a word moves
 * it out of the bucket and no amount of `top` will reach it. `andrenochrome` hashes to
 * `AMDRMACRMA` against `adrenochrome`'s `ADRMACRMA`: one edit apart, different at character
 * 2, absent from all 300 candidates at the default scope and rank 1 at scope 1.
 *
 * > [!IMPORTANT] This is the LEGACY shape, kept only for an index built before `vocab_tri`
 * > Measured 2026-09-06 on the real vocabulary with 2,000 generated typos: scope 1 costs
 * > 99-119 ms on an M1 Max and still finds only 71% of front-of-word single typos (a typo in
 * > the first LETTER changes the first hash character too), and because it fires only when
 * > the first pass returned nothing within the floor, the two passes together find 74.2% of
 * > what the floor allows. The trigram shortlist (`./vocab-trigrams.ts`) replaces it: unioned
 * > with the phonetic pass on every fuzzy query, it finds 96%+ for about 7 ms. An index
 * > without those tables keeps this fallback until its next rebuild, which the `vocab` stage
 * > stamp orders at the next boot.
 */
const FUZZY_WIDE_SCOPE = 1;

/**
 * What matching every word of the query is worth.
 *
 * Named because two branches of `rank()` read it: the coverage branch, and the FLOOR under
 * an exact title match. An exact match is a strictly stronger statement than "contains every
 * query word" -- the whole title being the query implies every query word appearing -- so
 * the second must never be worth more than the first, and it was, by nine points, which is
 * half of what buried `tt7526136`.
 *
 * > [!IMPORTANT] That invariant used to be a sentence in this comment and nothing else
 * > `14 * exactPlausibility(v)` only reaches 12 at about 10,650 votes, so the claim was false
 * > for very nearly every title in the corpus, and the one place it was patched -- zero votes
 * > -- made the branch step DOWN from 12 to 3.1 between 0 votes and 1. It is a `Math.max` in
 * > `rank()` now, lifted only by {@link hasTypoTwin}, so the comment describes what the code
 * > does rather than what it was hoped to do.
 */
const FULL_COVERAGE_MATCH = 12;

/**
 * The coverage at which every word of the query is present.
 *
 * Just short of 1: `cov` is a ratio of small integers and comparing a division result to
 * exactly 1 is how a 3-of-3 match rounds itself out of its own branch. Named because two
 * places read it -- the coverage branch of `rank()`, and {@link hasTypoTwin}, which needs
 * the same boundary from the other side.
 */
const FULL_COVERAGE = 0.999;

/**
 * What an exact title match is worth at FULL plausibility -- a title everybody has heard of.
 *
 * Above `FULL_COVERAGE_MATCH` by two points, which is the whole of the ordering it buys: an
 * exact match on something famous outranks a title that merely contains every query word.
 * `exactPlausibility` scales it down from here, and {@link FULL_COVERAGE_MATCH} floors how
 * far down it may go whenever nothing on the page could have been mistyped into the query.
 *
 * > [!IMPORTANT] THE 14 WAS SWEPT AND IT IS STAYING, AND THE REASON IS MARGIN
 * > 18 and 20 both measure better on the real log (mean clicked rank 1.41 against 1.47)
 * > with the canary still 46/46, so the temptation is real. `interstelar` has 3.71 points
 * > of headroom today and the 439-vote "Interstelar" gains `(bonus - 14) * 0.5644` of it,
 * > which leaves **0.32 points at 20** and flips the case at 24. The canary is a promote
 * > gate at 100%, so a nightly vote drift inside that margin stops the index refresh for a
 * > live household -- and what it buys is ONE clicked title out of seventeen. Do not spend
 * > 91% of a build gate's margin on a sample of that size. Measured 2026-09-08.
 */
const EXACT_MATCH = 14;

/**
 * How plausible it is that a reader typing this exact title meant this exact title.
 *
 * An exact match on an obscure title is genuinely suspicious -- far more often a typo of
 * something famous than a deliberate search for a 439-vote film, which is the "interstelar"
 * case the canary pins. So the bonus is bought with votes, saturating at 50,000 where
 * further evidence stops being informative.
 *
 * **It only answers a question the candidate set has actually asked.** The suspicion above
 * is a hypothesis ABOUT SOMETHING -- there has to be a famous near-twin for the query to be
 * a typo OF -- and when no such twin is on the page the discount fires anyway and buries a
 * title the reader named letter for letter. `hasTypoTwin` is the gate that asks first.
 */
function exactPlausibility(votes: number): number {
  return Math.min(1, Math.log(votes + 10) / Math.log(50_000));
}

/**
 * How near-identical to the query a candidate must be before it counts as something the
 * query could be a MISSPELLING of.
 *
 * > [!IMPORTANT] The BAND was measured in both directions, and 0.7 is the middle of it
 * > Against the real 1.28M-row index on 2026-09-08, swept end to end against `bun run canary`
 * > and the clicked-title replay that lands with the search-retune change
 * > (`bun run search:replay` -- if that script is not in `package.json` yet, its branch has
 * > not merged and this table cannot be reproduced from `main` alone):
 * >
 * > | value | canary | mean rank of a clicked title |
 * > |---|---|---|
 * > | 0.40 | 46/46 | 2.18 -- worse than not gating at all |
 * > | 0.50 | 46/46 | 1.65 |
 * > | 0.54 | 46/46 | 1.65 |
 * > | **0.55 .. 0.818** | **46/46** | **1.59** |
 * > | 0.82 | 45/46 -- loses `interstelar` | 1.59 |
 * >
 * > Both edges are a real candidate rather than a rounding: 0.818 is `interstelar` against
 * > "Interstellar", the one query in the whole measured population whose exact match IS a
 * > typo of something famous, and 0.545 is `Reel rivals` against "Rivals", the highest-scoring
 * > twin that must NOT fire the discount. The population was the 46 canary queries, the 74
 * > distinct queries in the live search log, and 400 randomly sampled real titles typed back
 * > as queries. **0.7 is the middle of the band, not an edge of it.**
 *
 * `similarity` is Jaccard-blended-with-coverage over character trigrams, so it is blind to
 * WHERE the difference is; that is why {@link hasTypoTwin} needs the other two clauses.
 */
const TYPO_TWIN_SIMILARITY = 0.7;

/**
 * How well known a near-twin must be before the query is read as a misspelling of it.
 *
 * The suspicion `exactPlausibility` encodes is that an obscure exact match is *"more often a
 * typo of something FAMOUS"*, and the famous half is not decoration: two obscure titles one
 * edit apart give a reader no reason to have meant either, so discounting the one they typed
 * exactly is a pure loss.
 *
 * The same 50,000 `exactPlausibility` saturates at, and for the same reason: it is this
 * file's line for "further popularity stops being informative", so it is also the line above
 * which a title is well known enough to be worth mistyping.
 *
 * > [!CAUTION] NEITHER GATE SUITE COVERS THE CASE THIS CLAUSE EXISTS FOR
 * > Swept 1 .. 2,602,282 against the canary and the replay and **nothing moves at all** --
 * > `heart of the beast` is not a canary case and nobody has clicked it in the live log, so
 * > both instruments are blind to it. Deleting the clause on that evidence would be reading
 * > silence as a verdict. Measured by hand instead, on the real index: with the clause the
 * > 2026 "Heart of the Beast" is rank 0; without it, both 0-vote rows fall out of the top
 * > four and the 160k-vote "In the Heart of the Sea" takes the page -- which is verbatim the
 * > bug the since-deleted `UNVOTED_EXACT_MATCH_VOTES` was written for. The near-twin that fires it is the
 * > 339-vote "The Heart of the Bear" (2001), so any bar above a few hundred votes protects
 * > this case; 50,000 is chosen for the reason above rather than to clear that one row.
 * > `search-exact.test.ts` pins it on fixtures, which is where the coverage now lives.
 */
const TYPO_TWIN_VOTES = 50_000;

/** What `rank()` knows about one candidate before it decides what the match is worth. */
export interface Candidate {
  /** The query is this title, letter for letter. Says nothing about the year. */
  nameMatch: boolean;
  /** `nameMatch`, and no explicit year in the query contradicts it. */
  exact: boolean;
  /** Some form of this title begins with the query. */
  prefix: boolean;
  /** Character-trigram similarity to the query, 0..1. */
  textSim: number;
  /** Fraction of the query's words present in the title, 0..1. */
  coverage: number;
  votes: number;
}

/**
 * Is there something on this page the query could be a MISSPELLING of?
 *
 * The question `exactPlausibility` exists to answer, asked before the answer is spent. Three
 * clauses, and each one removes a different impostor from a population where only
 * `interstelar` should survive:
 *
 *   - **not itself an exact match.** Between two titles sharing a name there is no typo
 *     hypothesis at all -- both were named letter for letter -- so votes alone should order
 *     them.
 *   - **the query's words are not all present.** A title containing every word of the query
 *     is an ANSWER to the query as typed, not an alternative reading of it. This is what
 *     separates "Interstellar" (which does not contain `interstelar`) from the twenty
 *     near-identical sequels, reaction videos and original-language pairs that do.
 *   - **famous in its own right.** See {@link TYPO_TWIN_VOTES}.
 *
 * One verdict for the whole query rather than one per candidate: "this query could be a
 * typo" is a fact about the page, not about any row on it.
 *
 * It reads four of {@link Candidate}'s fields and asks for exactly those, so a caller with
 * something else measured -- or a test -- does not have to invent a `prefix` to be ignored.
 */
export function hasTypoTwin(
  candidates: readonly Pick<Candidate, "exact" | "coverage" | "textSim" | "votes">[],
): boolean {
  return candidates.some(
    (c) =>
      !c.exact &&
      c.coverage < FULL_COVERAGE &&
      c.textSim >= TYPO_TWIN_SIMILARITY &&
      c.votes >= TYPO_TWIN_VOTES,
  );
}

/**
 * What an exact title match is worth, given whether the query could be a misspelling.
 *
 * MONOTONIC IN VOTES, in both modes, and that is the property rather than a side effect: two
 * titles sharing a name must be ordered by how many people have seen them, and a bonus that
 * dips as votes arrive orders them by an accident of where the curve crosses a constant. The
 * branch this replaces paid 12 at zero votes, 3.1 at one vote, and did not climb back to 12
 * until about 10,650 -- so the second-most-obscure exact match on the page was the one it
 * treated best. `search-exact.test.ts` walks the whole range.
 */
export function exactMatchBonus(votes: number, typoTwin: boolean): number {
  return Math.max(typoTwin ? 0 : FULL_COVERAGE_MATCH, EXACT_MATCH * exactPlausibility(votes));
}

/**
 * What a title RELEASING SOON is credited with having, at full anticipation.
 *
 * The one editorial number in the anticipation curve, and it is chosen to be statable
 * without reading any code: **at peak anticipation an unreleased title ranks exactly as if
 * it were a released one with 1,500 votes.** Accept or reject that sentence and you have
 * accepted or rejected the feature.
 *
 * It is also the bound on the risk. The lift is at most `popularity(1500) - popularity(0)`
 * = 12.0 points of a 24.7-point term, so **anything with more than 1,500 votes still beats
 * a peak-anticipation unreleased title on popularity alone.** What it is NOT bounded
 * against is the NUMBER of future-dated titles: IMDb carries plenty announced and never
 * made, and with only year, votes, rating and text available there is no plausibility
 * filter to apply. If that ever bites, this constant is the lever.
 */
const ANTICIPATED_VOTES = 1_500;

/**
 * The popularity term, and the one reason a zero in it may not mean what it says.
 *
 * Saturating in votes: the difference between 300k and 2.6M is not informative -- both are
 * famous -- but 439 against 300k is decisive. Without the cap, blockbusters bulldoze every
 * correct-but-smaller match.
 *
 * ## The imputation, and why it cannot double-count
 *
 * `anticipation` shrinks the score toward `ANTICIPATED_VOTES` in proportion to how close the
 * title is to release. `max(0, ...)` makes it self-extinguishing: a 2026 film that already
 * has 50,000 votes scores above the prior, so the gap is negative and the lift is exactly
 * zero. It shrinks continuously to nothing as real votes arrive, which is what stops it
 * double-counting with the votes it is standing in for.
 *
 * > [!IMPORTANT] THERE USED TO BE A SECOND IMPUTATION HERE, AND IT WAS THE SAME ONE
 * > An exact-title match with no votes was ALSO floored, at `UNVOTED_EXACT_MATCH_VOTES`
 * > (1,000), unconditionally and at every age. Both were "replace a measurement we do not
 * > have with a prior", and the doc block here argued they were independent. They are not:
 * > the exact floor fired only on rows with zero votes, so the two priors always applied to
 * > the same rows, and 1,000 votes' worth is strictly less than the 1,500 the anticipation
 * > prior already gives a title at full weight. **On the case it was written for -- the 2026
 * > `heart of the beast` -- it contributed nothing at all.**
 * >
 * > What it DID do was fire at ages where the anticipation curve has deliberately decayed to
 * > nothing. `anticipationWeight`'s own table says a title two years out with nobody rating
 * > it "IS evidence now", and three years and older is "ordinary obscurity, judged on its
 * > votes like everything else" -- and the exact floor overrode exactly that judgement,
 * > handing a thirteen-year-old row with zero votes more popularity than a rival of the same
 * > name with a real, if small, audience. Measured against the live search log on 2026-09-08:
 * > it put a 0-vote 2013 "Reel Rivals" above the 25-vote 2025 one somebody clicked, a 0-vote
 * > 1999 "Look Into My Eyes" above the 711-vote 2024 one, and an undated 0-vote
 * > "Honeymoon/Funeral" at the top of a page whose reader wanted a 184k-vote film.
 * >
 * > So there is one imputation, gated by one curve. `zero votes is unmeasured, not unpopular`
 * > survives intact -- it is just no longer read as true forever.
 */
export function popularity(votes: number, anticipation = 0): number {
  const raw = saturating(votes);
  return raw + anticipation * Math.max(0, saturating(ANTICIPATED_VOTES) - raw);
}

/**
 * Where more votes stop being informative. Q2 of the tuning card, and it is ANSWERED.
 *
 * The question was whether 300,000 is right, and the parent card was correct that a log
 * cannot say -- it needs an experiment: move the cap, replay every clicked title, count how
 * many ranks move. `bun run search:replay` is that experiment, and against the first real log
 * (91 queries, 18 clicks, 2026-09-03..07) the answer is that **the cap has slack above it and
 * none below it**:
 *
 * | cap | canary | mean rank of a clicked title |
 * |---|---|---|
 * | 30,000 | 45/46 -- loses `interstelar` | 2.18 |
 * | 100,000 | 46/46 | 1.47 |
 * | **300,000** | 46/46 | **1.47** |
 * | 1,000,000 | 46/46 | 1.47 |
 *
 * Not one rank moves anywhere between 100k and 1M, so this sits in the middle of a plateau
 * rather than on a slope, and the reason is structural: a query is decided by the few
 * candidates whose text matches, and above 100k votes every one of them is already famous.
 * Below the plateau the cap starts deciding between famous titles, which is exactly what it
 * exists NOT to do. Leave it alone; it is the one constant here with measured headroom.
 */
const VOTE_SATURATION = 300_000;

function saturating(votes: number): number {
  return 2.4 * Math.log(Math.min(votes, VOTE_SATURATION) + 10);
}

/**
 * Why the fuzzy tier is off, when it is off.
 *
 * The tier needs THREE things and each is missing for a different reason with a different
 * remedy: the extension binary, a vocabulary in the index, and somebody having called
 * `prepareFuzzy`. A caller that only knows "fuzzy is off" can only report the symptom, and
 * a diagnostic that names the symptom instead of the cause is what sent one seat hunting
 * through the ranker for a bug it had not written (`src/lib/canary.ts` carries the story).
 */
export type FuzzyAbsence = {
  cause: "extension" | "vocabulary" | "unprepared";
  /** One sentence: what is missing and how to get it. Safe to print to a human. */
  detail: string;
};

export class SearchEngine {
  private db: Database;

  /**
   * Why the fuzzy tier is unavailable, or `null` once it is ready.
   *
   * ONE field rather than a boolean beside a reason, so "is fuzzy on" and "why is it off"
   * can never disagree. Starts as `unprepared`: a `SearchEngine` nobody called
   * `prepareFuzzy` on has no fuzzy tier, and saying that is more useful than blaming a
   * binary that may well be sitting right there.
   */
  private fuzzyAbsence: FuzzyAbsence | null = {
    cause: "unprepared",
    detail: "prepareFuzzy() was never called on this engine",
  };
  private vocabWords = 0;

  /**
   * Everything the open file can do, read once in the constructor.
   *
   * The single source for every `has*` field below, and the same set the promote gate
   * compares a candidate index against -- `./index-capabilities.ts` owns the probes and the
   * argument for keeping them in one place.
   */
  private readonly capabilities!: ReadonlySet<IndexCapability>;

  /**
   * Whether this index carries the trigram shortlist beside the phonetic one.
   *
   * Reported in `prepareFuzzy` with the rest of the fuzzy tier rather than at construction:
   * the tables are only worth anything once the extension is loaded, because the distance
   * they are ranked on is the extension's own function. An index built before them keeps the
   * legacy two-pass shape (see `FUZZY_WIDE_SCOPE`) until its next rebuild.
   */
  private hasTrigrams = false;

  /** `TRIGRAM_DF_TABLE` seek, prepared once; asked ~11 times per fuzzy query. */
  private trigramDf!: ReturnType<Database["prepare"]>;

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
   * Whether this index can SEARCH those people, which is a later stage than holding them.
   *
   * Separate from `hasPeople` because the window between the two is real and is exactly the
   * one an upgrade lands in: an index built by yesterday's image has `person` and
   * `title_principal` and no `pfts` at all, and every person page on it keeps working.
   * Folding the two into one flag would either throw `no such table: pfts` on that index or
   * silently turn person pages off on it.
   *
   * Three checks, one flag, the shape `hasRank` already uses: the FTS table and the two
   * rank columns are one stage's output (`buildPersonSearchIndex`), so an index carrying
   * some of them and not the rest is not a state this build can produce.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasPeopleSearch: boolean;

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
   * Whether this index carries the bulk-loaded PERSON crosswalk.
   *
   * Separate from `hasIds` because they are two stages loading two files, and either can be
   * present without the other -- an index built between the two ships has titles crosswalked
   * and people not. One flag for both would claim a table that is not there.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasPersonIds: boolean;

  /**
   * Whether this index carries `title_lang` -- the language every filter reads.
   *
   * > [!CAUTION] This guard is not "degrade to slower". It is the difference between a
   * > filter and a blank page.
   * > Every other capability here fails toward MORE: no rank column and a browse sorts by
   * > votes, no `title_ids` and a provider buys its own. An index built before this stage
   * > has no `title_lang` rows at all, so the semi-join `browseSql` writes matches NOTHING
   * > -- a configured `languages` would empty every list in the product for the up-to-a-day
   * > window before the next refresh lands, and `hiddenByLanguage` would faithfully report
   * > that we had hidden all of it.
   * >
   * > So the filter is not applied at all when this is false. A reader briefly sees titles
   * > they did not ask for, which is the right way for a preference to fail.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasOrigin: boolean;

  /**
   * Whether this index carries `title_breakout` -- the locale-breakout scores.
   *
   * Fails toward LESS, and that is the easy direction for once: false means the shelf does
   * not render, which is exactly what an index built before this stage should do. There is
   * no degraded form to fall back to, because the scores cannot be derived at query time --
   * they are medians over the whole corpus, which is the reason the stage exists.
   *
   * The stage is ADDITIVE and its table can also be legitimately EMPTY: a build with no
   * origin data on disk files every title as locale-less, no stratum reaches `MIN_STRATUM`,
   * and nothing is scored. `breakoutTitles` then returns no rows and the shelf hides itself
   * down the ordinary empty-shelf path -- the same answer, one layer up.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasBreakout: boolean;

  /**
   * Whether `title_lang` carries the denormalised list columns AND the index that reads them.
   *
   * > [!IMPORTANT] This one gates an OPTIMISATION, not a filter -- the opposite of `hasOrigin`
   * > above, which is the guard it is most easily confused with
   * > `hasOrigin` fails toward MORE because an index without `title_lang` cannot answer a
   * > language question at all. An index built before the WIDENING still has `title_lang`
   * > with `title_rowid` and `lang`, so the `exists`/`not exists` pair `browseSql` writes is
   * > exactly as correct as it ever was -- it just walks down the rank order to find its 250
   * > instead of seeking them. False here means SLOW, never absent, which is the contract
   * > `hasGenreVotes` and `hasGenreYear` already state.
   *
   * FOUR checks and one flag, the shape `hasPeopleSearch` uses: the three columns and
   * `ix_lang_rank` are one stage's output, so a file carrying some of them and not the rest
   * is not a state this build can produce. The index is checked as well as the columns
   * because without it the denormalised join is a SCAN of 1.29M rows -- far worse than the
   * path it replaces, which is the one way a capability probe can make things worse.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasLangRank: boolean;

  /**
   * Whether `title` carries the denormalised `lang` column every ROW payload draws from.
   *
   * > [!CAUTION] Do not confuse this with `hasOrigin`. They gate opposite directions of
   * > the same fact and only one of them is on the render path of every list.
   * > `hasOrigin` is about `title_lang`, which the language FILTER seeks. This is about
   * > one comma-joined display column on `title`, which every `TitleRow` carries so a
   * > card can say what language a title is in without a join. A file can have either
   * > without the other -- they arrive from the same stage but an index built between the
   * > two ships has the table and not the column.
   *
   * Degrades to ABSENT rather than to slow, and it has to: `titleCols` writes
   * `null as lang` when this is false, so a pre-column index serves every row exactly as
   * it always did and no card draws a language until the next refresh. Naming `t.lang`
   * unconditionally would be `no such column` on every shelf, search and browse at once,
   * for the up-to-a-day window before the rebuild lands -- the failure `hasGenreVotes`
   * and `hasLangYear` were each written to prevent, on a wider surface than either.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasTitleLang: boolean;

  /**
   * Whether `title_lang` carries its own copy of `year`, AND `ix_lang_rank` covers it.
   *
   * The sibling of `hasGenreYear`, gating the same trade one table over: with it a browse
   * that crosses a language with a year or a decade names `l.year`, keeps its covering count
   * and stays inside `ix_lang_rank`; without it the same browse names `t.year`, which is what
   * every version before 2026-09-07 did and is correct.
   *
   * > [!IMPORTANT] It degrades to SLOW and it MUST -- this is the one guard here that gates a
   * > new COLUMN rather than a new plan
   * > `hasLangRank` above could have shipped without a probe on the `ix_lang_rank` REORDER,
   * > because an old file still had every column the predicate named. A file built before
   * > this stage has no `title_lang.year` at all, so `l.year` on it is not slower, it is
   * > `no such column` -- a browse that THROWS on a deployment that is otherwise healthy, for
   * > the up-to-a-day window before the next refresh lands.
   *
   * BOTH halves are checked, the shape `hasLangRank` set: the column and the widened index
   * are one stage's output, and a file carrying the column with the narrow index would name
   * `l.year` while the count fell out of the index and back onto a table lookup per row --
   * the one way a capability probe can make things worse rather than better.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasLangYear: boolean;

  /**
   * Whether `title_lang` carries its own copy of `votes`, AND the index that orders by it.
   *
   * The other half of what `hasLangYear` gates, and a SEPARATE flag because it buys a
   * different query: `year` fixes the decade and year slices of a RANKED browse, this one
   * fixes the VOTES sort -- which is the default order, and the one no column on this table
   * could serve at all before 2026-09-07. Measured on a copy of the real index:
   * `?lang=fr&kind=movie&sort=votes` **18.8 ms -> 0.2** and `?lang=en&kind=movie&sort=votes`
   * **28.1 -> 0.9**, same totals.
   *
   * `ix_lang_votes` is checked as well as the column, the shape `hasLangRank` set: without
   * the index the order is a sort of every row of the language rather than a walk, which is
   * the one way a capability probe can make things worse. Degrades to SLOW, never to absent
   * -- an index built before this stage names `t.votes` exactly as it always did.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasLangVotes: boolean;

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
   * Whether `title_genre` carries its own copy of `year`.
   *
   * Degrades to SLOW rather than to absent, like `hasGenreVotes`: without it a year-sliced
   * genre browse reads `t.year` through the join, which is right and is the path every
   * version before 2026-09-05 took. It only became worth copying when a language preference
   * gave that join a query the stored `browse_count` could not answer -- 1,091 ms against
   * 59 ms, measured on the real index.
   *
   * Constructor body, never a field initializer -- see `hasPeople`.
   */
  readonly hasGenreYear: boolean;

  /** Whether `browse_count` is in this file -- see `BrowseOptions.browseCounts`. */
  readonly hasBrowseCounts: boolean;

  /**
   * Whether the rank-ordered indexes this file would be PINNED to actually exist.
   *
   * `INDEXED BY` is not a hint -- SQLite refuses to prepare a statement naming an index that
   * is not there. So a browse that pins one against an index built before `ix_rank_all`
   * existed would not be slow, it would THROW. This probe is what keeps the pin an
   * optimisation rather than a version requirement, the same rule `hasRank` and `hasIds`
   * follow: an older file keeps serving, down the planner's own path, until a rebuild.
   */
  readonly hasRankIndexes: boolean;

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

  /**
   * Whether this index carries the `episode` table.
   *
   * The fifth of these guards, and the reason is the one `hasPeople` states at length: the
   * index a deploy meets is whatever the LAST refresh built, so `episode` is missing for up
   * to a day after this ships and every episode query would throw `no such table: episode`
   * in exactly that window -- on a deployment that is otherwise entirely healthy.
   *
   * Constructor body, never a field initializer -- see `hasPeople`. That is not a style
   * note: an initializer runs before the constructor body, so `= this.tableExists(...)`
   * reads `this.db` while it is still undefined and takes down EVERY construction of this
   * class, including the canary gate on a real index build.
   */
  readonly hasEpisodes: boolean;

  /**
   * The engine's OWN handle, for the one caller that needs raw SQL.
   *
   * `findConnections` walks the cast graph with SQL this class does not expose, and the
   * agent context needs a `Database` to give it. It returns THIS engine's connection rather
   * than opening a second one on the same path, which is the difference between a reader
   * that follows the daily swap and one that does not: a second handle pins the old inode
   * and, after a promote, either throws SQLITE_IOERR_VNODE or -- under load -- quietly
   * serves yesterday. Read it through `LiveIndex` at the moment of use and that cannot
   * happen, because the engine you asked is the engine you are using.
   *
   * Read-only in practice AND enforced: `query_only` is set in the constructor.
   */
  get rawDb(): Database {
    return this.db;
  }

  /**
   * The read-side settings this engine actually opened with, and why.
   *
   * Public because two other things need the SAME answer and must not re-derive it: the
   * holder decides whether to prefault from `tuning.prefault`, and `/api/health` reports the
   * whole thing. Two derivations of one budget would let the holder prefault a file the
   * engine had sized its map against differently, and nothing would ever say so.
   */
  readonly tuning: StorageTuning;

  constructor(
    dbPath: string,
    private cfg: Config,
  ) {
    this.db = new Database(dbPath, { readonly: true });
    /*
      READ-SIDE PRAGMAS FOR A FILE THAT IS WRITTEN ONCE AND NEVER UPDATED.

      aannarr's standing rule, 2026-09-04: `titles.db` is not a "proper database" and should
      not be tuned like one. It is built to a temp file, promoted by rename, and from that
      moment nothing writes a row to it -- so there is no concurrency to protect, no
      integrity to preserve at runtime, and every compromise that trades durability for
      speed is free rather than risky. `finderr.db` -- users, requests, sessions -- is the
      opposite and none of this belongs there.

      - `temp_store = memory`: sorts and temp b-trees never touch disk.
      - `cache_size` and `mmap_size` are DERIVED, and used to be the constants `-262144`
        (256 MB) and `2147483648` (2 GB). Both were sized against the host's RAM by a human,
        and the live deployment then ran them inside a 1.5 GB container -- a map larger than
        the whole box, plus a pager cache worth 17% of it duplicating pages the map already
        held. Nothing in SQLite or Bun reads a cgroup limit, so the numbers could not
        self-correct and nothing reported the mismatch. `./memory-budget.ts` owns the
        derivation and the evidence for each; `TUNING.md` owns the operator-facing version.
      - `query_only`: refuses a write on this connection at the SQLite level rather than
        trusting `readonly: true` alone. Belt and braces on the one invariant this whole
        block assumes, and it makes an accidental write a loud error rather than a surprise.

      NOT set here: `synchronous` and `journal_mode`, which are write-side settings and
      belong to the BUILD connection, not to a reader that will never write.
    */
    this.tuning = resolveTuning({
      budget: detectMemoryBudget(cfg.index.memoryBudgetMb),
      // The file's own size, not `meta.rows` or a guess. An engine opened on a fixture is
      // a few KB and derives settings to match, which is exactly right for a fixture.
      indexBytes: statSync(dbPath).size,
      mmapMbOverride: cfg.index.sqliteMmapMb,
      cacheMbOverride: cfg.index.sqliteCacheMb,
      prefaultOverride: cfg.index.prefault,
    });
    this.db.run("pragma temp_store = memory");
    this.db.run(`pragma cache_size = -${this.tuning.cacheKib}`);
    this.db.run(`pragma mmap_size = ${this.tuning.mmapBytes}`);
    this.db.run("pragma query_only = 1");
    // ONE pass over the schema, answering every "what does this file carry" question at once.
    // The answers are the promote gate's answers too -- see the import comment above.
    this.capabilities = capabilitiesOf(this.db);
    const has = (c: IndexCapability) => this.capabilities.has(c);
    this.hasPeople = has("people");
    this.hasPeopleSearch = has("peopleSearch");
    this.hasRank = has("rank");
    this.hasIds = has("ids");
    this.hasPersonIds = has("personIds");
    this.hasOrigin = has("origin");
    this.hasBreakout = has("breakout");
    this.hasLangRank = has("langRank");
    this.hasTitleLang = has("titleLang");
    this.hasLangYear = has("langYear");
    this.hasLangVotes = has("langVotes");
    this.hasGenreVotes = has("genreVotes");
    this.hasGenreYear = has("genreYear");
    this.hasBrowseCounts = has("browseCounts");
    this.hasRankIndexes = has("rankIndexes");
    this.hasEpisodes = has("episodes");
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
      this.fuzzyAbsence = { cause: "extension", detail: SPELLFIX_MISSING };
      return;
    }

    // An index built before the vocabulary existed is still perfectly serviceable; it
    // just has no fuzzy tier until the next rebuild. Say so rather than throwing.
    if (!this.capabilities.has("fuzzy")) {
      log(`fuzzy: DISABLED -- no '${SPELLFIX_TABLE}' table in this index. Rebuild it to enable typo search.`);
      this.fuzzyAbsence = {
        cause: "vocabulary",
        detail: `this index has no '${SPELLFIX_TABLE}' table; rebuild it with \`bun run index:build\``,
      };
      return;
    }

    this.vocabWords = (
      this.db.query(`select count(*) c from ${SPELLFIX_MAP_TABLE}`).get() as { c: number }
    ).c;
    this.fuzzyAbsence = null;

    this.hasTrigrams = this.capabilities.has("trigrams");
    if (this.hasTrigrams) {
      this.trigramDf = this.db.prepare(`select n from ${TRIGRAM_DF_TABLE} where tri = ?`);
    } else {
      log(
        `fuzzy: no '${TRIGRAM_TABLE}' in this index -- phonetic shortlist only, with the wide retry. ` +
          "The next rebuild adds the trigram shortlist.",
      );
    }

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
      `fuzzy: spellfix1 ready, ${this.vocabWords.toLocaleString()} words, ` +
        `${this.hasTrigrams ? "phonetic + trigram shortlists" : "phonetic shortlist only"} ` +
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
    return this.fuzzyAbsence === null;
  }

  /**
   * Why the fuzzy tier is off, or `null` when it is on.
   *
   * The canary asks this before it decides whether a typo case FAILED or was never
   * runnable in the first place.
   */
  get fuzzyOff(): FuzzyAbsence | null {
    return this.fuzzyAbsence;
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
    if (this.fuzzyAbsence) return "fuzzy off";
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
        `select ${titleCols(this.hasTitleLang)}
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
        `select t.rowid_ as rowid, ${titleCols(this.hasTitleLang, "t.")},
                t.ntitle, t.norig, -bm25(tfts) as bm
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
   *
   * > [!CAUTION] WEIGHTING `cov` BY TOKEN RARITY WAS BUILT, SWEPT AND DECLINED, 2026-09-08.
   * > TOKEN COVERAGE STAYS UNWEIGHTED. THE RECORD IS HERE SO NOBODY RE-DERIVES IT.
   * >
   * > The case was `Leila dilemma` from the live log: no title holds both words, so every
   * > candidate covers exactly one, `cov` ties at 0.5 across the page and popularity decides
   * > -- handing the top two rows to "The Dilemma" (59,512 votes) and "The Social Dilemma"
   * > (95,057) over the "Leila" (9,580) the reader clicked at rank 2. The proposal was to
   * > weight each query word by how rare it is, so the word that IDENTIFIES the title buys
   * > more of the query's coverage than the word that does not.
   * >
   * > Built as `weight(t) = (titles / docFrequency(t)) ^ s`, normalised to sum to 1 so `cov`
   * > stayed a 0..1 ratio and `FULL_COVERAGE` kept meaning "every word present". Frequencies
   * > came from `fts5vocab` over `tfts` -- the same auxiliary table `./vocab-trigrams.ts`
   * > reads trigram frequencies from, so nothing new was stored. `s = 0` is today's
   * > behaviour exactly, which made the status quo a row of the sweep rather than a
   * > remembered number. Measured on an M1 Max against the real 1,276,833-row index
   * > (`data/titles.prev.db`, the newest build carrying a vocabulary) with a frozen snapshot
   * > of the live click log, so every row saw the same 14 clicked titles:
   * >
   * > | s | canary | mean clicked rank | `Leila dilemma` | `Swedish criminal` clicks |
   * > |---|---|---|---|---|
   * > | **0 -- unweighted, shipped** | **46/46** | **1.57** | rank 2 | 6, 3, 2 |
   * > | 0.25 | 46/46 | 1.71 | rank 2 | 6, 3, 2 |
   * > | 0.5 | 46/46 | 1.93 | rank 2 | 7, 3, 2 |
   * > | 1 | 46/46 | 2.64 | rank 2 | 9, 5, 3 |
   * > | 2.5 | **45/46** | 3.57 | **rank 0** | 13, 7, 5 |
   * >
   * > **Monotonically worse, and the one setting that fixes the case fails the build gate.**
   * > Four points in one direction is not a wash to be re-read as noise -- but the per-click
   * > table is where the argument is, and it names the loser: `Swedish criminal`, three
   * > clicked titles, where `swedish` (df 59) swamps `criminal` (df 297) and the page fills
   * > with Swedish titles that are not crime. At `s = 2.5` the canary loses `Nile City`.
   * >
   * > **THE CARD'S PREMISE WAS FALSE, AND THAT IS THE REAL FINDING.** It assumed `dilemma`
   * > was a common word and `leila` a rare one. Out of `fts5vocab`: `leila` is in 59 titles,
   * > `dilemma` in 128. Both are rare and the whole rarity signal between them is a factor of
   * > 2.2. What loses that page is not a common word out-weighing a rare one, it is 59,512
   * > votes against 9,580 -- a popularity gap, reachable only by a popularity lever.
   * >
   * > The arithmetic bounds the idea rather than just this parameterisation, so a different
   * > weighting function is not worth trying either: the partial branch pays `10 * cov`, so
   * > the largest swing ANY weighting can produce between two candidates each covering one
   * > word of a two-word query is 10 points, and spending it means reading a two-word query
   * > as a one-word query. The gap here is 6.96 points; `s = 1` moves 3.68 of them.
   * >
   * > Two things a re-implementer needs and would otherwise learn the hard way. **`cov` is
   * > not only a scoring term, it is the ESCALATION GATE** (`hits[0].coverage < 0.6` in
   * > `search`), so reweighting it changes WHICH TIER answers -- that, not the score, is how
   * > `Nile City` broke: it fell from `fuzzy` to `or`, whose 400-row window does not hold
   * > "NileCity 105.6". And **the `fts5vocab` table must be created before
   * > `pragma query_only = 1`**, which refuses a write to `temp` as readily as to `main`; a
   * > lazy one throws *"attempt to write a readonly database"* on the first query that needs
   * > it, in production, long after every test has passed.
   * >
   * > **What would re-open it:** a click log big enough that 14 titles stop being the
   * > denominator. Nothing else. Run `bun run search:replay` on your own base first -- it
   * > prints the click count beside the mean, and the count has already moved once.
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

    /*
      ONE CLOCK AND ONE ANTICIPATION LOOKUP FOR THE WHOLE RANKING.

      The clock is read once because every candidate must be judged against the same
      instant: an order that reshuffles between two identical queries is the failure the
      total tiebreaks in this file exist to prevent.

      THE MEMO IS WHY THIS NEEDS NO PRECOMPUTED COLUMN, and the numbers are the argument.
      `anticipationWeight` is a pure function of (year, current year), so it COULD be a
      stored column -- the index is rebuilt nightly and a stamped weight would be right for
      a day. Measured on this Mac, 2026-09-05, against the real 1.27M-row index:

        anticipationWeight          31 ns per call
        400-row window, direct    6.84 us
        400-row window, memoised  3.47 us
        one whole search         12.91 ms   (mean over 200 real queries)

      So the entire term is 0.05% of a query and the memo halves an already-invisible
      number. A stored column would buy back 6.8us at the price of a column on 1.28M rows,
      a wider row on every read, and a value that is stale between rebuilds -- which is the
      wrong side of the runtime-beats-build-time trade, not the right one: that rule buys
      QUERY time with build time, and here there is no query time left to buy.
    */
    const now = new Date();
    const anticipation = new Map<number | null, number>();
    const anticipationOf = (year: number | null): number => {
      const seen = anticipation.get(year);
      if (seen !== undefined) return seen;
      const w = anticipationWeight(year, now);
      anticipation.set(year, w);
      return w;
    };

    const seen = new Set<number>();
    const out: Hit[] = [];

    /*
      MEASURE EVERY CANDIDATE FIRST, THEN SCORE THEM.

      The match term is no longer decidable one row at a time: `hasTypoTwin` asks whether
      the query could be a misspelling of something ELSE on this page, and that cannot be
      answered while the page is still arriving. So the loop below only measures -- the
      three text signals plus the year -- and the scoring loop that follows spends them.

      The cost is one array of at most `CANDIDATE_WINDOW` small objects per query, against
      a whole search that measures 12.91 ms; the measurements the memo comment above cites
      were taken on the same window and the same rows.
    */
    const measured: (Candidate & { row: (typeof rows)[number]; ys: number })[] = [];

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
      // or "The Matrix 2021" returns The Matrix (1999). A title the query names letter
      // for letter but whose year contradicts it is NOT exact, here or in `hasTypoTwin`:
      // for that query it is one of the rivals.
      const nameMatch = variants.includes(nq);
      const exact = nameMatch && !(p.year && ys < 0);
      const prefix = variants.some((v) => v.startsWith(nq));

      measured.push({ row: r, ys, nameMatch, exact, prefix, textSim, coverage: cov, votes: r.votes });
    }

    const typoTwin = hasTypoTwin(measured);

    for (const c of measured) {
      const r = c.row;

      let match: number;
      if (c.nameMatch && !c.exact) {
        // The query names this title and its year says otherwise, so it is worth nothing
        // as a title match -- and it must not fall through to the prefix branch, where a
        // string trivially starts with itself. This is what "The Matrix 2021" rides on.
        match = 0;
      } else if (c.exact) {
        /*
          AN EXACT TITLE MATCH IS NEVER WORTH LESS THAN CONTAINING EVERY QUERY WORD.

          The whole title being the query strictly implies every query word appearing, so
          `FULL_COVERAGE_MATCH` is the FLOOR here and the invariant is enforced rather than
          asserted. It used to be asserted, and it was false for everything under about
          10,650 votes: `14 * exactPlausibility(v)` pays a 25-vote exact match 4.6 where a
          title merely containing both words is paid 12, and the branch stepped DOWN from 12
          to 3.1 between 0 votes and 1 because the unvoted case was patched around instead.
          One floor covers both defects and the patch is gone.

          THE FLOOR LIFTS ONLY WHEN THE QUERY COULD BE A MISSPELLING. `exactPlausibility` is
          a real argument -- an obscure exact match IS more often a typo of something famous
          -- but it is an argument about a rival that has to be ON THE PAGE. `hasTypoTwin`
          asks first, so `interstelar` still ranks the 2.6M-vote "Interstellar" over the
          439-vote "Interstelar" it is a typo of, while `Reel rivals`, `heart of the beast`
          and every other query with no famous near-twin keeps the invariant.
        */
        match = exactMatchBonus(r.votes, typoTwin);
      } else if (c.prefix) {
        match = 9;
      } else if (c.coverage >= FULL_COVERAGE) {
        // Matching EVERY query word is qualitatively different from matching half of
        // them, and deserves more than a linear share. This is what lets "Nile City"
        // find NileCity 105.6 over the far more popular Sin City.
        match = FULL_COVERAGE_MATCH;
      } else {
        match = 10 * c.coverage;
      }

      /*
        THE 22 WAS SWEPT TOO, AND IT HAS NO OPTIMUM IN THIS DATA.

        Against the 17 clicked titles in the first real log: 22 -> mean rank 1.47, 24 -> 1.53,
        26 -> 1.47, 28 -> 1.47, 32 -> 1.71, 40 -> 1.82, canary 46/46 throughout. A curve that
        gets WORSE at 24 and better again at 26 is not a curve with a minimum in it, it is
        seventeen samples of noise -- and the one thing the higher values buy is a single
        title crossing a 1.2-point gap, at the price of a fifth of `interstelar`'s margin.
        Anybody re-running this with a bigger log should expect the shape to change; anybody
        re-running it with this one is reading the same noise again.
      */
      const score =
        22 * c.textSim +
        match +
        popularity(r.votes, anticipationOf(r.year)) +
        c.ys +
        kindScore(r.kind, p.kind) +
        recencyScore(r.year);

      out.push({ ...r, score, coverage: c.coverage } as Hit);
    }

    /*
      A TOTAL ORDER, which this sort was not.

      Score alone leaves ties to whatever order the candidates happened to arrive in --
      which is a bm25-and-votes ordering out of FTS, not a decision. Two unvoted titles
      sharing a name tie exactly, and `heart of the beast` has two: a 2017 one and the 2026
      one somebody is actually looking for.

      YEAR breaks it, newest first, for the reason `recencyScore` already gives -- newer is
      what people usually mean, all else equal -- and here everything else genuinely is
      equal. `tconst` behind it because the order must be total or the tie simply moves: two
      titles matching on both would still be free to swap between one keystroke and the
      next, which is the failure `CREDIT_ORDER` and `frequentCollaborators` both spell out.
      A title with no year sorts as year 0, below anything dated, which is right: an undated
      row is the least likely thing a reader meant.
    */
    return out.sort(
      (a, b) => b.score - a.score || (b.year ?? 0) - (a.year ?? 0) || a.tconst.localeCompare(b.tconst),
    );
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
    if (this.fuzzyAbsence) return [];
    const nq = normalizeStripped(p.text);
    if (nq.length === 0) return [];

    // The phonetic shortlist at spellfix1's default scope: 2 to 11 ms against the real
    // vocabulary, measured 2026-09-06, and blind to a typo in the first three hash characters.
    let near = this.spellfixRows(nq, limit, null).filter((r) => r.distance <= FUZZY_MAX_DISTANCE);

    if (this.hasTrigrams) {
      // The trigram shortlist, UNIONED rather than chained -- `./vocab-trigrams.ts` has the
      // measurement that decided that. Both report the same distance, so one floor serves.
      near = near.concat(this.trigramRows(nq, limit).filter((r) => r.distance <= FUZZY_MAX_DISTANCE));
    } else if (near.length === 0) {
      // An index built before the trigram tables: the legacy wide retry, see FUZZY_WIDE_SCOPE.
      near = this.spellfixRows(nq, limit, FUZZY_WIDE_SCOPE).filter((r) => r.distance <= FUZZY_MAX_DISTANCE);
    }

    // One title can appear several times -- primary and original form, and from both
    // shortlists. Keep the closest occurrence; `rank()` re-scores everything anyway, so the
    // order here only decides which duplicate survives.
    near.sort((a, b) => a.distance - b.distance);
    const seen = new Set<number>();
    const out: number[] = [];
    for (const r of near) {
      if (seen.has(r.rowid)) continue;
      seen.add(r.rowid);
      out.push(r.rowid);
    }
    return out;
  }

  /**
   * The trigram shortlist, ranked on the SAME distance the phonetic one reports.
   *
   * `spellfix1_editdist` is the extension's own `editdist1`, the function behind the
   * `distance` column of a MATCH -- so `FUZZY_MAX_DISTANCE` means one thing on both paths and
   * the floor's calibration carries over untouched. The word comes back through the spellfix1
   * table by rowid rather than from its shadow table, so nothing here depends on the
   * extension's storage layout.
   *
   * Eight rarest trigrams, dropping any the vocabulary never contains: the frequency table
   * is the whole of the cost control, and `./vocab-trigrams.ts` carries the numbers.
   */
  private trigramRows(nq: string, limit: number): { rowid: number; distance: number }[] {
    const grams = rarestTrigrams(trigramsOf(nq), (g) => {
      const row = this.trigramDf.get(g) as { n: number } | null;
      return row?.n ?? 0;
    });
    if (grams.length === 0) return [];
    return this.db
      .query(
        `select m.rowid_ as rowid, spellfix1_editdist(?3, v.word) as distance
           from (${trigramShortlistSql()}) s
           join ${SPELLFIX_TABLE} v on v.rowid = s.id
           join ${SPELLFIX_MAP_TABLE} m on m.id = s.id`,
      )
      .all(trigramMatchExpr(grams), limit, nq) as { rowid: number; distance: number }[];
  }

  /**
   * One spellfix1 lookup. `scope` null means the extension's own default.
   *
   * `distance` is SELECTED rather than discarded, which is the whole of the fix above: it is
   * the only signal that separates "one edit away" from "shares a phonetic bucket and nothing
   * else", and `rank()` cannot re-derive it -- its `textSim` is trigram overlap, which is 0
   * for both a near miss on a short word and a total stranger.
   */
  private spellfixRows(
    nq: string,
    limit: number,
    scope: number | null,
  ): { rowid: number; distance: number }[] {
    const sql = `select m.rowid_ as rowid, v.distance as distance from ${SPELLFIX_TABLE} v
       join ${SPELLFIX_MAP_TABLE} m on m.id = v.rowid
       where v.word match ? and v.top = ?${scope === null ? "" : " and v.scope = ?"}`;
    const args = scope === null ? [nq, limit] : [nq, limit, scope];
    return this.db.query(sql).all(...(args as never[])) as { rowid: number; distance: number }[];
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
            `select rowid_ as rowid, ${titleCols(this.hasTitleLang)}, ntitle, norig
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
      if (weak(ranked) && !this.fuzzyAbsence) {
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
      (this.db.query(`select ${titleCols(this.hasTitleLang)} from title where tconst = ?`).get(tconst) as
        | TitleRow
        | undefined) ?? null
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
    const cols = titleCols(this.hasTitleLang, "t.");
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
            `select ${titleCols(this.hasTitleLang)}
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
        `select ${titleCols(this.hasTitleLang)}
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
            `select ${titleCols(this.hasTitleLang, "t.")}
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
            `select ${titleCols(this.hasTitleLang)}
         from title
         where year >= ? and votes >= 5000 and rating >= 7.0
         order by rating * ln(votes) desc
         limit ?`,
          )
          .all(decade, limit * 3) as TitleRow[]);
    const out = opts.excludeTconsts ? rows.filter((r) => !opts.excludeTconsts?.has(r.tconst)) : rows;
    return out.slice(0, limit);
  }

  /**
   * Which genres actually have enough good titles to be worth a shelf.
   *
   * **Read from `meta`, computed at build.** The answer is a pure function of the finished
   * index, so it cannot change while a file is open -- and it was costing **25.05 ms on every
   * uncached front-page assembly**, measured on the real 2.18 GB index, as an aggregate over
   * `title_genre` joined to `title` with a temp b-tree for the GROUP BY and another for the
   * ORDER BY. It is one row read now.
   *
   * The fallback runs the original aggregate, for an index built before the key existed --
   * the same rule `hasRank` and `hasIds` follow: an older file keeps serving, more slowly,
   * until the stage stamp orders the rebuild that fixes it. `computeShelfGenres` is shared
   * with the builder rather than copied, so the live answer and the stored one cannot drift.
   */
  topGenres(limit = 6): string[] {
    const stored = this.db.query("select value from meta where key = ?").get(SHELF_GENRES_META_KEY) as
      | { value: string }
      | undefined;
    // An empty string is a legitimately empty answer (an index with no genre clearing the
    // floors), so the fallback is keyed on the ROW being absent, never on the value.
    if (stored) return stored.value === "" ? [] : stored.value.split(",").slice(0, limit);
    return computeShelfGenres(this.db).slice(0, limit);
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
  /**
   * What language a title is in and where it came from, or `null` on an index without them.
   *
   * `null` and not `{lang: [], country: []}`, which is the same distinction `findPerson`
   * draws with `unavailable`: "this index cannot answer" and "nobody knows this title's
   * language" are different facts, and a caller that merges them will report the second
   * when the first is true. An agent in particular must be able to say "I cannot tell you"
   * rather than "it is unknown", because only one of those is worth rebuilding for.
   *
   * `UNKNOWN_LANG` never leaks out of here -- it is a storage device for keeping the browse
   * filter to one predicate, not a language, so it is stripped and an empty list is the
   * honest answer.
   */
  originOf(tconst: string): { lang: string[]; country: string[] } | null {
    if (!this.hasOrigin) return null;
    const row = this.db.query("select rowid_, country from title where tconst = ?").get(tconst) as
      | { rowid_: number; country: string | null }
      | undefined;
    if (!row) return null;
    const langs = this.db
      .query("select lang from title_lang where title_rowid = ? and lang != '' order by lang")
      .all(row.rowid_) as { lang: string }[];
    return { lang: langs.map((l) => l.lang), country: row.country ? row.country.split(",") : [] };
  }

  /**
   * Titles that were enormous where they were made and are unknown here.
   *
   * The whole shape of this query is "read a stored answer": the two thresholds were
   * percentiles when `breakoutStage` computed them and are plain numbers by the time they
   * reach SQLite, so this is an indexed seek on `ix_breakout` and never a sort over the
   * corpus. Ordering by anything computed here would be the 1,508 ms mistake measured on
   * 2026-09-07 -- an expression in `order by` abandons the index and materialises 1.27M rows.
   *
   * > [!IMPORTANT] A MISSING CUTOFF EMPTIES THE SHELF, deliberately
   * > The two `meta` reads are subqueries, so an index carrying `title_breakout` but not the
   * > cutoffs (a build from between these two commits, and nothing else) yields `NULL`, every
   * > comparison against it is `NULL`, and no row passes. That is `breakoutCutoff`'s
   * > `Infinity` contract arriving intact at the database: a threshold nobody can clear beats
   * > a shelf assembled from a made-up number.
   */
  breakoutTitles(limit: number): TitleRow[] {
    if (!this.hasBreakout) return [];
    return this.db
      .query(
        `select ${titleCols(this.hasTitleLang, "t.")}
         from title_breakout b
         join title t on t.rowid_ = b.title_rowid
         where b.local = 1
           and b.reach >= (select cast(value as real) from meta where key = ?)
           and b.love  >= (select cast(value as real) from meta where key = ?)
           and t.votes between ? and ?
           and t.year >= ?
           -- Already in the all-time head is already on the front page. Without this, 18 of
           -- the top 30 are the existing Top 250 row wearing a different heading. It is a
           -- stored SCORE rather than a "not in top N" subquery for two reasons: on a corpus
           -- smaller than the head every title is in the head, so that form empties the shelf
           -- (a fixture caught it); and this way the head costs one comparison, not a
           -- 2,500-row subquery per candidate row.
           and (t.rank is null or t.rank < (select cast(value as real) from meta where key = ?))
         order by b.love desc
         limit ?`,
      )
      .all(
        BREAKOUT_META.reach,
        BREAKOUT_META.love,
        BREAKOUT_SHELF.minVotes,
        BREAKOUT_SHELF.maxVotes,
        BREAKOUT_SHELF.fromYear,
        BREAKOUT_META.rankHead,
        limit,
      ) as TitleRow[];
  }

  browse(opts: BrowseOptions): BrowseResult {
    /*
      A NAMED LANGUAGE REFUSES on an index with no `title_lang`, where the preference below
      DROPS -- and the two opposite answers are the same rule applied to different things.

      A preference fails toward showing too much: a reader briefly sees titles they did not
      ask for. A `lang` is what the page IS, so dropping it would serve the unfiltered top
      250 under the heading "Best films in Korean" -- a wrong answer wearing a right one's
      name, which is what `rankedMembers` refuses for `rank` for the same reason.

      It is also a hard requirement rather than a nicety: `title_lang` is absent as a TABLE
      on such an index, so the semi-join would not return nothing, it would throw.
    */
    if (opts.lang !== undefined && !this.hasOrigin) return { rows: [], total: 0 };
    const safe = opts.sort === "rank" && !this.hasRank ? { ...opts, sort: "votes" as const } : opts;
    // `genreVotes` is a CAPABILITY, so it comes from the open file and is never something a
    // caller passes in -- same split as the downgrade above: policy in `browseIndex`, "what
    // can this particular file do" here.
    return browseIndex(this.db, {
      ...safe,
      // THE SECOND DOWNGRADE, and it drops the filter rather than narrowing it. An index
      // built before the origin stage has no `title_lang` rows, so applying a preference to
      // it would empty every list in the product -- see `hasOrigin`. A reader briefly seeing
      // titles they did not ask for is the right way for a preference to fail.
      languages: this.hasOrigin ? safe.languages : undefined,
      genreVotes: this.hasGenreVotes,
      genreYear: this.hasGenreYear,
      langRank: this.hasLangRank,
      langYear: this.hasLangYear,
      langVotes: this.hasLangVotes,
      titleLang: this.hasTitleLang,
      browseCounts: this.hasBrowseCounts,
      rankIndexes: this.hasRankIndexes,
    });
  }

  /**
   * The head of a ranked list, as ids -- and NOTHING at all on an index with no rank.
   *
   * The opposite call to `browse` above: that one downgrades a ranked sort to votes so a
   * generic grid still renders, and this one refuses. A completion count is a claim ABOUT A
   * NAMED LIST -- "you own 178 of the top 250 horror films" -- so counting a votes-ordered
   * head under a ranked list's label would be a wrong answer wearing a right one's name,
   * which is the same reason `discoveryShelves` asks `hasRank` before drawing a top list.
   * An empty array is the honest answer, and every caller renders nothing for it.
   */
  rankedMembers(filters: BrowseFilters, size: number): string[] {
    if (!this.hasRank) return [];
    // The same refusal `browse` makes above, and the reason `/lists` draws no language rows
    // at all on an index built before the origin stage: no members means no completion,
    // which means the group has nothing to render. See `listGroups`.
    if (filters.lang !== undefined && !this.hasOrigin) return [];
    return browseMembers(this.db, {
      ...filters,
      sort: "rank",
      limit: size,
      genreVotes: this.hasGenreVotes,
      genreYear: this.hasGenreYear,
      langRank: this.hasLangRank,
      langYear: this.hasLangYear,
      langVotes: this.hasLangVotes,
      rankIndexes: this.hasRankIndexes,
    });
  }

  /**
   * How many ranked non-English titles of `kind` each language reaches -- the population
   * `LIST_LANGUAGES` is drawn from, counted rather than remembered.
   *
   * `null` for an index that cannot answer, and `null` and an empty map are different answers
   * for the reason `searchPeople` keeps them apart: an empty map would say "no language has a
   * single ranked film", which is a finding, and this says "do not read one from this file".
   *
   * `UNKNOWN_LANG` is stripped HERE rather than by the caller, where `browseIndex` strips it
   * from `hiddenByLanguage` for the same reason: the empty string is a storage device that
   * keeps the language filter to one predicate, and 186,109 films filed under it would be
   * reported as a language missing its list.
   *
   * > [!NOTE] The `not exists` pair rather than the `non_english` column, deliberately
   * > `title_lang.non_english` is the same predicate denormalised and it is 13x faster
   * > (69 ms against 938 on the real 1.27M-title index, M1 Max, 2026-09-07, identical answers
   * > for all 146 codes). It is also a v3 column, so using it would mean a second query for
   * > older files -- two copies of the one rule this whole audit exists to stop drifting.
   * > A second of scan in a job that runs beside a two-second canary buys nothing worth that.
   */
  rankedNonEnglishCounts(kind: string): Map<string, number> | null {
    if (!this.hasOrigin || !this.hasRank) return null;
    const rows = this.db
      .query(
        `select l.lang lang, count(*) films
           from title_lang l join title t on t.rowid_ = l.title_rowid
          where t.kind = ? and t.rank is not null
            and not exists (select 1 from title_lang e
                             where e.title_rowid = l.title_rowid and e.lang = ?)
          group by l.lang`,
      )
      .all(kind, ENGLISH_LANG) as { lang: string; films: number }[];
    return new Map(rows.filter((r) => r.lang !== UNKNOWN_LANG).map((r) => [r.lang, r.films]));
  }

  /** A person and their filmography. `null` for an unknown id, or an index without people. */
  personPage(nconst: string, opts: PersonCreditsOptions = {}): PersonPage | null {
    // `titleLang` is a capability of the open FILE, so it is injected here rather than
    // being something a caller passes -- the same split `browse` makes just above.
    return this.hasPeople ? personPage(this.db, nconst, { ...opts, titleLang: this.hasTitleLang }) : null;
  }

  /**
   * People matching a typed query, best known first -- or `null` when this index cannot say.
   *
   * `null` and `[]` are DIFFERENT ANSWERS and the caller must keep them apart: `[]` is
   * "nobody by that name", `null` is "this index has no people search", and a client shown
   * an empty row for the second would read a missing capability as a missing person.
   *
   * A SECOND query beside the title search rather than a tier inside it. A person and a
   * title are different nouns with different cards and different destinations, and the
   * title ladder is tuned against a 42-case canary that has nothing to say about people.
   */
  searchPeople(query: string, opts: PersonSearchOptions = {}): PersonHit[] | null {
    return this.hasPeopleSearch ? searchPeople(this.db, query, opts) : null;
  }

  /**
   * Who is credited on a set of titles, per person per category.
   *
   * Empty for an index built before the cast tables, on the same terms as
   * `frequentCollaborators`: a board that cannot be built is a section the page omits, not
   * an error. See `creditTally` for what it costs and what bounds it.
   */
  creditTally(tconsts: readonly string[]): CreditTally[] {
    return this.hasPeople ? creditTally(this.db, tconsts) : [];
  }

  /** Who this person keeps working with. Empty for an index built before the cast tables. */
  frequentCollaborators(nconst: string, opts: CollaboratorOptions = {}): Collaborator[] {
    return this.hasPeople ? frequentCollaborators(this.db, nconst, opts) : [];
  }

  /**
   * Our own ids for the credits on a title, so a cast list can become links.
   *
   * The two halves are gated separately because they come from different stages: an index
   * can carry the cast tables without the person crosswalk (any index built before this
   * shipped does), and neither half depends on the other being there.
   */
  personLinks(tconst: string, credits: readonly PersonCredit[]): PersonLinks {
    return {
      byId: this.hasPersonIds ? Object.fromEntries(nconstsForCredits(this.db, credits)) : {},
      byName: this.hasPeople ? Object.fromEntries(nconstsByNameForTitle(this.db, tconst)) : {},
    };
  }

  /**
   * A series' episodes, in running order, from local SQLite and nothing else.
   *
   * `[]` on an index built before the episode stage, and `[]` for a series below the build's
   * vote floor. The caller cannot tell those apart and should not try to: both mean "this
   * index has no episodes for you", and there is nothing a reader could do about either.
   *
   * This is the one place where returning `[]` for a missing capability is right rather than
   * misleading -- unlike `searchPeople`, which returns `null` because an empty people search
   * would read as "nobody by that name". An empty episode list draws no pane at all, so the
   * two answers render identically.
   */
  episodesOf(parent: string, opts: EpisodeQuery = {}): EpisodeRow[] {
    return this.hasEpisodes ? queryEpisodes(this.db, parent, opts) : [];
  }
}

/** What a browse query filters on. `minVotes` and paging are deliberately not in here. */
export interface BrowseFilters {
  genre?: string;
  decade?: number;
  year?: number;
  kind?: string;
  /**
   * An inclusive `[from, to]` release-year range, for the span no decade expresses.
   *
   * "The last fifteen years" is the question that made this exist: it is two decades and
   * neither of them, so an agent asked for it had to fire two `decade` calls and stitch the
   * answers -- which is how it came to be reading two lists instead of one and reasoning
   * over the join itself.
   *
   * `year` wins over this and this wins over `decade`, which is the order of how specific
   * they are. Nothing sends more than one; the precedence exists so that a caller which
   * does gets a defined answer rather than two conflicting predicates.
   */
  years?: [number, number];
  /**
   * ONE ISO 639-1 code the title is in -- and, unless that code IS English, is not also in.
   *
   * > [!IMPORTANT] A FILTER, where `BrowseOptions.languages` is a PREFERENCE, and the two
   * > mean genuinely different things rather than being one idea spelled twice
   * > `languages` is what the DEPLOYMENT wants to see by default: any-match, fail-open over
   * > the titles nobody knows the language of, liftable with `anyLanguage=1`, and kept out
   * > of the address bar on purpose. This is what a PAGE IS -- "Best films in Korean" -- so
   * > it belongs in the URL exactly as `genre` does, and the two never apply together: a
   * > reader who named a language has overridden the default, and applying both would empty
   * > every language list on a deployment that had configured one.
   *
   * **The English exclusion is the whole reason this is not just `languages: [code]`, and it
   * was measured rather than assumed.** Wikidata's P364 is multi-valued and the any-match
   * rule admits a film with a single subtitled scene: on the real 1.27M-row index the top of
   * "has `ja`" is Inception, "has `es`" is Coco and Toy Story, "has `it`" is The Godfather.
   * Excluding English gives Spirited Away, Pan's Labyrinth and Cinema Paradiso instead --
   * measured across 34 languages on 2026-09-06. A preference should fail toward showing too
   * much; a list whose NAME is a claim about the film must not.
   *
   * Restricting to a SOLE language was measured too and rejected: it barely changes the size
   * (Korean 1,401 against 1,421) while dropping films that are genuinely multilingual in
   * their own country -- Three Colors is `fr`/`pl`.
   */
  lang?: string;
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
  /**
   * ISO 639-1 codes a title's ORIGINAL language must be one of. Empty or absent = no filter.
   *
   * > [!IMPORTANT] An OPTION, deliberately, and never a `BrowseFilters` key
   * > It rides beside `minVotes` for exactly the reason `minVotes` does: it is a
   * > PREFERENCE the deployment holds, not a description of the list, so it must not reach
   * > the address bar. A `?languages=en,sv` would be shareable state that then has to be
   * > validated, kept meaningful across index rebuilds, and reconciled with the config
   * > every time the two disagreed. Passing `[]` is how the "show everything" hatch lifts
   * > it, which is the same shape as `minVotes: 0`.
   *
   * `UNKNOWN_LANG` -- the empty string -- is a member like any other, and including it is
   * what makes the filter FAIL OPEN over the corpus's 16% with no language on record. The
   * caller decides; `languageFilter` is where the deployment's answer is spelled.
   */
  languages?: readonly string[];
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
  /**
   * Whether `title_genre` carries its own `year` copy -- `SearchEngine.hasGenreYear`.
   *
   * Defaults to FALSE for the same reason `genreVotes` does: a caller that forgot to ask
   * the file should get a slower answer, never `no such column` on a real index.
   */
  genreYear?: boolean;
  /**
   * Whether this index carries `browse_count` -- `SearchEngine.hasBrowseCounts`.
   *
   * A CAPABILITY of the open file, passed in for the same reason `genreVotes` is: `browseIndex`
   * is pure policy over a database somebody hands it, and "what can this particular file do"
   * is not policy. An index built before the stage existed answers every total correctly down
   * the live-count path.
   */
  browseCounts?: boolean;
  /**
   * Whether the rank indexes a decade browse PINS to exist -- `SearchEngine.hasRankIndexes`.
   *
   * A capability of the open file, like `genreVotes` and `browseCounts`. False means the
   * query is built without `INDEXED BY` and the planner chooses, which is correct and slower.
   */
  rankIndexes?: boolean;
  /**
   * Whether `title_lang` carries the denormalised list columns -- `SearchEngine.hasLangRank`.
   *
   * A capability of the open file, like the three above. False means a named language is
   * filtered by the `exists`/`not exists` pair against `title` -- the same rows, found by
   * walking the rank order rather than by seeking `ix_lang_rank`.
   */
  langRank?: boolean;
  /**
   * Whether `title_lang` carries its own `year` copy -- `SearchEngine.hasLangYear`.
   *
   * A capability of the open file, like the four above, and it defaults to FALSE for the
   * reason `genreYear` states: a caller that forgot to ask the file gets the slower reading
   * of `title.year`, never `no such column` on a real index.
   */
  langYear?: boolean;
  /**
   * Whether `title_lang` carries its own `votes` copy -- `SearchEngine.hasLangVotes`.
   *
   * A capability of the open file, defaulting to FALSE for the reason `genreYear` states.
   */
  langVotes?: boolean;

  /**
   * Whether `title` carries the `lang` display column -- `SearchEngine.hasTitleLang`.
   *
   * NOT in `BrowseCaps` and deliberately so: every other capability here changes the
   * PLAN, so `browseSql` needs it and `capsOf` forwards it. This one only changes the
   * SELECT list of the row fetch, which `browseSql` does not build, so it is read
   * straight off `opts` where the columns are chosen.
   *
   * Defaults to FALSE for the reason `genreYear` states -- an option a caller forgot to
   * pass must produce the query every version before this one wrote.
   */
  titleLang?: boolean;
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

/**
 * How many titles the LANGUAGE preference removed, and which languages were kept.
 *
 * The same contract `HiddenByFloor` has and for the same reason: a threshold of ours may
 * empty a result, and it may never let that be mistaken for absence. It carries the
 * languages actually applied rather than leaving the client to restate them from config,
 * so the copy on screen cannot name a set different from the one the query used.
 */
export interface HiddenByLanguage {
  titles: number;
  languages: string[];
}

export interface BrowseResult {
  rows: TitleRow[];
  total: number;
  /** Present ONLY when the vote floor is the reason this query came back empty. */
  hiddenByFloor?: HiddenByFloor;
  /**
   * Present ONLY when the language preference is the reason this query came back empty.
   *
   * Never set alongside `hiddenByFloor`: they are two answers to one question and the
   * outer one wins, because lifting the floor inside a language filter would offer a
   * number the reader cannot reach. See `browseIndex`.
   */
  hiddenByLanguage?: HiddenByLanguage;
}

/**
 * The default vote floor for an unfiltered grid: below this, "all movies by votes"
 * opens on titles nobody has heard of.
 */
// Re-exported rather than redeclared: the build BAKES this into `browse_count.n_floor`, so
// the floor a query applies and the floor a stored count was built at must be one constant.
// `index-builder.ts` owns it for that reason.
export { BROWSE_VOTE_FLOOR };

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
  // A `years` range drops the floor for the identical reason a decade does -- it pins a
  // narrow span that cannot flood anything, and the floor there censors rather than curates.
  return f.year !== undefined || f.decade !== undefined || f.years !== undefined ? 0 : BROWSE_VOTE_FLOOR;
}

/**
 * The language list a query should carry, given what the deployment configured.
 *
 * THE SINGLE OWNER of the fail-open rule, and the only reason it is a function rather than
 * `cfg.languages` passed straight through. Every caller that filters has to append
 * `UNKNOWN_LANG`, and a caller that forgot would hide the 16% of the corpus whose language
 * Wikidata has never recorded -- silently, and only for readers who had opted in, which is
 * the shape of bug nobody reports because the titles were simply never there.
 *
 * Empty in, empty out: no preference is not a preference for nothing.
 */
export function languageFilter(configured: readonly string[]): string[] {
  return configured.length === 0 ? [] : [...configured, UNKNOWN_LANG];
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
/**
 * What the OPEN FILE can do, plus the preference the caller is applying.
 *
 * An object rather than four trailing positional booleans, and the reason is mechanical:
 * `browseSql` is called from five places and a capability added at the end has to be
 * threaded correctly through every one of them. The fifth argument being `false` when it
 * meant `rankIndexes` and the sixth meaning `genreVotes` is a bug no type can catch, and
 * the failure is silent -- a query that is correct and a hundred times slower.
 */
interface BrowseCaps {
  genreVotes?: boolean;
  genreYear?: boolean;
  rankIndexes?: boolean;
  langRank?: boolean;
  langYear?: boolean;
  langVotes?: boolean;
  languages?: readonly string[];
}

/**
 * The file's capabilities off a `BrowseOptions`, in one place.
 *
 * `languages` is deliberately NOT here: it is a PREFERENCE the caller applies rather than
 * something the file can do, and two of the five call sites pass a different one from
 * `opts.languages` -- the honest-empty recount deliberately drops it. Folding it in would
 * make that recount silently filtered and `hiddenByLanguage` would always be zero.
 */
function capsOf(opts: BrowseOptions): BrowseCaps {
  return {
    genreVotes: opts.genreVotes,
    genreYear: opts.genreYear,
    rankIndexes: opts.rankIndexes,
    langRank: opts.langRank,
    langYear: opts.langYear,
    langVotes: opts.langVotes,
  };
}

function browseSql(
  f: BrowseFilters,
  minVotes: number,
  sort: BrowseSort = "votes",
  caps: BrowseCaps = {},
): {
  join: string;
  countFrom: string;
  where: string;
  order: string;
  args: unknown[];
  /** ` indexed by <name>`, or empty. Goes straight after `title t`. See the rank pin below. */
  indexedBy: string;
} {
  const {
    genreVotes = false,
    genreYear = false,
    rankIndexes = false,
    langRank = false,
    langYear = false,
    langVotes = false,
    languages = [],
  } = caps;
  const where: string[] = [];
  const args: unknown[] = [];
  // Set by any clause that names a column only `title` has. It is what decides whether the
  // count may drop the join, and it is a flag rather than a grep over the built SQL: a
  // predicate that quietly starts reading `t.` while a string test still passes is exactly
  // the bug that would make a count wrong instead of slow.
  let touchesTitle = false;
  const genreJoin = f.genre ? "join title_genre g on g.title_rowid = t.rowid_" : "";
  if (f.genre) {
    where.push("g.genre = ?");
    args.push(f.genre);
  }
  /*
    THE SECOND JOIN, and it is decided HERE -- before `kind` and before the order -- because
    it decides which table serves both of them.

    A named language on a file carrying the denormalised columns stops being a predicate
    applied to `title` and becomes the table the query DRIVES FROM: `ix_lang_rank(lang, kind,
    rank desc, non_english)` fixes two equality columns and reads the third in output order,
    so 250 rows are 250 rows read. `langListJoin` decides it on ONE question -- whether the
    language predicate is selective -- and English is the case where the answer is no.
  */
  const langJoin = langListJoin(f, { langRank, langYear, langVotes }, sort);
  /*
    WHICH TABLE'S COPY OF `votes` -- exactly the question `ranked` answers below for `rank`,
    and it decides the whole cost of a genre browse.

    `title_genre` carries `votes` denormalised from `title`, and `ix_tg_votes(genre, votes
    desc, kind)` covers the seek, the order and the kind filter together. Naming `t.votes`
    instead is the same numbers in the same sequence and a primary-key lookup into `title`
    per matching row to get there, then a temp b-tree -- 3.66s against a seek, measured on
    the live NAS index. So the join decides which column is named, not taste.

    `title_lang` carries its own copy since 2026-09-07 and takes PRECEDENCE, the same order
    `ranked` and `yearCol` use and for the same reason: the language seek is the more
    selective of the two, and only the table the query drives from can serve the order.
    `ix_lang_votes(lang, kind, votes desc, non_english)` is the exact counterpart of
    `ix_tg_votes` one table over. It is what makes a VOTES sort -- the default order --
    affordable for a named language at all: measured over rows and count together,
    `?lang=fr&kind=movie&sort=votes` 18.8 ms -> 0.2 and `?lang=en&...` 28.1 -> 0.9.

    `genreVotes` and `langVotes` false are an index built before the respective column
    existed: it still answers every query correctly, on the old slow path, until the rebuild
    the stage stamp has ordered.
  */
  const voted = langJoin && langVotes ? "l.votes" : genreJoin && genreVotes ? "g.votes" : "t.votes";
  // `votes >= 0` is true for every row -- the column is `not null default 0` -- so
  // spelling it out only stops SQLite covering the count from an index. Omitting it is
  // what makes an unfloored per-genre list a pure seek.
  if (minVotes > 0) {
    where.push(`${voted} >= ?`);
    args.push(minVotes);
    if (voted.startsWith("t.")) touchesTitle = true;
  }
  /*
    WHICH TABLE'S COPY OF `year`, the same question `voted` and `ranked` answer below, and
    with the same precedence `ranked` uses: `title_lang` first, then `title_genre`, then
    `title`. The language seek is the more selective of the two and is the table the query
    drives from, so it is the one whose copy keeps the count covering.

    `title_genre` carries `year` denormalised since 2026-09-05, and naming it is what keeps
    a year-sliced genre count reading `title_genre` alone. It was NOT copied before that,
    on the stated grounds that a stored `browse_count` answers every unfiltered total so the
    join was only ever paid by queries the count table could not express -- which was true
    until a LANGUAGE PREFERENCE became such a query. Measured on the real index, Crime
    movies 2011-2026 with a preference: 1,091 ms through `title`, 59 ms from this column.

    `title_lang` carries it since 2026-09-07, for the identical reason one table over: a
    browse that NAMES a language and slices it by a year or a decade had to reach back into
    `title`, which cost it the covering count and, for English, the whole denormalised path.
    See `langIndexServesAlone` for the numbers that bought it.

    `genreYear` and `langYear` false are an index built before the respective column existed:
    correct, on the old slow path, until the rebuild the stage stamp has already ordered.
  */
  const yearCol = langJoin && langYear ? "l.year" : genreJoin && genreYear ? "g.year" : "t.year";
  const yearOnTitle = yearCol.startsWith("t.");
  if (f.decade !== undefined) {
    where.push(`${yearCol} >= ? and ${yearCol} <= ?`);
    args.push(f.decade, f.decade + 9);
    if (yearOnTitle) touchesTitle = true;
  }
  if (f.year !== undefined) {
    where.push(`${yearCol} = ?`);
    args.push(f.year);
    if (yearOnTitle) touchesTitle = true;
  } else if (f.years) {
    where.push(`${yearCol} >= ? and ${yearCol} <= ?`);
    args.push(f.years[0], f.years[1]);
    if (yearOnTitle) touchesTitle = true;
  }
  if (f.kind) {
    // WHICH TABLE'S COPY OF `kind`, the same question `voted` and `yearCol` answer above:
    // whichever index the seek is already in carries it, so the filter is covered rather
    // than paid for with a reach into `title` per candidate row. `ix_lang_rank` covers it
    // for a language list and `ix_tg_votes`/`ix_tg_rank` for a genre; `title_lang` is named
    // FIRST because a language list is the more selective of the two seeks.
    where.push(langJoin ? "l.kind = ?" : genreJoin ? "g.kind = ?" : "t.kind = ?");
    args.push(f.kind);
    if (!langJoin && !genreJoin) touchesTitle = true;
  }

  /*
    The ORDER, and which table's copy of `rank` it reads.

    A genre browse joins `title_genre`, which carries its own `kind` and `rank` copied
    from `title` at build time, and `ix_tg_rank(genre, kind, rank desc)` covers all three.
    Ordering by `t.rank` instead would be the same numbers in the same sequence and a full
    sort to get there, which is the whole cost this layer was built to remove -- so the
    join decides which column is named, not taste.

    A LANGUAGE LIST joins `title_lang`, which carries the same three columns for the same
    reason, and it wins over the genre copy when both are present: `ix_lang_rank` is the more
    selective seek of the two, and only the table the query drives from can serve the order.
    All three columns hold the identical number -- they are one value copied at build time --
    so this decides the PLAN and never the answer.

    `rank is not null` is a MEMBERSHIP rule, not a filter: an unrated title has no rank, so
    it is not in the list. Without it `total` would count 1.2M unrated rows as members of
    "the top comedies" and paging far enough would eventually reach them.
  */
  const ranked = langJoin ? "l.rank" : genreJoin ? "g.rank" : "t.rank";
  let order = `${voted} desc`;
  /*
    PINNING THE RANK INDEX ON A DECADE, and it is the one place this file overrides the planner.

    A ranked list over a YEAR RANGE is the query SQLite gets wrong here, and it gets it wrong
    because of an index that is right for everything else. `ix_year(year, votes desc)` looks
    cheap for `year >= ? and year <= ?`, so the planner seeks it and then sorts every ranked
    title in the decade -- while `ix_rank(kind, rank desc)` would read rows in rank order and
    stop at `limit`. Measured on the deployment NAS, "Best of the 2010s" at 250 rows:

      planner's choice        469.01 ms   SEARCH ix_year + USE TEMP B-TREE FOR ORDER BY
      indexed by ix_rank        1.25 ms   SEARCH ix_rank (kind=? AND rank>?)
      no kind, free choice     459.20 ms
      no kind, ix_rank_all       0.80 ms

    It is not a cost model that can be tuned around: `analyze` has run, and the estimate is
    reasonable in isolation -- the range really does match few rows. What it cannot see is that
    walking a rank-ordered index reaches `limit` almost immediately. `INDEXED BY` states the
    thing the planner cannot infer, and it FAILS LOUDLY if the index is missing rather than
    silently going slow, which is why it is guarded on a capability rather than assumed.

    A GENRE decade is deliberately left alone: `ix_tg_rank` leads with `genre`, so the planner
    already picks it and measures 0.93 ms. Pinning it would be a second owner of a decision
    that is currently correct.

    Do NOT "fix" this instead by adding `(kind, year, rank desc)`. It was built and measured:
    the per-year ranked seek does drop to 0.48 ms, and the new index then STEALS the per-year
    VOTES query, which goes 0.10 ms -> 25.24 ms. Every index here is a global change; the
    benchmark re-explains every scenario for exactly this reason.
  */
  let indexedBy = "";
  // NOT pinned when either join is present: the pin names an index on `title`, and both
  // joined shapes exist precisely so the query drives from the other table instead.
  if (sort === "rank" && f.decade !== undefined && !genreJoin && !langJoin && rankIndexes) {
    indexedBy = f.kind ? " indexed by ix_rank" : " indexed by ix_rank_all";
  }
  if (sort === "rank") {
    where.push(`${ranked} is not null`);
    order = `${ranked} desc`;
    if (!genreJoin && !langJoin) touchesTitle = true;
  }

  /*
    THE LANGUAGE FILTER: a correlated EXISTS on the ROWID, and both halves of that were
    measured rather than reasoned about.

    **Why the rowid.** `title_lang` is keyed on `title_rowid` -- the same integer
    `title_genre` carries -- so this predicate names a column BOTH from-clauses already
    have. That is what leaves `touchesTitle` alone and keeps a genre count reading
    `title_genre` by itself: the 182ms -> 2.5ms covering count survives a language
    preference, which it would not if the language lived on `title` as a column.

    **Why EXISTS and not `in (select ...)`.** The `in` form shipped first and was 1,014 ms
    against 0.08 ms unfiltered, because the fail-open rule puts `UNKNOWN_LANG` on 81% of the
    corpus and the list subquery materialises every one of those rowids on every browse. The
    correlated form is one covering seek per candidate row into `ix_lang(title_rowid, lang)`
    and measures 0.07 ms. **The predicate and that index are one decision** -- see `INDEXES.origin`.

    EXISTS also happens to be the only form that is correct without care: a title with three
    languages has three rows, and a plain join would return it three times, which a `limit`
    then quietly turns into a short page.

    An EMPTY list is no filter at all rather than a filter matching nothing. That is the
    difference between "this reader has no preference" and "this reader wants no titles",
    and only the first is ever a thing anybody means.

    **`f.lang` REPLACES the preference rather than composing with it.** They are two answers
    to "which languages is this page about" and the reader's own is the specific one -- the
    same precedence `year` takes over `decade` above. Composing them would empty every
    language list on any deployment that had configured `languages`, which is a page of dead
    links rather than a stricter filter.
  */
  // WHICH TABLE'S ROWID, the same question `voted` and `ranked` answer above. A genre count
  // reads `title_genre` alone and has no `t` to name; naming one would be a `no such column`
  // on exactly the query the covering count exists to serve.
  const rowid = genreJoin ? "g.title_rowid" : "t.rowid_";
  const langIn = (codes: readonly string[]) =>
    `select 1 from title_lang l where l.title_rowid = ${rowid}` +
    ` and l.lang in (${codes.map(() => "?").join(",")})`;
  if (langJoin) {
    /*
      THE SAME MEMBERSHIP RULE, read off two stored columns instead of proved per row.

      `l.lang = ?` is the `exists` half and `l.non_english = 1` is the `not exists` half --
      the build already asked, once, whether each title carries an `en` row. The join itself
      cannot duplicate a title the way a plain join on `title_lang` would: `lang` is fixed to
      one value and the rows are `distinct (title_rowid, lang)`, so a trilingual film has
      exactly one matching row rather than three.

      `1` is a LITERAL rather than a bound parameter, so `explain query plan` shows the
      predicate as a constrained index column -- a bound one would still work, and would make
      the plan unreadable to the test that pins it.

      ENGLISH TAKES ONLY THE FIRST HALF, and it is the same rule rather than an exception:
      "in this language and not also in English" reads, for English, as "in English", so the
      `not exists` half is vacuous. The branch below writes exactly that on the `exists` path
      and has since the language filter shipped -- this is one membership rule spelled in two
      places, not two rules.
    */
    where.push("l.lang = ?");
    if (f.lang !== ENGLISH_LANG) where.push("l.non_english = 1");
    args.push(f.lang);
  } else if (f.lang !== undefined) {
    where.push(`exists (${langIn([f.lang])})`);
    args.push(f.lang);
    // A list of English films is not foreign to itself: `?lang=en` would otherwise be
    // "in English and not in English", an empty page with no way to read it as anything
    // but a bug. See `BrowseFilters.lang` for why the exclusion exists at all.
    if (f.lang !== ENGLISH_LANG) {
      where.push(`not exists (${langIn([ENGLISH_LANG])})`);
      args.push(ENGLISH_LANG);
    }
  } else if (languages.length > 0) {
    where.push(`exists (${langIn(languages)})`);
    args.push(...languages);
  }

  const join = [genreJoin, langJoin].filter(Boolean).join(" ");
  return {
    join,
    indexedBy,
    // The COUNT never pins: it has no ORDER BY to serve, so the planner's choice is right
    // there, and `browse_count` answers most of them without a query at all.
    countFrom: coveringCountTable(genreJoin, langJoin, touchesTitle) ?? `title t ${join}`,
    // A browse with no filters at all and no floor has nothing to put in a WHERE.
    where: where.length > 0 ? where.join(" and ") : "1",
    order,
    args,
  };
}

/**
 * The join a NAMED language takes when the file can serve it from `title_lang`, or `""`.
 *
 * ONE QUESTION DECIDES IT: is the language predicate SELECTIVE? Driving from `title_lang`
 * means reading its rows for that language and reaching into `title` for each one, which is
 * the right trade when the language narrows the corpus and the wrong one when it does not.
 *
 * - **No `lang` at all.** A deployment PREFERENCE is a list of codes covering 81% of the
 *   corpus (`UNKNOWN_LANG` is in it), so driving from `title_lang` would read most of the
 *   table -- the 1,014 ms shape `INDEXES.origin` documents at length. Declined outright.
 * - **A named foreign language.** One code matching a few thousand of 345,498 ranked films,
 *   and `non_english = 1` narrows it further. Taken for ANY filter set: that is the shape
 *   every `LIST_LANGUAGES` row ships on, measured at ~0.24 ms each.
 * - **`?lang=en`.** 58,500 ranked movies -- an order of magnitude more than any other single
 *   language, and with no `non_english` half to narrow it, because a title carrying an `en`
 *   row is not foreign including its own `en` row. So English takes the join only where
 *   `langIndexServesAlone` says the index answers the WHOLE query, order and count included.
 *
 * > [!IMPORTANT] English could not take the join AT ALL until `ix_lang_rank` was reordered
 * > It shipped as `(lang, kind, non_english, rank desc)`, which puts the sort column behind a
 * > column English does not constrain -- so the seek read two ranges and sorted them back
 * > together, and declining was right whatever the filters were. `INDEXES.origin` now spells
 * > it `(lang, kind, rank desc, non_english)` and the walk is ordered for both shapes.
 * >
 * > An index built before the reorder still answers correctly and pays that sort: 78 ms on
 * > `?lang=en&kind=movie&sort=rank` rather than 2 ms, against the 199 ms of the `exists` path
 * > it replaced. So this needs no capability of its own -- `langRank` already gates the join,
 * > the reorder only makes it faster, and `INDEX_STAGES.origin` rebuilds a stale file through
 * > the ordinary mechanism.
 */
function langListJoin(f: BrowseFilters, caps: LangCaps, sort: BrowseSort): string {
  if (!caps.langRank || f.lang === undefined) return "";
  if (f.lang === ENGLISH_LANG && !langIndexServesAlone(f, sort, caps)) return "";
  return "join title_lang l on l.title_rowid = t.rowid_";
}

/**
 * The three `title_lang` capabilities, together, because the two functions below need all of
 * them and reading one without the others is what a wrong answer would look like.
 *
 * `langRank` says the denormalised path exists at all; the other two say which ORDER and
 * which SLICE it can serve without leaving the index. They are one stage's output, so they
 * move together in practice -- separate flags because they answer separate queries, and
 * `INDEX_STAGES.origin` is the thing that keeps them in step.
 */
interface LangCaps {
  langRank: boolean;
  langYear: boolean;
  langVotes: boolean;
}

/**
 * Can `ix_lang_rank` answer this browse by itself -- the order AND the count?
 *
 * `title_lang` carries the columns a browse can name without leaving the index, so a filter
 * on anything ELSE forces `title` or `title_genre` back into the query: the rows take a
 * reach-through per candidate and, worse, `coveringCountTable` stops being able to count from
 * the index at all. Each of those is affordable once the language has already narrowed the
 * corpus to a few thousand rows, which is why only English asks this question -- see
 * `langListJoin`.
 *
 * Measured 2026-09-06 on a copy of the real 1,288,159-row index, M1 Max, English movies, with
 * the join FORCED on to price each clause: **200.2 ms against 16.2 with a genre, 79.2 against
 * 10.0 with a year, 156.2 against 29.0 on a votes sort.** The pure shape goes the other way by
 * two orders of magnitude, 195.8 ms to 1.8. So this is a measured boundary rather than
 * caution, and every filter set on the far side of it keeps exactly the query it had before.
 *
 * > [!IMPORTANT] A YEAR OR A DECADE MOVED TO THE NEAR SIDE on 2026-09-07, because the column
 * > that made it expensive is now here
 * > The 79.2 ms above was `t.year` dragging `title` back in. With `year` denormalised onto
 * > `title_lang` and carried by `ix_lang_rank` (see `ORIGIN_SCHEMA` and `INDEXES.origin`) the
 * > slice is a COVERED FILTER applied while walking the rank order, and the count is a
 * > covering scan of the same range. Measured on a copy of the real 1,276,669-title index,
 * > M1 Max, 2026-09-07, best of five warm through `SearchEngine.browse`:
 * > `?lang=en&kind=movie&decade=2010&sort=rank` **280.9 ms -> 3.2**, `decade=1990` **244.6 ->
 * > 3.1**, `year=1994` **9.5 -> 2.9**. So this asks `langYear` rather than refusing outright,
 * > and a file built before that column keeps exactly the query it had.
 *
 * > [!NOTE] A GENRE stays on the far side, and that is a decision rather than a gap -- 38.2 ms
 * > for `?lang=fr&genre=Horror&kind=movie&sort=rank`, 16.2 ms for the English one
 * > See `coveringCountTable`, which is where that number and its reason are written down.
 *
 * > [!IMPORTANT] A VOTES SORT moved with it, on the same day and for the same reason
 * > The 156.2 ms above was `title_lang` having no column that could serve that order, so the
 * > joined path sorted the language's whole set while the `exists` path walked the global
 * > votes order until the page filled -- the SELECTIVITY trap that made English and French
 * > want opposite things. `votes` denormalised here with `ix_lang_votes(lang, kind, votes
 * > desc, non_english)` removes the sort rather than choosing a side of it, so both ends
 * > improve: rows and count together, `?lang=fr&kind=movie&sort=votes` **18.8 ms -> 0.2**
 * > and `?lang=en&kind=movie&sort=votes` **28.1 -> 0.9**, same totals.
 *
 * A vote FLOOR is why the votes half needed the index and not just the column: `browseVoteFloor`
 * applies `BROWSE_VOTE_FLOOR` to an unsliced votes browse, and `votes >= ?` with `lang` and
 * `kind` already fixed is a prefix of that index's walk rather than a filter over a sort.
 * A ranked sort takes no floor at all, so the rank half never meets the question.
 */
function langIndexServesAlone(f: BrowseFilters, sort: BrowseSort, caps: LangCaps): boolean {
  if (sort === "votes" && !caps.langVotes) return false;
  if (f.genre !== undefined) return false;
  const slicedByYear = f.year !== undefined || f.decade !== undefined || f.years !== undefined;
  return slicedByYear ? caps.langYear : true;
}

/**
 * The ONE table a count can be answered from alone, or `undefined` when it needs the join.
 *
 * A count needs no column, so it can drop `title` whenever no predicate names one -- and the
 * join is droppable by CONSTRUCTION rather than by hope, for `title_lang` exactly as for
 * `title_genre`: every row of either is written from an existing `title` row keyed on an
 * INTEGER PRIMARY KEY, so the join can neither add a row nor remove one. SQLite cannot work
 * that out for itself, which is why it is decided here.
 *
 * > [!IMPORTANT] WITH BOTH JOINS PRESENT IT DECLINES, and that is where a language crossed
 * > with a GENRE stops -- 38.2 ms for `?lang=fr&genre=Horror&kind=movie&sort=rank` and 16.2 ms
 * > for the English one, measured on a copy of the real 1,276,669-title index, M1 Max,
 * > 2026-09-07, and 40.6 / 16.4 after the widening that fixed the year and votes shapes. This
 * > function is the one that declines them, so the number lives here.
 * >
 * > **It was ruled UNFIXED on 2026-09-07, deliberately, and the ruling named what it refused.**
 * > The card that moved the year, decade and votes shapes onto `title_lang` (see
 * > `langIndexServesAlone`) could not move the genre one, because the fix is not the same
 * > shape: a title has MANY genres, so a genre cannot be denormalised onto `title_lang` the
 * > way a year can -- it is a genuine cross product rather than a column. The two alternatives
 * > were priced and refused. A LANGUAGE DIMENSION ON `browse_count` multiplies a stored
 * > aggregate by the number of languages and changes a table every browse in the product
 * > reads; a THIRD EXPLODED TABLE crossing language and genre is the second owner of how these
 * > tables key together that the paragraph below already warns against.
 * >
 * > So an honest 38 ms with an owner beat a fourth structure nobody can maintain. If it is
 * > ever picked up it starts here, with this number.
 *
 * Re-hanging `title_genre` off `title_lang`'s rowid would be correct too, and would be that
 * second place that knows how these tables key together -- for a case that is one language
 * list crossed with one genre, which nothing links to.
 */
function coveringCountTable(genreJoin: string, langJoin: string, touchesTitle: boolean): string | undefined {
  if (touchesTitle || (genreJoin && langJoin)) return undefined;
  if (langJoin) return "title_lang l";
  if (genreJoin) return "title_genre g";
  return undefined;
}

/**
 * The total, from `browse_count` when that table can answer and from a live count otherwise.
 *
 * > [!IMPORTANT] Once the rows became seeks, the COUNT was the whole cost of a browse
 * > Measured on the real 2.18 GB index with the rank indexes in place: a genre+decade browse
 * > spent 137.48 ms counting and 0.32 ms fetching its forty rows; an unfiltered ranked count
 * > was 11.16 ms and a genre+kind ranked count 10.69 ms. A count has to visit every matching
 * > row by definition, so unlike an ordered read it cannot be turned into a seek -- the only
 * > way to stop paying it while a reader waits is to have paid it at build time.
 * >
 * > From `browse_count` those become 0.34 ms, 0.50 ms and 0.02 ms.
 *
 * **It answers only what it can answer EXACTLY.** `countFromTable` returns null for any
 * filter set the grain does not express -- a custom `minVotes` the table was not built at,
 * or an index built before the stage existed -- and the live count runs instead. A total is
 * printed to the reader as a fact ("1,132 titles"), so a close-enough answer is not an
 * available trade: it is either the same number the live query would give or it is not used.
 * `browse-count.test.ts` asserts that equality across a matrix rather than asserting any
 * particular number.
 */
function browseTotal(
  db: Database,
  sql: ReturnType<typeof browseSql>,
  opts: BrowseOptions,
  minVotes: number,
  sort: BrowseSort,
  hasBrowseCounts: boolean,
  filtered = false,
): number {
  // A LANGUAGE FILTER PUTS THE STORED COUNT OUT OF REACH, and it has to say so here rather
  // than in `countFromTable`. The grain is (kind, genre, year) and carries no language, so
  // every stored number answers the unfiltered question -- which is not close enough, it
  // is a different question, and this total is printed to the reader as a fact. The live
  // count runs instead and is the one thing that can be right.
  if (hasBrowseCounts && !filtered) {
    const stored = countFromTable(db, opts, minVotes, sort);
    if (stored !== null) return stored;
  }
  return (
    db.query(`select count(*) c from ${sql.countFrom} where ${sql.where}`).get(...(sql.args as never[])) as {
      c: number;
    }
  ).c;
}

/**
 * One `sum()` over the precomputed grain, or null when the grain cannot express the question.
 *
 * The three columns are the three populations the UI asks about and there is deliberately no
 * fourth: a `minVotes` other than 0 or `BROWSE_VOTE_FLOOR` reaches the live count, because
 * storing an arbitrary threshold would mean storing a histogram rather than a count. Today
 * the only caller that passes a custom floor is the "show all" escape hatch, which passes 0.
 */
function countFromTable(
  db: Database,
  opts: BrowseOptions,
  minVotes: number,
  sort: BrowseSort,
): number | null {
  // A ranked list counts ranked rows and ignores the floor entirely -- `browseVoteFloor`
  // already returns 0 for it, and membership is `rank is not null`.
  const column =
    sort === "rank" ? "n_ranked" : minVotes === 0 ? "n" : minVotes === BROWSE_VOTE_FLOOR ? "n_floor" : null;
  if (column === null) return null;

  const where: string[] = [];
  const args: unknown[] = [];
  // `''` is the ANY-GENRE grain, written by a second pass over `title` alone. Summing the
  // real genre rows instead would count a three-genre title three times.
  where.push("genre = ?");
  args.push(opts.genre ?? "");
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts.year !== undefined) {
    where.push("year = ?");
    args.push(opts.year);
  } else if (opts.years) {
    // The grain is per-year, so an arbitrary range sums exactly like a decade does. It is
    // spelled before `decade` for the same precedence `browseSql` applies.
    where.push("year >= ? and year <= ?");
    args.push(opts.years[0], opts.years[1]);
  } else if (opts.decade !== undefined) {
    where.push("year >= ? and year <= ?");
    args.push(opts.decade, opts.decade + 9);
  }
  const row = db
    .query(`select coalesce(sum(${column}), 0) c from browse_count where ${where.join(" and ")}`)
    .get(...(args as never[])) as { c: number };
  return row.c;
}

/** The ten years a decade filter covers. */
const DECADE_YEARS = 10;

/**
 * Is this browse one the per-year split actually helps?
 *
 * > [!IMPORTANT] Only a VOTES sort. A ranked decade is made WORSE by splitting, and that was measured
 * > The split shipped for both sorts and it was a regression on the ranked one. `/lists`
 * > draws seven "Best of the <decade>s" lists at 250 rows each, and on the deployment NAS
 * > they cost **1,233 ms of members** -- `decade-2010` alone was 372 ms -- against a
 * > docstring in `src/server/lists.ts` claiming 36 ms for the whole payload.
 * >
 * > The reason is that the two sorts want opposite things. A votes decade has no index that
 * > can order across a year RANGE, so ten pinned-year seeks beat it (161 ms -> 0.92 ms). A
 * > RANK decade already has one -- `ix_rank(kind, rank desc)` reads rows in the output order
 * > and stops at `limit` -- so splitting it throws away that ordering and pays ten sorts
 * > instead of one walk (0.48 ms per year x10 against 1.25 ms for the whole decade).
 * >
 * > What the ranked path needs is not a split but a PIN, because the planner picks `ix_year`
 * > and sorts. See `indexedBy` in `browseSql`.
 */
function splitsByYear(opts: BrowseOptions, sort: BrowseSort): boolean {
  return yearSpan(opts) !== null && sort === "votes";
}

/**
 * The inclusive `[from, to]` a browse's year RANGE covers, or null when it pins no range.
 *
 * One owner for "is this a range and which years" because two callers need the identical
 * answer -- `splitsByYear` decides whether to split and `decadeRows` decides what to split
 * INTO, and a disagreement between them is an off-by-one page nobody would see in a test.
 *
 * A `years` range is capped at the width of the split, and the cap is the honest part: the
 * split fires one query per year and merges `limit + offset` rows from each, so a caller
 * asking for 1900-2026 would run 127 queries to draw forty rows. Past the cap the range
 * scan is the cheaper wrong answer, and it is still correct -- just sorted rather than
 * seeked. Fifteen years, which is the span that started this, sits comfortably inside it.
 */
function yearSpan(opts: BrowseOptions): [number, number] | null {
  if (opts.year !== undefined) return null;
  if (opts.years) {
    const [from, to] = opts.years;
    return to >= from && to - from < MAX_SPLIT_YEARS ? [from, to] : null;
  }
  return opts.decade !== undefined ? [opts.decade, opts.decade + DECADE_YEARS - 1] : null;
}

/** How wide a year range may be before the per-year split stops being worth its queries. */
const MAX_SPLIT_YEARS = 30;

/**
 * A decade page, served as TEN single-year seeks merged in memory.
 *
 * > [!IMPORTANT] An index cannot fix this, and one was built and measured before this was written
 * > `where year >= ? and year <= ? order by votes desc` puts a RANGE on the leading column,
 * > so the second column is not globally ordered across the range and no `(year, votes desc)`
 * > index can serve the sort. **SQLite is right to refuse it**: `ix_year_votes` was added and
 * > `decade=2010` did not move -- 161.11 ms before, 164.61 ms after, identical plan, still
 * > `SEARCH ix_year (year>? AND year<?) | USE TEMP B-TREE FOR ORDER BY` over 89,694 rows.
 * >
 * > Pinning ONE year makes the same index a pure seek, and ten seeks plus a merge of a few
 * > hundred rows is not close: **decade=2010 goes 161 ms -> 0.92 ms**, 1990 -> 0.43 ms,
 * > 2020 -> 1.31 ms, measured on the real 2.18 GB index.
 * >
 * > So the index and this split are ONE change and neither works without the other. Deleting
 * > `ix_year_votes` leaves ten sorted scans; deleting this leaves the index unused.
 *
 * This is the same shape `rankedSeek` uses for `kind`, and for the same underlying reason:
 * when an index can only be read in order once a leading column is FIXED, fix it and merge.
 *
 * It reuses `browseSql` with `year` substituted for `decade` rather than writing its own
 * WHERE, so a genre, a kind or a vote floor on a decade browse keeps working with no second
 * copy of the membership rules to drift.
 */
function decadeRows<T extends { tconst: string }>(
  db: Database,
  opts: BrowseOptions,
  minVotes: number,
  sort: BrowseSort,
  select: string,
  limit: number,
  offset: number,
): T[] {
  const [from, to] = yearSpan(opts) as [number, number];
  const merged: (T & { _sort: number | null })[] = [];
  for (let year = from; year <= to; year++) {
    // Both range forms cleared and `year` set: one seek per year, every other filter intact.
    const per = browseSql({ ...opts, decade: undefined, years: undefined, year }, minVotes, sort, {
      ...capsOf(opts),
      languages: opts.languages ?? [],
    });
    // The order EXPRESSION is aliased and selected rather than re-derived here, so `votes`
    // and `rank` are merged by whichever column `browseSql` actually ordered on. Naming a
    // column would be a second owner of the sort and would silently mis-merge a ranked page.
    const key = per.order.replace(/\s+desc$/i, "");
    merged.push(
      ...(db
        .query(
          `select ${select}, ${key} as _sort from title t${per.indexedBy} ${per.join} where ${per.where}
           order by ${per.order} limit ?`,
        )
        // Each year must offer the whole page, because the merge cannot know in advance
        // which year the top rows come from -- one year could supply all forty.
        .all(...([...per.args, limit + offset] as never[])) as (T & { _sort: number | null })[]),
    );
  }
  /*
    `tconst` breaks a tie, and that is a deliberate improvement rather than a copy.

    The range query this replaces had no tiebreak at all, so rows with equal votes came back
    in whatever order the scan happened to reach them -- stable only by accident, and a
    page-2 request could legitimately repeat or skip a title. Ordering the merge on a unique
    column makes the sequence total, which is what the standing rule asks for: an order that
    reshuffles between pages is worse than one that is merely imperfect.
  */
  merged.sort(
    (a, b) => (b._sort ?? 0) - (a._sort ?? 0) || (a.tconst < b.tconst ? -1 : a.tconst > b.tconst ? 1 : 0),
  );
  // `_sort` is an internal key, not a fact about the title -- the same reason `rankedSeek`
  // strips `rank_` rather than returning it.
  return merged.slice(offset, offset + limit).map(({ _sort: _drop, ...row }) => row as unknown as T);
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
  const langs = opts.languages ?? [];
  const sql = browseSql(opts, minVotes, sort, { ...capsOf(opts), languages: langs });
  const counts = opts.browseCounts ?? false;
  /*
    A LANGUAGE PREDICATE OF EITHER KIND PUTS THE STORED COUNT OUT OF REACH, so this asks
    whether one was applied at all rather than whether a preference was passed. `browse_count`
    has grain (kind, genre, year) and no language dimension -- see `browseTotal`.
  */
  const filteredByLanguage = opts.lang !== undefined || langs.length > 0;
  const total = browseTotal(db, sql, opts, minVotes, sort, counts, filteredByLanguage);
  const cols = titleCols(opts.titleLang ?? false, "t.");
  const limit = opts.limit ?? 60;
  const offset = opts.offset ?? 0;
  // The COUNT is left on the range: it is a covering seek either way (1.59ms measured) and
  // has no ORDER BY to serve, so it is only the ROW fetch that the range hurts.
  const rows = splitsByYear(opts, sort)
    ? decadeRows<TitleRow>(db, opts, minVotes, sort, cols, limit, offset)
    : (db
        .query(
          `select ${cols} from title t${sql.indexedBy} ${sql.join} where ${sql.where}
           order by ${sql.order} limit ? offset ?`,
        )
        .all(...([...sql.args, limit, offset] as never[])) as TitleRow[]);

  /*
    WHICH of our own thresholds emptied this page, asked in the order they were applied.

    The language preference is checked FIRST because it is the outer one: with a filter in
    force, the count without the vote floor is still a count of one language, so offering
    "show all 1,132" from there would name a number the reader cannot actually reach. Only
    one hatch is ever offered, and it is the one whose removal would actually help.

    Same guard as the floor's: a page that found rows pays for one count, never two.

    **`opts.lang` OFFERS NO HATCH, and that is the point of asking here.** The hatch lifts a
    threshold of OURS that the reader never chose. A language they navigated to is what the
    page IS, so "show all 1,132 in any language" under the heading "Best films in Korean"
    would answer a different question -- the same reason a ranked browse never offers to lift
    a floor it did not apply.
  */
  if (total > 0) return { rows, total };
  if (opts.lang === undefined && langs.length > 0) {
    const unfiltered = browseTotal(
      db,
      browseSql(opts, minVotes, sort, capsOf(opts)),
      opts,
      minVotes,
      sort,
      counts,
      false,
    );
    if (unfiltered > total) {
      return {
        rows,
        total,
        // `UNKNOWN_LANG` is stripped HERE rather than by each reader. It is a storage
        // device that keeps the filter to one predicate, not a language, and printing
        // "English, Swedish or unknown" would name a thing no reader chose.
        hiddenByLanguage: { titles: unfiltered - total, languages: langs.filter(Boolean) },
      };
    }
  }
  // A rank browse takes no floor, so it never reaches here and never offers a hatch it
  // has nothing behind: an empty ranked list is empty because nothing is ranked.
  if (minVotes === 0) return { rows, total };
  const unfloored = browseTotal(
    db,
    browseSql(opts, 0, sort, { ...capsOf(opts), languages: langs }),
    opts,
    0,
    sort,
    counts,
    filteredByLanguage,
  );
  return unfloored > 0 ? { rows, total, hiddenByFloor: { titles: unfloored, minVotes } } : { rows, total };
}

/**
 * The ids of one browse page, and not one column more.
 *
 * Shares `browseSql` with `browseIndex` so the membership of "the top 250 horror films" is
 * decided in exactly one place -- a second WHERE clause here would be a second answer to
 * "what is in this list", and the completion count would eventually disagree with the grid
 * it is printed above.
 *
 * It runs NO count. That is the whole reason it is a separate function rather than
 * `browseIndex(...).rows.map(...)`: `/lists` asks for the head of twenty-six lists at once,
 * and `browseTotal` over an unfiltered `rank is not null` is a scan of the whole index --
 * paid twenty-six times for a number no caller here wants.
 */
export function browseMembers(db: Database, opts: BrowseOptions): string[] {
  const sort = opts.sort ?? "votes";
  const minVotes = opts.minVotes ?? browseVoteFloor(opts, sort);
  const sql = browseSql(opts, minVotes, sort, { ...capsOf(opts), languages: opts.languages ?? [] });
  const limit = opts.limit ?? 60;
  const offset = opts.offset ?? 0;
  // Splits a decade the same way `browseIndex` does -- "best comedies of the 2020s" is a
  // computed list, so this path pays the range scan too if it is left out.
  const rows = splitsByYear(opts, sort)
    ? decadeRows<{ tconst: string }>(db, opts, minVotes, sort, "t.tconst", limit, offset)
    : (db
        .query(
          `select t.tconst from title t${sql.indexedBy} ${sql.join} where ${sql.where}
           order by ${sql.order} limit ? offset ?`,
        )
        .all(...([...sql.args, limit, offset] as never[])) as { tconst: string }[]);
  return rows.map((r) => r.tconst);
}

/** One episode of one series, as the index holds it. */
export interface EpisodeRow {
  /** The EPISODE's own IMDb id, not the series'. */
  tconst: string;
  /** The series tconst this episode belongs to. */
  parent: string;
  season: number;
  number: number;
  /** Null when title.basics had no row for this episode -- the dumps can disagree. */
  title: string | null;
  /**
   * The episode's own IMDb rating, or **null when nobody has rated it yet**.
   *
   * NEVER 0 for an unrated episode, and a caller must not coerce it to one. 0.0 is a
   * well-formed score meaning "rated terribly", and that is a different answer from "we do
   * not know" -- which is the majority answer here: over half the episodes this index holds
   * carry no ratings row at all (the census is on `index.episodeSeriesMinVotes`).
   */
  rating: number | null;
  votes: number;
  /** The year the episode aired, from title.basics. */
  year: number | null;
}

export interface EpisodeQuery {
  /** One season only. Omitted means the whole run, specials included. */
  season?: number;
  /** Excludes UNRATED episodes as well as low-rated ones -- see `queryEpisodes`. */
  minRating?: number;
  minVotes?: number;
  /** Defaults to `EPISODE_PAGE`. */
  limit?: number;
}

/**
 * How many episodes one call returns when the caller does not say.
 *
 * 200 covers the complete run of nearly every scripted series -- the long soaps are the
 * exception and they are not what anybody asks this question about. It is a page rather
 * than a cap: a caller that wants more says so.
 */
export const EPISODE_PAGE = 200;

/**
 * Episodes of one series, in running order.
 *
 * Takes the database rather than reaching for one, the same shape as `browseIndex`, so the
 * filter semantics can be exercised against a handful of rows in a temp file instead of
 * against a real index.
 *
 * **`minRating` excludes an UNRATED episode and that is deliberate, not a side effect of
 * SQL.** `rating >= 8.0` is NULL for a null rating, and NULL is not true, so an episode
 * nobody has scored falls out of "every episode over 8.0" -- which is the only honest
 * answer, because we do not know that it is over 8.0. Spelling `or rating is null` in here
 * would answer a question nobody asked. The unrated episodes are still returned by a query
 * that does not pin a rating, carrying `rating: null`, so a pane can say "no score yet"
 * rather than pretending they do not exist.
 *
 * `ix_ep_parent` covers the SEEK and every column read, so the table's own pages are never
 * touched -- but the ORDER is `season = 0, season, number`, and that leading expression is
 * not a column any index can carry, so **this does sort**. An earlier version of this comment
 * claimed "a seek and never a sort", which was wrong: `explain query plan` reports
 * `USE TEMP B-TREE FOR ORDER BY` on every shape of this query.
 *
 * It is left that way ON PURPOSE. Measured, the sort costs 0.03-1.5 ms depending on how many
 * episodes the series has -- 0.071 ms against 0.042 ms for an index-served order on Breaking
 * Bad. Season 0 sorting last is a product rule (see below, and `orderSeasons`), and a
 * millisecond is the right price for keeping it.
 */
/**
 * > [!IMPORTANT] SEASON 0 SORTS LAST, AND THE LIMIT IS WHY IT MATTERS
 * > Season 0 is the specials, every series has one, and it can be enormous -- Rick and
 * > Morty's holds 187 entries, more than all its real seasons together. Ordered naively by
 * > season number it comes FIRST, so a caller taking the first 200 rows gets 187
 * > behind-the-scenes clips and 13 episodes, and an agent asked for the best episodes
 * > answers from bloopers.
 * >
 * > `order by season = 0` is the whole fix: SQLite sorts the boolean 0 before 1, so every
 * > real season leads and the specials trail. This is the same rule `orderSeasons()` in
 * > `web/src/lib/facet-panes.ts` already applies to the season selector -- the ordering of
 * > seasons has one answer in this product and this is it, in SQL.
 */
export function queryEpisodes(db: Database, parent: string, opts: EpisodeQuery = {}): EpisodeRow[] {
  const where = ["parent = ?"];
  const args: unknown[] = [parent];
  if (opts.season !== undefined) {
    where.push("season = ?");
    args.push(opts.season);
  }
  if (opts.minRating !== undefined) {
    where.push("rating >= ?");
    args.push(opts.minRating);
  }
  // `votes >= 0` is true for every row -- the column is `not null default 0` -- so
  // spelling it out would only stop SQLite covering the seek. Same reason `browseSql`
  // omits its own zero floor.
  if (opts.minVotes !== undefined && opts.minVotes > 0) {
    where.push("votes >= ?");
    args.push(opts.minVotes);
  }
  return db
    .query(
      `select tconst, parent, season, number, title, rating, votes, year from episode
       where ${where.join(" and ")} order by season = 0, season, number limit ?`,
    )
    .all(...([...args, Math.max(1, opts.limit ?? EPISODE_PAGE)] as never[])) as EpisodeRow[];
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
