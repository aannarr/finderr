/**
 * Text normalization for title matching.
 *
 * The whole point: IMDb stores titles as humans wrote them (Alien³, WALL·E, Låt den
 * rätte komma in) and humans type them as they can be bothered (alien 3, wall e,
 * lat den ratte). Everything below exists to make those two meet in the middle.
 */

/**
 * NFKD handles a lot -- superscripts, fullwidth forms, roman-numeral codepoints --
 * but it does NOT decompose true ligatures or Nordic strokes. Those need a map.
 * Verified: "Alien³".normalize("NFKD") -> "Alien3", but "Æon".normalize("NFKD") -> "Æon".
 */
const LIGATURES: Record<string, string> = {
  æ: "ae",
  Æ: "ae",
  ø: "o",
  Ø: "o",
  ß: "ss",
  œ: "oe",
  Œ: "oe",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  ł: "l",
  Ł: "l",
  þ: "th",
  Þ: "th",
  "·": " ", // WALL·E
  "・": " ",
  "‧": " ",
};

const LIGATURE_RE = new RegExp(`[${Object.keys(LIGATURES).join("")}]`, "g");
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Leading articles, in the languages this library actually contains. */
const LEADING_ARTICLE = /^(the|a|an|le|la|les|el|los|las|der|die|das|den|det|en|ett|il|lo|gli|de|het) /;

/**
 * Fold a title or query to a comparable form: lowercase, decomposed, ligature-mapped,
 * punctuation collapsed to single spaces.
 */
export function normalize(input: string | null | undefined): string {
  if (!input) return "";
  return (
    input
      // Decompose BEFORE lowercasing. NFKD can introduce new uppercase letters --
      // "№" becomes "No" -- and lowercasing first leaves that N to be stripped as
      // non-[a-z], silently losing a character.
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .replace(LIGATURE_RE, (c) => LIGATURES[c] ?? c)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  );
}

/** Normalized, with a leading article removed. "The Matrix" -> "matrix" */
export function normalizeStripped(input: string | null | undefined): string {
  return normalize(input).replace(LEADING_ARTICLE, "");
}

/**
 * Normalized with all spaces removed. This is what makes "buda pest" find
 * "Budapest" and "Nile City" find "NileCity 105.6".
 */
export function despace(input: string | null | undefined): string {
  return normalize(input).replace(/ /g, "");
}

// ---------------------------------------------------------------------------
// Trigrams
// ---------------------------------------------------------------------------

/** Character trigrams of a normalized string, space-padded so word edges count. */
export function trigrams(normalized: string): Set<string> {
  const padded = ` ${normalized} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Set intersection size. */
function overlap(a: Set<string>, b: Set<string>): number {
  // Iterate the smaller set -- the pool sets can be large.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (large.has(x)) n++;
  return n;
}

/** Jaccard similarity. Symmetric: penalizes length mismatch in both directions. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const i = overlap(a, b);
  return i / (a.size + b.size - i);
}

/**
 * Asymmetric coverage: how much of the QUERY appears in the title.
 * Jaccard alone punishes a short query against a long title -- "shashank" vs
 * "the shawshank redemption" scores badly on Jaccard but should clearly match.
 */
export function coverage(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;
  return overlap(query, target) / query.size;
}

/** Blended score: mostly Jaccard, enough coverage to rescue short-vs-long. */
export function similarity(query: Set<string>, target: Set<string>): number {
  return 0.65 * jaccard(query, target) + 0.35 * coverage(query, target);
}

// ---------------------------------------------------------------------------
// Edit distance
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance, capped. Trigrams are blind under about six characters
 * ("sielo" vs "silo" share almost nothing), so short queries need real edit distance.
 * Returns `cap + 1` as soon as it is clear the distance exceeds `cap`.
 */
export function levenshtein(a: string, b: string, cap = 3): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Every remaining row can only grow; bail once the whole row exceeds the cap.
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
