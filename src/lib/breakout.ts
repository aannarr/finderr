/**
 * BREAKOUT: a title whose reach massively exceeds what its own locale predicts.
 *
 * The front page can already say what is popular, what is highly rated and what is new. It
 * cannot say *"this was enormous where it was made and nobody here has heard of it"*, and
 * that question has no answer anywhere in `title` -- a global sort by votes or by rank is
 * the very thing that buries these titles, because they lose to English-language releases
 * on absolute numbers every time.
 *
 * ## The one rule the whole file follows: never compare across populations
 *
 * `.claude/docs/2026-09-05-rank-experiments.md` established that this index cannot separate
 * "their voters are generous" from "only their good films clear our vote floor" -- the two
 * produce identical observations. So a language or country CORRECTION is not available, and
 * `applyRank` stays locale-blind.
 *
 * The way out is to never ask the question. Every score here is computed WITHIN one locale
 * stratum and compared only against titles in that same stratum, so "are French ratings
 * inflated" has no bearing on any number this file produces. Gaumont is measured against
 * French cinema, Bong Joon-ho against Korean cinema. The regional effect is not corrected
 * for; it is stratified away.
 *
 * ## Two axes, and they measure different things
 *
 * `reach` is how far a title travelled compared with its locale's median, in log10 votes.
 * `love` is how much better it was rated than its locale's peers. They are NOT the same
 * question and must not be collapsed into one score:
 *
 * Measured against the real index on 2026-09-07, four titles aannarr named as reference
 * points split cleanly down the middle -- `Lupin` (reach 8.0, love 0.5) and `Squid Game`
 * (5.2, 0.5) against `Dark` (5.9, 2.5) and `Parasite` (6.6, 3.0). The first two are Netflix
 * originals whose reach is a marketing budget; the second two earned theirs. **A shelf built
 * on `reach` alone is a list of what Netflix promoted**, which is a thing the front page can
 * already tell you.
 *
 * ## Why median and MAD rather than mean and standard deviation
 *
 * One `Amelie` in a stratum of French films widens a standard deviation enough to hide every
 * other outlier in it -- the yardstick is bent by the thing being measured. The median and
 * the median absolute deviation are unmoved by a handful of extremes, which is the whole
 * reason they are here.
 *
 * ## R2 IS LOW, AND THAT IS WHY THE CUTOFFS ARE PERCENTILES
 *
 * Measured on the real index, 2026-09-07, M1 Max: locale membership explains **11.9% of the
 * variance in log10(votes)** and 8.2% of the variance in rating. The other ~88% is budget,
 * genre, stars and luck. So an individual `reach` value is NOISY and this module is honest
 * about what that permits: these scores are fit for picking out the extreme tail and unfit
 * for ordering the corpus. Nothing here should ever become a general sort.
 *
 * That is also why `breakoutCutoff` exists rather than a constant. An absolute `reach >= 3`
 * was in the exploration and it was a bug: changing the stratum changed the denominator, the
 * threshold silently became a different filter, and the candidate shelf fell from 25 titles
 * to 1 with nothing failing. A percentile survives a change of stratum; a magic number does
 * not.
 *
 * NOTHING HERE TOUCHES A DATABASE. Pure functions over rows somebody else read, so the
 * policy tests against a handful of fixtures rather than against a 1.27M-row index -- the
 * same split `browseIndex` makes for the same reason.
 */

/** A title, with everything the score needs and nothing else. */
export interface BreakoutRow {
  /** `title.rowid_`, the integer every other exploded table keys on. */
  rowid: number;
  year: number;
  kind: string;
  votes: number;
  rating: number;
  /** `title.country`, comma-joined and sorted, exactly as the column stores it. */
  country: string;
  /** Known languages only. `UNKNOWN_LANG` must be stripped before it reaches here. */
  langs: readonly string[];
}

/** What one title scored, and the locales it was judged against. */
export interface BreakoutScore {
  rowid: number;
  reach: number;
  love: number;
  /**
   * Whether this counts as breaking out of somewhere at all.
   *
   * See `isLocalMarket`. Stored rather than derived at read time so the shelf query is a
   * plain indexed filter instead of a string test over a comma-joined column.
   */
  local: boolean;
}

/**
 * How many titles a stratum needs before its median means anything.
 *
 * THIRTY, and the number is doing real work rather than being a round guess: Swedish 1990s
 * series clearing the vote floor is **thirteen** titles, so `Beck` -- a Swedish institution
 * and exactly the sort of title this shelf exists to find -- was scored against nothing and
 * dropped entirely. That is what `LOCALE_LADDER` below exists to rescue.
 */
export const MIN_STRATUM = 30;

/**
 * The vote count at which a rating is believed.
 *
 * A rating is an estimate and its error bar shrinks with the sample, so `love` is multiplied
 * by `votes / (votes + K)`. Without it the top of every "adored locally" list was a Swedish
 * schools programme rated 9.6 by 1,149 people. Same shrink-toward-the-prior device as
 * `applyRank`'s `C`, at a scale suited to a within-locale comparison rather than a global one.
 */
export const LOVE_CONFIDENCE_VOTES = 5000;

/**
 * Markets whose presence means a title is not breaking out of anywhere.
 *
 * A US or UK production credit is what a global release looks like, so scoring such a title
 * against a small-country stratum reads its budget as a breakout. Measured: keying on
 * country put **Dune: Part One** (`CA,HU,NO,US`), **Mission: Impossible - Fallout**
 * (`CN,FR,NO,US`) and **The LEGO Movie** (`AU,DK,US`) at the top of a Nordic list, on the
 * strength of a minority financing credit.
 *
 * A closed set of two, deliberately, and not a general "big market" list: these are the two
 * whose absence actually means a title had to travel to be seen here. Widening it is a
 * product decision, not a tidy-up.
 */
export const MAJOR_MARKETS: ReadonlySet<string> = new Set(["US", "GB"]);

/** Films and series are different populations; a decade is where tastes and vote counts sit. */
function family(kind: string): string {
  return kind === "movie" || kind === "tvMovie" ? "film" : "series";
}

function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * The locales a title belongs to: its LANGUAGES if we know any, otherwise its COUNTRIES.
 *
 * > [!IMPORTANT] Both, in this order, and the hybrid beats either axis alone. Measured, not assumed.
 * > A/B on the real index, 2026-09-07, over the 65,142 titles clearing the browse floor,
 * > scoring how much of the variance in log10(votes) stratum membership explains:
 * >
 * > | axis | coverage | R2(votes) | R2(rating) |
 * > |---|---|---|---|
 * > | language only | 85.8% | 0.100 | 0.086 |
 * > | country only | 93.6% | 0.088 | 0.076 |
 * > | **language, country fallback** | **93.7%** | **0.119** | 0.082 |
 * >
 * > It is not a trade. Language is the sharper signal where it exists -- French-LANGUAGE
 * > films are a tighter population than films carrying a French production credit, which
 * > includes a large slice of international arthouse -- and country reaches the 9,043
 * > floor-clearing titles that carry no language at all. Taking each where it is best wins
 * > on both columns at once.
 *
 * A title in several locales is scored against every one of them and the results are
 * MEDIANED (see `scoreBreakout`), because `title.country` is stored sorted and there is
 * therefore no primary production country to read.
 */
export function localeKeys(row: BreakoutRow): string[] {
  const langs = row.langs.filter((l) => l !== "");
  if (langs.length > 0) return langs.map((l) => `l:${l}`);
  return row.country
    .split(",")
    .filter(Boolean)
    .map((c) => `c:${c}`);
}

/**
 * The strata one locale offers, most specific first.
 *
 * A title takes the first rung that has `MIN_STRATUM` members, so a locale too thin to
 * support a decade-and-kind comparison still gets a decade one, and failing that a whole-
 * locale one. Without the ladder a small country's titles are simply unscored, which is
 * silent and looks exactly like "nothing there broke out".
 */
export function localeLadder(key: string, row: BreakoutRow): string[] {
  return [`${key}|${decadeOf(row.year)}|${family(row.kind)}`, `${key}|${decadeOf(row.year)}`, key];
}

/**
 * Is this title from somewhere, rather than from everywhere?
 *
 * A title with no country at all is NOT local: we cannot say it broke out of anywhere, and
 * guessing would put every uncatalogued title on the shelf.
 */
export function isLocalMarket(row: BreakoutRow): boolean {
  const cs = row.country.split(",").filter(Boolean);
  return cs.length > 0 && !cs.some((c) => MAJOR_MARKETS.has(c));
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Median absolute deviation, scaled so it is comparable with a standard deviation.
 *
 * 1.4826 is the constant that makes MAD equal sigma for normally distributed data, so a
 * "reach of 3" means roughly what three standard deviations would mean if the tail were
 * well behaved. It is not, which is precisely why MAD is used to measure it.
 *
 * Returns a floor rather than zero: a stratum where most titles share one rating would
 * otherwise divide by zero and score every member as infinitely loved.
 */
function mad(xs: readonly number[], centre: number): number {
  return median(xs.map((x) => Math.abs(x - centre))) * 1.4826 || 1e-9;
}

interface Stratum {
  logVotes: number;
  logVotesSpread: number;
  rating: number;
  ratingSpread: number;
}

/**
 * Score every title that lands in a stratum big enough to judge it.
 *
 * A title with no usable stratum gets NO ROW rather than a zero, and the two are genuinely
 * different: zero means "exactly typical for its locale", absent means "we cannot say". The
 * table is sparse for the same reason -- only ~1.4% of the corpus is scoreable, so a column
 * on `title` would be 1.27M mostly-null floats to store 18k facts.
 */
export function scoreBreakout(rows: readonly BreakoutRow[]): BreakoutScore[] {
  const members = new Map<string, BreakoutRow[]>();
  for (const row of rows) {
    for (const key of localeKeys(row)) {
      for (const rung of localeLadder(key, row)) {
        const bucket = members.get(rung);
        if (bucket) bucket.push(row);
        else members.set(rung, [row]);
      }
    }
  }

  const strata = new Map<string, Stratum>();
  for (const [rung, bucket] of members) {
    if (bucket.length < MIN_STRATUM) continue;
    const lv = bucket.map((r) => Math.log10(r.votes));
    const rt = bucket.map((r) => r.rating);
    const mv = median(lv);
    const mr = median(rt);
    strata.set(rung, {
      logVotes: mv,
      logVotesSpread: mad(lv, mv),
      rating: mr,
      ratingSpread: mad(rt, mr),
    });
  }

  const out: BreakoutScore[] = [];
  for (const row of rows) {
    const hits: Stratum[] = [];
    for (const key of localeKeys(row)) {
      const rung = localeLadder(key, row).find((r) => strata.has(r));
      if (rung) hits.push(strata.get(rung)!);
    }
    if (hits.length === 0) continue;
    // Vote-shrunk, so a 9.6 from a thousand people does not outrank an 8.5 from a million.
    const confidence = row.votes / (row.votes + LOVE_CONFIDENCE_VOTES);
    out.push({
      rowid: row.rowid,
      reach: median(hits.map((s) => (Math.log10(row.votes) - s.logVotes) / s.logVotesSpread)),
      love: median(hits.map((s) => ((row.rating - s.rating) / s.ratingSpread) * confidence)),
      local: isLocalMarket(row),
    });
  }
  return out;
}

/**
 * The value at a given percentile of a scored population.
 *
 * THE SHELF'S THRESHOLDS COME FROM HERE AND NEVER FROM A LITERAL. An absolute cutoff is a
 * statement about a distribution, so it stops being true the moment the distribution moves
 * -- and it fails silently, because a filter that now matches almost nothing looks exactly
 * like a corpus that contains almost nothing.
 *
 * An empty population has no percentile, so it returns `Infinity`: a threshold nothing can
 * clear, which yields an empty shelf rather than one built from a made-up number.
 */
export function breakoutCutoff(values: readonly number[], percentile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * percentile))];
}

/**
 * What the shelf asks for, and every number is here rather than in the SQL.
 *
 * The two percentiles are computed AT BUILD TIME over the local-market population and stored
 * in `meta`, so the query is a plain indexed filter against a constant that was a percentile
 * when it was written. That is the whole trick: the honesty of a percentile, the cost of a
 * literal, and it re-derives itself on every build instead of ageing in a source file.
 */
export const BREAKOUT_SHELF = {
  /** Reach above the 92nd percentile: the extreme tail, which is all a noisy score can carry. */
  reachPercentile: 0.92,
  /** Love above the 85th: better than its locale's peers, without demanding a masterpiece. */
  lovePercentile: 0.85,
  /**
   * Titles inside the all-time rank head are EXCLUDED, and this is what makes it a new shelf.
   *
   * Measured 2026-09-07 on the real index: of the top 30 by `love` over the last 20 years,
   * **18 were already in the all-time rank top 500** -- so without this the row is the
   * existing Top 250 redrawn, and the reader learns nothing they could not already see.
   */
  rankHead: 2500,
  /**
   * The vote window, and it is the single most important line in this object.
   *
   * Above the ceiling the shelf re-lists famous films (Parasite, Spirited Away) that every
   * other list already carries. Below the floor a locale median is being computed against
   * titles nobody voted on. The MIDDLE is where this score knows something no global sort
   * does: big at home, invisible everywhere else.
   */
  minVotes: 10_000,
  maxVotes: 150_000,
  /** Roughly "this century's second half" -- recent enough to be requestable. */
  fromYear: 2006,
} as const;

/** `meta` keys for the cutoffs, so the writer and the reader cannot spell them apart. */
export const BREAKOUT_META = {
  reach: "breakout_reach_cutoff",
  love: "breakout_love_cutoff",
  rankHead: "breakout_rank_head_cutoff",
} as const;

/**
 * A rank score so high nothing can reach it, for a corpus with no head to speak of.
 *
 * > [!CAUTION] It is `Number.MAX_VALUE` and NOT `Infinity`, and the difference is silent
 * > `meta` holds text, and SQLite's `cast('Infinity' as real)` is **0** -- not an error, not
 * > null, zero. So the "exclude nothing" sentinel would become "exclude everything with a
 * > non-negative rank", which is the whole shelf, with nothing logged. Measured 2026-09-07:
 * > `cast('Infinity' as real)` returns 0 and `7.5 >= 0` is true, where
 * > `cast('1.7976931348623157e+308' as real)` round-trips exactly and `7.5 >=` it is false.
 * > (`1e400` casts to NULL, which fails closed instead -- also wrong, differently.)
 */
export const NO_RANK_HEAD = Number.MAX_VALUE;

/**
 * The rank score at the edge of the all-time head, or `NO_RANK_HEAD` if there is no head.
 *
 * Excluding "the top N by rank" cannot be written as a `not in (... limit N)` subquery: on a
 * corpus SMALLER than N every title is in the top N, so the shelf is empty and the reason is
 * invisible. A fixture caught exactly that. Turning the position into a THRESHOLD at build
 * time fixes it in both directions -- a small index has no head to exclude, and the query
 * stops paying for a 2,500-row subquery per candidate.
 *
 * `ranks` must be sorted DESCENDING, which is the order the caller's `order by rank desc`
 * already produces.
 */
export function rankHeadCutoff(ranksDesc: readonly number[], headSize: number): number {
  return ranksDesc.length < headSize ? NO_RANK_HEAD : ranksDesc[headSize - 1];
}
