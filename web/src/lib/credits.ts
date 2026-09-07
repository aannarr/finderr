/**
 * IMDb's credit vocabulary, as the BROWSER groups it.
 *
 * The mapping itself moved to `src/lib/credits.ts` when the server grew a reader of it --
 * the people boards on `/lists` group credits by the same labels these chips print, and
 * two copies of "an actor and an actress are one job" would drift. What is left here is
 * the part that is genuinely about the browser's own shapes: `PersonPage.categories`.
 */

import { creditLabel } from "../../../src/lib/credits";
import type { CardNote } from "../components/TitleCard";
import type { Credit, PersonPage, Title } from "./api";

/**
 * The distinct labels a set of categories reads as, in the order they were given.
 *
 * `actor` and `actress` collapse to one "Acting", which is the whole point: a collaborator
 * billed under both across several films is one job, not two.
 */
export function creditLabels(categories: readonly string[]): string[] {
  return [...new Set(categories.map(creditLabel))];
}

/**
 * A title row that MIGHT carry credit fields -- every `Credit` does, no other `Title` does.
 *
 * The optionality is what makes `creditNote` usable as `TitleGrid`'s `noteFor`, and the
 * reason is variance rather than defensiveness: that slot is typed `(t: Title) => ...`,
 * parameters are contravariant, and `Credit` is NARROWER than `Title` -- so a function
 * demanding a `Credit` is precisely the one TypeScript refuses there. Widening until a bare
 * `Title` satisfies it costs two `?` and avoids a generic `TitleGrid<T extends Title>`,
 * which `memo` cannot express without a cast.
 *
 * > [!IMPORTANT] `tconst` is REQUIRED here and is never read, which is deliberate
 * > A type whose properties are ALL optional is a WEAK TYPE, and TypeScript then refuses
 * > any argument sharing no property with it -- so `Partial<Pick<Credit, ...>>` alone made
 * > `noteFor={creditNote}` an error reading *"Type 'Title' has no properties in common"*,
 * > which is the opposite of what the widening was for. Naming the row's IDENTITY is the
 * > honest way to satisfy it: this function takes a title row and reads two fields off it if
 * > they are there. Spelling it `Title &` instead would be equally sound and would force
 * > every test fixture to build a whole `RequestStateView`, which is how a pure function
 * > ends up with a test nobody runs.
 */
type CreditLike = Pick<Title, "tconst"> & Partial<Pick<Credit, "categories" | "characters">>;

/**
 * What this person DID on this title, as a card's note line.
 *
 * ONE credit is drawn and the rest are on hover, which is aannarr's call of 2026-09-07
 * ("single best title/credit only... first one is fine for now", "hover may reveal ALL
 * credits"). A card is about 150px wide and has already spent a line each on the year, on
 * an award and possibly on an original title -- the same width argument `AwardChip` and the
 * upcoming date line both make in `TitleCard`. So the line answers "who were they in this"
 * in as few words as the data allows, and the `title` attribute carries the whole truth for
 * anybody who wants it.
 *
 * **The CHARACTER wins over the role**, when there is one. "Ellen Ripley" is what a reader
 * recognises and "Acting" is what they already knew from the chip they clicked; a role
 * label is the fallback for a director, a composer, an editor -- everybody whose credit has
 * no character behind it.
 *
 * **FIRST, not best, and the difference is that there is no ranking here.** `characters`
 * arrives from `group_concat(distinct)` in source order and `categories` arrives sorted
 * alphabetically, so "first" is a stable arbitrary choice rather than a judgement about
 * which of somebody's two jobs mattered more. Making that judgement needs a signal the
 * index does not carry -- billing order is per credit ROW and we keep only the `min` across
 * them -- so inventing one would be a guess wearing a ranking's clothes.
 *
 * `null` for a credit carrying neither, which draws no line at all rather than an empty one.
 *
 * **This is the variant that PRINTS THE JOB, and a page only wants it sometimes** -- see
 * `rolesWorthPrinting` and `characterNote` below. Choose between the two there rather than
 * reaching for this one directly.
 *
 * > [!IMPORTANT] Under a ROLE FILTER the categories are narrowed, and that is the server's doing
 * > `personPage` applies `where ... tp.category in (...)` to the grouped query as well as to
 * > the count (`src/lib/people.ts`), so filtering to Directing returns `categories:
 * > ["director"]` for a film somebody also wrote -- the hover would then be "every credit
 * > MATCHING THE FILTER" rather than every credit. `rolesWorthPrinting` returns false for
 * > exactly that case, so the filtered page draws `characterNote` and never makes the
 * > narrowed claim at all. Anything else calling this directly inherits the caveat.
 */
export function creditNote(credit: CreditLike): CardNote | null {
  return noteOf(credit, true);
}

/**
 * The same line with the JOB withheld -- who they played, or nothing at all.
 *
 * For a filmography where the role cannot vary: everything Billy West is credited for is
 * acting, so a "Acting" under all nineteen cards restates the chip above them nineteen
 * times and pushes the one fact that does vary -- Philip J. Fry, Sorcerio, Zapp Brannigan --
 * no further up the card. `rolesWorthPrinting` decides which of the two a page wants, and
 * the reason it can decide it ONCE is that `PersonPage.categories` is the person's whole
 * role breakdown rather than the loaded page's.
 *
 * **A pair of module-level functions rather than one taking a flag**, because `TitleGrid` is
 * `memo`'d and `noteFor` must be a STABLE reference: `rolesWorthPrinting(...) ? creditNote :
 * characterNote` picks between two constants and allocates nothing, where a bound or
 * arrow-wrapped variant would be a new function on every render of the route.
 *
 * The rule this leaves is worth stating plainly: **a character always draws, a job draws
 * only when it distinguishes one card from another.**
 */
export function characterNote(credit: CreditLike): CardNote | null {
  return noteOf(credit, false);
}

/**
 * Which of the two lines THIS filmography wants, as a function its grid can hold.
 *
 * ONE rule: **a job is printed only when it tells two cards apart.** If every card that
 * would name a job names the SAME job, the word is a column of itself and the character --
 * the thing that does vary -- is what the line should carry.
 *
 * That single test subsumes the three ways the repetition arises, which is why this takes no
 * flags. All three were measured on the real pages, 2026-09-07:
 *
 * - **A person who only ever does one job.** Billy West, nineteen acting credits: every card
 *   printed "Acting" and buried Philip J. Fry, Sorcerio and Zapp Brannigan under it.
 * - **A role filter.** A chip carries every IMDb value behind ONE label (`mergedCategories`
 *   merges `actor` and `actress` precisely so it does), so narrowing to a chip narrows to a
 *   single label by construction. `personPage` also strips the other categories from each
 *   row under a filter -- which is why `creditNote`'s caveat about a NARROWED HOVER cannot
 *   bite here: a filtered page never reaches `creditNote` at all.
 * - **A person who does the same job on everything.** Nolan holds three roles, so a
 *   person-level count of distinct roles calls the job informative -- and every one of his
 *   fourteen cards still printed "Directing", because he directs all of them. This is the
 *   case that a role COUNT cannot see and only comparing the actual lines catches. It is
 *   also the case the whole change was asked for.
 *
 * > [!IMPORTANT] It reads the LOADED credits, and the instability that costs is one-way
 * > The obvious alternative was `PersonPage.categories`, whose counts are over all of the
 * > person's credits and therefore identical on the first page and the fifth. It was built
 * > that way first and it does not work: marginal counts per category cannot tell you which
 * > label each TITLE would print, so Nolan survives it. Nothing short of the rows answers
 * > the question the rule actually asks.
 * >
 * > So notes can APPEAR when somebody presses "Show 60 more" and a genuinely different job
 * > arrives. They can never vanish: growing the set can only turn uniform into varied. A
 * > one-way change that fires exactly when new information shows up is the acceptable half
 * > of that trade, and it is the half we are on.
 *
 * **Returns one of two MODULE-LEVEL constants and allocates nothing**, because `TitleGrid`
 * is `memo`'d and `noteFor` has to be a stable reference. A closure built per render, or a
 * `.bind`, would defeat the memo for every card on the page.
 */
export function noteForFilmography(credits: readonly CreditLike[]): (credit: CreditLike) => CardNote | null {
  return jobVaries(credits) ? creditNote : characterNote;
}

/**
 * Would naming the job distinguish any two of these cards?
 *
 * Compares the JOB each card would actually print -- `creditLabels(...)[0]`, the same value
 * `creditNote` picks -- rather than the set of jobs the person holds. A credit with no job
 * at all is skipped rather than counted as a distinct one: an absent label is not a second
 * opinion, and counting it would turn one missing category into a page-wide "varied".
 *
 * Short-circuits on the first disagreement, so the common case for a mixed filmography is a
 * couple of comparisons rather than a walk of every loaded row.
 */
function jobVaries(credits: readonly CreditLike[]): boolean {
  let seen: string | undefined;
  for (const credit of credits) {
    const job = creditLabels(credit.categories ?? [])[0];
    if (job === undefined) continue;
    if (seen === undefined) seen = job;
    else if (seen !== job) return true;
  }
  return false;
}

/**
 * The shared body: pick the line, then say everything it was picked from.
 *
 * One owner for the character-beats-role rule and for the hover string, so the two exported
 * entry points cannot drift into disagreeing about either.
 */
function noteOf(credit: CreditLike, withRoles: boolean): CardNote | null {
  const characters = splitCharacters(credit.characters ?? null);
  const roles = withRoles ? creditLabels(credit.categories ?? []) : [];
  const text = characters[0] ?? roles[0];
  if (text === undefined) return null;

  // The hover says everything, in the order the line chose from: who they played first,
  // then every job they held. A reader opening the tooltip has already read `text`, so
  // repeating it as the head of the list is what makes the extra items read as "and also".
  const full = [...characters, ...roles].join(" · ");
  return { text, full };
}

/**
 * The joined character list, back into its parts.
 *
 * `normalizeCharacters` on the server joins with `", "` and that is the only separator this
 * field can carry -- it is built by `splitConcat`, which has already thrown away any commas
 * that were inside a single name, because SQLite's `group_concat(distinct ...)` takes no
 * separator argument and always uses a bare comma. So a character genuinely named "Smith,
 * John" is already two entries by the time it reaches us and nothing here can recover it.
 * Splitting on the same separator the server joined with is therefore exact for every name
 * that survived, which is the honest limit of this field rather than a shortcut taken here.
 */
function splitCharacters(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `actor` and `actress` are one job.
 *
 * IMDb splits them and we do not: "Acting (41)" is the answer a filmography is asking
 * for, and two gendered chips is a distinction nobody browsing wants to make. Each merged
 * chip carries EVERY IMDb value behind it, and all of them travel to the API -- filtering
 * on just one would drop every actress credit from an Acting filter, which is a wrong
 * answer that looks right because the page still fills with plausible rows.
 */
export function mergedCategories(
  categories: PersonPage["categories"],
): { label: string; values: string[]; count: number }[] {
  const byLabel = new Map<string, { values: string[]; count: number }>();
  for (const c of categories) {
    const label = creditLabel(c.category);
    const entry = byLabel.get(label) ?? { values: [], count: 0 };
    entry.values.push(c.category);
    entry.count += c.count;
    byLabel.set(label, entry);
  }
  return [...byLabel]
    .map(([label, v]) => ({ label, values: v.values.sort(), count: v.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
