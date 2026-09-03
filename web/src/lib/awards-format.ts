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
 * Just enough of an award to name one of its editions.
 *
 * Structural rather than `AwardIdentity`, so this module depends on the three fields it
 * actually reads and not on the payload type -- which would drag `api.ts`, and with it the
 * fetch layer, into a file whose whole point is that it is pure.
 */
export interface EditionNaming {
  title: string;
  editionKey: "ordinal" | "year";
  editionOne: string;
}

/**
 * One edition, named the way its award numbers them: `96th · 2024`, or `1994`.
 *
 * Two shapes because the sources genuinely differ. The Academy numbers its ceremonies and
 * the year is a separate label -- one that reads `1927/28` for the first six -- so both are
 * worth printing. Wikidata records a point in time and no ordinal at all, so the year is the
 * whole answer and `1994th` would be an invention.
 *
 * The year is OPTIONAL because the step links know only their neighbour's key: an ordinal
 * award then prints `95th` alone, and a dated one prints the key, which IS its year.
 */
export function editionLabel(award: EditionNaming, ceremony: number, year = ""): string {
  if (award.editionKey === "ordinal") return year ? `${ordinal(ceremony)} · ${year}` : ordinal(ceremony);
  return year || String(ceremony);
}

/**
 * The same edition as a page heading, where there is room to say what it is.
 *
 * The two branches read differently on purpose: "96th ceremony · 2024" needs the noun to
 * explain what is being counted, and "The Palme d'Or 1994" does not -- there is one prize,
 * so the year is the edition. Both sit under a back-link that already names the award, which
 * is why the ordinal branch does not repeat it.
 */
export function editionHeading(award: EditionNaming, ceremony: number, year: string): string {
  if (award.editionKey === "ordinal") return `${ordinal(ceremony)} ${award.editionOne} · ${year}`;
  return `${award.title} ${year || ceremony}`;
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

/**
 * Does this category's nomination lead with the PERSON or with the FILM?
 *
 * > [!IMPORTANT] Decided per CATEGORY, from the source's own `Class` -- never by counting
 * > This replaced `nominees.length === 1 && films.length === 1`, which was a bug on screen
 * > rather than a preference. Best Picture at the 96th rendered eight rows film-first and
 * > two person-first -- `Mark Johnson · The Holdovers`, `James Wilson · The Zone of
 * > Interest` -- because those two films happened to credit ONE producer and the other
 * > eight credited several. The same category read two different ways down one block, and
 * > the reader had no way to know the difference was arithmetic rather than meaning.
 *
 * `Class` is the source's own coarse grouping and it already answers the question: in
 * `Acting`, the PERSON is the nomination and the film is what it was for. Everywhere else
 * the achievement belongs to the film and the names are who made it. So a category is one
 * shape for all of its rows, whoever happened to be credited.
 *
 * The eight classes, measured against the pinned file rather than remembered. **Best
 * Picture is `Title`, NOT `Production`** -- which is the one an English reader guesses
 * wrong, and this comment did until it was checked against the data:
 *
 * | Class | What it covers |
 * |---|---|
 * | `Acting` | the four acting categories, and the ONLY person-led class |
 * | `Title` | awards to a WHOLE WORK -- Best Picture, the shorts, documentary, international |
 * | `Production` | the crafts: cinematography, art direction, editing, sound, costume, casting |
 * | `Directing` | directing, and assistant director |
 * | `Writing` | the screenplay categories |
 * | `Music` | score, song, and dance direction |
 * | `Special` | honorary and special awards, Thalberg |
 * | `SciTech` | the scientific and technical awards |
 *
 * The table is DOCUMENTATION, never a lookup: the function tests `Acting` and everything
 * else falls through, so a class added upstream is film-led rather than unhandled.
 */
export function isPersonLed(className: string): boolean {
  return className === "Acting";
}
