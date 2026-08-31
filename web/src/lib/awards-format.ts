/**
 * Pure formatting rules for the award screens.
 *
 * Here rather than in a route for the same reason `facet-panes.ts` exists: four components
 * across two routes and two panes print an ordinal and a category name, and a rule that
 * lives in a route file has to be imported BY components, which points the dependency the
 * wrong way. No React, no DOM, no fetch -- so they are tested directly.
 */

/** `98` -> `98th`. English ordinals, irregular exactly where you expect. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  // 11th, 12th and 13th are the exceptions that make a naive `n % 10` table wrong -- and
  // all three fall inside the range this page renders, so this is not defensive coding.
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * The year a ceremony is ABOUT, as a number, for a header range.
 *
 * The first six ceremonies carry `1927/28`, so the leading four digits are the answer and
 * parsing the whole string is not. `null` rather than a guess on anything else: a header
 * reading "1929 – 2026" is nice and one reading "NaN" is a bug on screen.
 */
export function ceremonyYear(year: string): number | null {
  const n = Number.parseInt(year.slice(0, 4), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * `WRITING (Adapted Screenplay)` -> `Writing (Adapted Screenplay)`.
 *
 * The stored name is the source's own uppercase, which is the right thing to GROUP on --
 * `CanonicalCategory` is the key that survives a category being renamed mid-century -- and
 * the wrong thing to read five of in a row.
 *
 * Only the CASE changes. No word is dropped, no parenthetical is rewritten and nothing is
 * reordered, so a category is still recognisably the one the ceremony page prints in full
 * and a reader can match the two by eye. The apostrophe is inside the word class on
 * purpose: without it `WOMEN'S` becomes `Women'S`.
 */
export function prettyCategory(name: string): string {
  return name.replace(/[A-Za-z][A-Za-z']*/g, (word) => word[0] + word.slice(1).toLowerCase());
}
