/**
 * Which of RT's search hits is the film we asked about, if any of them is.
 *
 * RT's index is keyed by its own ids and knows nothing about `tt...`, so the only way in
 * is a title-and-year match -- and a title-and-year match is a guess. The whole design of
 * this file is about which guesses to refuse: a confidently wrong RT score sitting beside
 * a correct IMDb one is worse than no RT score at all.
 *
 * The scoring is Seerr's (the Overseerr fork), which multiplies three factors and takes
 * the argmax:
 *
 *     score = title * year * hasScores
 *
 * Two things here that Seerr does not have, both bought by holding the IMDb row rather
 * than a TMDB lookup: the title is scored against `title` AND `originalTitle`, and the
 * winner is then HARD-GATED on our year, which is IMDb's and independent of RT's.
 *
 * Pure over its inputs -- no fetch, no clock, no storage -- which is why it is a separate
 * file from the plugin that calls it and why every tunable below is unit-tested.
 */

import type { FacetEntity } from "../../lib/facets";
import { normalize, similarity, trigrams } from "../../lib/normalize";
import type { RtHit } from "./algolia";

/** A title that is close but not identical counts for very little. */
export const INEXACT_TITLE_FACTOR = 0.25;

/** Matching an `aka` or a display variant is worth less than matching the real title. */
export const ALTERNATE_TITLE_FACTOR = 0.8;

/** Year off by 0/1/2/3+ scores 1.0 / 0.6 / 0.2 / 0.0. */
export const PER_YEAR_PENALTY = 0.4;

/** Below this, answer with nothing rather than with a guess. */
export const MINIMUM_SCORE = 0.175;

/** A hit carrying no scores is halved: it is the wrong entry even when it is the right film. */
export const NO_SCORES_FACTOR = 0.5;

/** Years RT may be off by before the winner is refused outright, whatever it scored. */
export const MAX_YEAR_DISTANCE = 1;

/** One hit, scored. `titleScore` is kept because the year gate needs to see it. */
export interface ScoredHit {
  hit: RtHit;
  score: number;
  titleScore: number;
}

/**
 * The best hit, or `null` if none of them is good enough to show.
 *
 * Note the order: argmax FIRST, then the year gate on the winner. Gating before scoring
 * would let a hit we are not sure about win a search whose real answer was simply filed
 * under a different year, and "nothing" is the answer we want in that case.
 */
export function bestMatch(hits: readonly RtHit[], entity: FacetEntity): RtHit | null {
  let winner: ScoredHit | null = null;
  for (const hit of hits) {
    const scored = scoreHit(hit, entity);
    if (!winner || scored.score > winner.score) winner = scored;
  }
  if (!winner || winner.score < MINIMUM_SCORE) return null;
  return yearIsVerified(winner, entity) ? winner.hit : null;
}

/** One hit's score, exported so each factor can be tested on its own. */
export function scoreHit(hit: RtHit, entity: FacetEntity): ScoredHit {
  const titleScore = bestTitleScore(hit, entity);
  const score = titleScore * yearScore(hit, entity) * (hit.rottenTomatoes ? 1 : NO_SCORES_FACTOR);
  return { hit, score, titleScore };
}

/**
 * The check Seerr cannot make: our year comes from IMDb, RT's comes from RT.
 *
 * When we have no year to check against, the only match trusted is a title that matched
 * exactly. An approximate title with an unverifiable year is precisely the confident wrong
 * answer this plugin would rather not give.
 */
function yearIsVerified(match: ScoredHit, entity: FacetEntity): boolean {
  if (entity.year === null || match.hit.releaseYear == null) return match.titleScore === 1;
  return Math.abs(match.hit.releaseYear - entity.year) <= MAX_YEAR_DISTANCE;
}

/** Our two names against all of theirs -- the case `max()` exists for. */
function bestTitleScore(hit: RtHit, entity: FacetEntity): number {
  let best = 0;
  for (const theirs of namesOf(hit)) {
    for (const ours of [entity.title, entity.originalTitle]) {
      const score = titleSimilarity(ours, theirs.name) * (theirs.alternate ? ALTERNATE_TITLE_FACTOR : 1);
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Every name RT holds for this hit.
 *
 * `aka` are foreign-market titles and `titles` are the index's own display variants
 * (`"Break-Bad"` for Breaking Bad), so neither is what the title is really called and both
 * are discounted as alternates.
 */
function* namesOf(hit: RtHit): Generator<{ name: string; alternate: boolean }> {
  yield { name: hit.title, alternate: false };
  for (const name of [...(hit.aka ?? []), ...(hit.titles ?? [])]) yield { name, alternate: true };
}

/**
 * 1.0 for the same title, a heavily discounted trigram score for anything else.
 *
 * Seerr uses Jaro here. This repo already owns a title-similarity metric -- the trigram
 * blend in `lib/normalize` that the search index scores with -- and a second string
 * distance would be a second thing to keep calibrated for no gain: at
 * `INEXACT_TITLE_FACTOR` an inexact match has to reach 0.7 to clear `MINIMUM_SCORE` at
 * all, and trigram similarity is the stricter of the two around there. Stricter is the
 * side of the line this plugin wants to be wrong on.
 */
function titleSimilarity(ours: string | null, theirs: string): number {
  const a = normalize(ours);
  const b = normalize(theirs);
  // `normalize` folds to ASCII, so two unrelated non-latin titles both fold to "". Scoring
  // that as an exact match would hang RT's numbers on whatever film happened to come back.
  if (!a || !b) return 0;
  if (a === b) return 1;
  return similarity(trigrams(a), trigrams(b)) * INEXACT_TITLE_FACTOR;
}

/** How far off RT's release year is, or a free pass when either side does not have one. */
function yearScore(hit: RtHit, entity: FacetEntity): number {
  // A free pass here is safe only because `yearIsVerified` then demands an exact title.
  if (entity.year === null || hit.releaseYear == null) return 1;
  return Math.max(0, 1 - Math.abs(hit.releaseYear - entity.year) * PER_YEAR_PENALTY);
}
