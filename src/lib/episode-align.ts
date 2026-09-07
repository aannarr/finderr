/**
 * Which IMDb episode is this TVDB episode? -- the join the score grid is built on.
 *
 * ## Why a join is needed at all
 *
 * A cell on the episode grid has two halves from two sources that share no key. The
 * SKELETON -- which seasons exist, which episodes are in them, what they are called -- is
 * skyhook's, which is TVDB's numbering. The SCORE is ours, from IMDb's `title.episode` +
 * `title.ratings` dumps. There is no episode-level crosswalk between them: skyhook speaks
 * TVDB episode ids and the dumps speak IMDb tconsts, and nothing public maps one to the
 * other for more than a fraction of episodes.
 *
 * So the join used to be the pair both sources happen to print, `(season, number)` -- and
 * that is only valid while the two agree on how a show is cut into seasons. They frequently
 * do not, because those are two editorial decisions rather than two copies of one fact.
 *
 * > [!CAUTION] THE FAILURE IS A WRONG SCORE, NOT A MISSING ONE, AND THAT IS WHY THIS EXISTS
 * > Measured 2026-09-07 across every cached series: 22 shows provably misaligned, **803
 * > episodes sitting at a coordinate that belongs to a different episode**, and 2,136 false
 * > `?` out of 12,528 cells. Star Trek: TNG is the clean example -- TVDB splits the
 * > feature-length pilot into `Encounter at Farpoint (1)` and `(2)`, IMDb keeps one row, and
 * > every later episode of the entire series slid by one. The grid looked perfectly normal
 * > and 24 cells showed the previous episode's rating.
 * >
 * > Reported by aannarr from `/title/tt0149460`, where Futurama's `S6` column drew the four
 * > DVD films' ratings under the 2010 Comedy Central episodes' names.
 *
 * ## The rule, and the nine alternatives it beat
 *
 * Ten strategies were built and scored against an INDEPENDENT oracle -- Wikidata items
 * carrying both `P7043` (TheTVDB episode ID) and `P345` (IMDb ID), which state the answer
 * outright and use none of the signals any strategy uses. 5,048 judged episodes.
 * `.claude/docs/2026-09-07-episode-alignment-lab.md` has every number; the short version:
 *
 * | | %correct | %WRONG |
 * |---|---|---|
 * | the old `(season, number)` join | 96.3% | **2.7%** |
 * | collapse runs sharing an air date | 80.4% | **19.2%** |
 * | match by absolute order | 78.7% | **21.2%** |
 * | runtime-derived slot counts | 92.8% | 6.3% |
 * | **this** | **99.7%** | **0.1%** |
 *
 * **Air date and absolute order are REFUTED, not untried, and both are worse than the bug.**
 * Do not re-propose either. Air date is the trap: TVDB gives both halves of a split double
 * the same date, which looks decisive until you notice that sitcoms aired two DISTINCT
 * episodes back to back on one night and nothing in a date separates the two cases.
 *
 * The three residual disagreements with the oracle were inspected by hand and **all three
 * are the ORACLE being wrong** (Wikidata has Bluey's S2E8/E9 swapped, and files Brooklyn
 * Nine-Nine's "The Fugitive (2)" as part 1). Which is also why the crosswalk is not used
 * here as a source: it is a good oracle and a bad first tier.
 *
 * ## COST, MEASURED -- M1 Max, 2026-09-07, 500 runs per shape after a warm-up
 *
 * This runs on the render path of `/api/title/:tconst`, so it is MATERIAL and owes a number
 * rather than an argument.
 *
 * | series | provider eps | index eps | median | p95 |
 * |---|---|---|---|---|
 * | The Simpsons | 802 | 858 | **2.432 ms** | 2.981 ms |
 * | Naruto: Shippuden | 500 | 500 | 1.610 ms | 2.005 ms |
 * | Star Trek: TNG | 178 | 176 | 0.392 ms | 0.539 ms |
 * | Futurama | 164 | 180 | 0.444 ms | 0.601 ms |
 * | Breaking Bad | 62 | 62 | 0.105 ms | 0.153 ms |
 *
 * Across all 178 cached series: **42.7 ms total, 0.240 ms mean per series.**
 *
 * > [!NOTE] Two things that number does NOT say
 * > **The NAS is not measured.** Its Celeron J4125 ran ~3.5x the M1 Max on the index
 * > benchmarks, so expect single-digit milliseconds for the largest show -- an ESTIMATE,
 * > and it should be read off the machine before anybody plans against it.
 * >
 * > **The title page POLLS.** `POLL_CADENCE_MS` re-reads the endpoint while providers are
 * > still owed answers, so a cold view of the biggest series pays this several times rather
 * > than once. It is still small beside the facet reads in the same handler, and it does no
 * > I/O at all -- but it is a multiplier, not a one-off, and that is the thing to remember
 * > before adding work here.
 */

/** The skeleton half: what a provider says exists. A structural subset of `Episode`. */
export interface SkeletonEpisode {
  season: number;
  number: number;
  title: string | null;
}

/** The score half: what our index holds. A structural subset of `EpisodeRow`. */
export interface IndexEpisode {
  season: number;
  number: number;
  title: string | null;
  rating: number | null;
  votes: number;
}

/**
 * One skeleton episode's score, keyed to the SKELETON's coordinates.
 *
 * `part` is set only where one IMDb episode covers several skeleton slots -- a double
 * episode -- so the grid can say why two adjacent cells carry one number instead of leaving
 * a reader to think it a coincidence.
 */
export interface AlignedScore {
  season: number;
  number: number;
  rating: number | null;
  votes: number;
  /** `{ index: 1, total: 2 }` = the first half of a two-part episode IMDb counts as one. */
  part?: { index: number; total: number };
}

/**
 * Words that may precede a number in a decorative title prefix.
 *
 * A CLOSED LIST on purpose. Cowboy Bebop is why this exists at all -- TVDB titles it
 * `Session #2: Stray Dog Strut` where IMDb says `Stray Dog Strut`, which was 18 of the 21
 * errors the first version of this made. But a general `^\w+ \d+:` would strip the real name
 * off an episode called `Apollo 13: The Landing`, so the vocabulary is enumerated and a new
 * idiom is a deliberate edit here.
 */
const NUMBER_PREFIX =
  /^(session|episode|ep|chapter|part|act|case|file|stage|track)\s*#?\s*\d+\s*[:.\-–—]\s*/i;

/** `Encounter at Farpoint (1)`, `The Fugitive, Part 2` -- one source marks parts, one does not. */
const PART_SUFFIX = /\s*(\(\d+\)|,?\s*part\s+\d+|:\s*part\s+\d+)\s*$/i;

/** Everything but letters and digits removed, so punctuation and case cannot split a match. */
export function foldEpisodeTitle(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Every key one title may be matched under.
 *
 * SEVERAL rather than one, because the two sources decorate a title in two ways neither
 * shares: a numbering prefix and a part marker. A match on any key anchors.
 */
export function titleKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  const add = (s: string) => {
    const f = foldEpisodeTitle(s);
    if (f) out.add(f);
  };
  add(raw);
  const bare = raw.replace(NUMBER_PREFIX, "");
  add(bare);
  add(bare.replace(PART_SUFFIX, ""));
  return [...out];
}

/** Does this title carry an explicit part marker -- `(2)`, `, Part 2`, `: Part 2`? */
function hasPartMarker(raw: string | null | undefined): boolean {
  return !!raw && PART_SUFFIX.test(raw);
}

/** Index -> the one episode claiming a key, or `null` where two claim it and it is useless. */
function uniqueByKey<T extends { title: string | null }>(eps: readonly T[]): Map<string, T | null> {
  const m = new Map<string, T | null>();
  for (const e of eps) {
    for (const k of titleKeys(e.title)) m.set(k, m.has(k) ? null : e);
  }
  return m;
}

/**
 * The skeleton, with explicitly-marked parts of one episode grouped into a single UNIT.
 *
 * > [!IMPORTANT] Without this the double-episode case -- the whole reason this module exists -- refuses itself
 * > `Encounter at Farpoint (1)` and `(2)` both fold to `encounteratfarpoint`, so that key is
 * > claimed TWICE on the skeleton side and neither episode can anchor on it. The run then
 * > reads as two skeleton episodes against one index episode, which step 5 correctly refuses
 * > -- and TNG's pilot, the cleanest example of the bug, drew no score at all. Caught by the
 * > fixture, not by reasoning.
 *
 * Grouping requires an EXPLICIT marker on every member, never merely a shared title. Two
 * episodes genuinely both called `Recap` are two episodes; `(1)` and `(2)` are one episode
 * the provider chose to number twice, and only the provider can tell us which it meant.
 *
 * > [!CAUTION] A PART MARKER IS NOT ITSELF EVIDENCE OF A SPLIT -- `indexBaseCount` is what makes this safe
 * > Measured against the real corpus: grouping on the marker alone was wrong for 5 of 5,048
 * > judged episodes, and every one was the same shape. TVDB writes `Dreamland (1)` and
 * > `Dreamland (2)`; IMDb writes `Dreamland` and `Dreamland II`. **Both sources hold two
 * > episodes** -- they merely spell the second one differently -- so collapsing them mapped
 * > both slots onto `Dreamland` and stranded `Dreamland II`. Same for South Park's
 * > `Imaginationland` trilogy and It's Always Sunny's `The Gang Goes to Hell`.
 * >
 * > So a run only collapses when the INDEX side does not already hold that many episodes
 * > under the same base title. One index row for two marked parts is a split; two rows for
 * > two marked parts is two episodes and the ordinary path handles it.
 * >
 * > The count is by title PREFIX rather than by an equal base, and that is the second half
 * > of the same fix. The two sources do not spell a part the same way: `(2)` against
 * > `II`, `: Episode II`, `, Part Two`. Widening the suffix pattern to cover roman numerals
 * > and spelled-out numbers would start eating the real names of episodes, so instead the
 * > question asked is "how many index titles BEGIN with this base" -- which catches every
 * > spelling at once and needs no vocabulary.
 */
function unitsOf(
  sky: readonly SkeletonEpisode[],
  countIndexTitlesStartingWith: (base: string) => number,
): { positions: number[]; title: string | null }[] {
  const baseOf = (t: string | null | undefined) =>
    foldEpisodeTitle((t ?? "").replace(NUMBER_PREFIX, "").replace(PART_SUFFIX, ""));

  const units: { positions: number[]; title: string | null }[] = [];
  for (let i = 0; i < sky.length; i++) {
    const e = sky[i];
    if (!hasPartMarker(e.title)) {
      units.push({ positions: [i], title: e.title });
      continue;
    }
    const bare = baseOf(e.title);
    // Look ahead over the consecutive marked parts sharing this base title.
    let end = i;
    while (
      end + 1 < sky.length &&
      sky[end + 1].season === e.season &&
      hasPartMarker(sky[end + 1].title) &&
      baseOf(sky[end + 1].title) === bare
    ) {
      end++;
    }
    const run = end - i + 1;
    // The index already holds this many episodes under that base -> not a split.
    if (run > 1 && countIndexTitlesStartingWith(bare) < run) {
      units.push({
        positions: Array.from({ length: run }, (_, k) => i + k),
        title: (e.title ?? "").replace(PART_SUFFIX, ""),
      });
      i = end;
      continue;
    }
    units.push({ positions: [i], title: e.title });
  }
  return units;
}

function sortEpisodes<T extends { season: number; number: number }>(eps: readonly T[]): T[] {
  return [...eps].sort((a, b) => a.season - b.season || a.number - b.number);
}

/**
 * Map every skeleton episode onto the index episode it actually is.
 *
 * Six steps, and step 6 is the one that stops this being a regression:
 *
 * 1. Fold both sides' titles into several keys each.
 * 2. A key unique on BOTH sides is a candidate anchor.
 * 3. Keep only anchors forming a strictly increasing sequence on both sides -- so one bad
 *    match cannot drag a whole season behind it.
 * 4. Map each anchor directly.
 * 5. Between two anchors, equal counts means the order is forced, so map positionally;
 *    unequal counts means something was split or merged in there and nothing available says
 *    which episode is which, so REFUSE the run.
 * 6. A season with no anchors at all AND matching episode counts keeps the naive join.
 *
 * > [!IMPORTANT] Step 6: SILENCE IS NOT EVIDENCE, and leaving it out cost 744 cells
 * > Measured before this step existed. Last Week Tonight with John Oliver titles its
 * > episodes by guest and date, so nothing anchors, every run therefore counts as "unequal",
 * > and **373 of its 377 cells went blank** -- on a show whose two sources agree about every
 * > season's length and which was never wrong. A season only loses the naive join when
 * > something POSITIVELY contradicts it: an anchor landing elsewhere, or a season length the
 * > two sources state differently.
 * >
 * > Same principle as `hasOrigin` dropping a language filter rather than narrowing it. A
 * > guard with no evidence fails toward what it was already doing.
 *
 * Returns rows keyed to the SKELETON, so every consumer keeps joining on `(season, number)`
 * and is correct by construction. A skeleton episode this refuses is simply absent from the
 * result, which every caller already draws as "no score".
 */
export function alignEpisodes(
  skeleton: readonly SkeletonEpisode[],
  index: readonly IndexEpisode[],
): AlignedScore[] {
  if (skeleton.length === 0 || index.length === 0) return [];

  const sky = sortEpisodes(skeleton);
  const imdb = sortEpisodes(index);
  const imdbAt = new Map<IndexEpisode, number>(imdb.map((e, i) => [e, i]));

  /*
    How many index titles BEGIN with a given base -- what `unitsOf` needs to tell a genuine
    split (one index row, two marked slots) from two episodes the sources merely spell
    differently (`Dreamland` + `Dreamland II` against `Dreamland (1)` + `(2)`).

    A linear scan per candidate run rather than a prepared map, because a prefix cannot be
    hashed and the runs that ask are rare -- only a season's explicitly part-marked episodes
    reach here at all. Memoised because a three-part run asks the same question once per
    part otherwise.
  */
  const indexFolds = imdb.map((e) => foldEpisodeTitle(e.title));
  const prefixCounts = new Map<string, number>();
  const countIndexTitlesStartingWith = (base: string): number => {
    if (!base) return 0;
    const seen = prefixCounts.get(base);
    if (seen !== undefined) return seen;
    let n = 0;
    for (const f of indexFolds) if (f.startsWith(base)) n++;
    prefixCounts.set(base, n);
    return n;
  };

  // Explicitly-marked parts of one episode collapse into a single unit BEFORE anything
  // counts anything -- see `unitsOf`. Everything below aligns units to index episodes.
  const units = unitsOf(sky, countIndexTitlesStartingWith);

  const imdbByKey = uniqueByKey(imdb);
  const unitKeyCount = new Map<string, number>();
  for (const u of units) {
    for (const k of titleKeys(u.title)) unitKeyCount.set(k, (unitKeyCount.get(k) ?? 0) + 1);
  }

  // Step 2 + 3: anchors, thinned greedily to a strictly increasing subsequence. Greedy is
  // enough because real divergences are SHIFTS rather than reorderings -- a source that
  // genuinely reorders a season is the case step 5 refuses anyway.
  const anchors: { unitAt: number; imdbAt: number }[] = [];
  const anchoredSeasons = new Set<number>();
  let lastImdb = -1;
  units.forEach((u, at) => {
    for (const k of titleKeys(u.title)) {
      if (unitKeyCount.get(k) !== 1) continue;
      const hit = imdbByKey.get(k);
      if (!hit) continue;
      anchoredSeasons.add(sky[u.positions[0]].season);
      const to = imdbAt.get(hit);
      if (to === undefined || to <= lastImdb) return;
      anchors.push({ unitAt: at, imdbAt: to });
      lastImdb = to;
      return;
    }
  });

  // How long each side says a season is. Used by step 6, and only ever compared for a
  // season the SKELETON has -- a season IMDb knows and the provider does not is not a
  // disagreement, because the grid never draws it.
  const lengthOf = (eps: readonly { season: number; number: number }[]) => {
    const m = new Map<number, number>();
    for (const e of eps) m.set(e.season, Math.max(m.get(e.season) ?? 0, e.number));
    return m;
  };
  const skyLen = lengthOf(sky);
  const imdbLen = lengthOf(imdb);

  /** skeleton position -> the index episode it maps to, or absent for a refusal. */
  const mapped = new Map<number, IndexEpisode>();
  const assign = (unit: { positions: number[] }, e: IndexEpisode) => {
    for (const p of unit.positions) mapped.set(p, e);
  };

  // Step 4 + 5: walk the segments between consecutive anchors, and the two ends.
  const segments: { units: [number, number]; imdb: [number, number] }[] = [];
  let prevUnit = -1;
  let prevImdb = -1;
  for (const a of anchors) {
    segments.push({ units: [prevUnit + 1, a.unitAt], imdb: [prevImdb + 1, a.imdbAt] });
    assign(units[a.unitAt], imdb[a.imdbAt]);
    prevUnit = a.unitAt;
    prevImdb = a.imdbAt;
  }
  segments.push({ units: [prevUnit + 1, units.length], imdb: [prevImdb + 1, imdb.length] });

  for (const seg of segments) {
    const runUnits = seg.units[1] - seg.units[0];
    const runImdb = seg.imdb[1] - seg.imdb[0];
    if (runUnits !== runImdb) continue; // refused: nothing says which is which
    for (let i = 0; i < runUnits; i++) assign(units[seg.units[0] + i], imdb[seg.imdb[0] + i]);
  }

  // Step 6: a season nothing contradicts keeps the naive join.
  const naiveByPair = new Map<string, IndexEpisode>();
  for (const e of imdb) naiveByPair.set(`${e.season}:${e.number}`, e);
  sky.forEach((e, at) => {
    if (mapped.has(at)) return;
    if (anchoredSeasons.has(e.season)) return;
    if (skyLen.get(e.season) !== imdbLen.get(e.season)) return;
    const hit = naiveByPair.get(`${e.season}:${e.number}`);
    if (hit) mapped.set(at, hit);
  });

  return withParts(sky, mapped);
}

/**
 * Emit the rows, marking any index episode that covers several skeleton slots.
 *
 * That is exactly what a double episode IS under this alignment -- IMDb kept one row where
 * the provider numbered two -- so nothing has to detect it separately, and the mark cannot
 * disagree with the join that produced it. Counted over the whole series rather than per
 * season, because a run cannot cross a season boundary anyway and one pass is cheaper.
 */
function withParts(sky: readonly SkeletonEpisode[], mapped: Map<number, IndexEpisode>): AlignedScore[] {
  const covers = new Map<IndexEpisode, number[]>();
  for (const [at, e] of mapped) {
    const list = covers.get(e);
    if (list) list.push(at);
    else covers.set(e, [at]);
  }

  const out: AlignedScore[] = [];
  for (const [e, positions] of covers) {
    positions.sort((a, b) => a - b);
    positions.forEach((at, i) => {
      const row: AlignedScore = {
        season: sky[at].season,
        number: sky[at].number,
        rating: e.rating,
        votes: e.votes,
      };
      if (positions.length > 1) row.part = { index: i + 1, total: positions.length };
      out.push(row);
    });
  }
  return sortEpisodes(out);
}
