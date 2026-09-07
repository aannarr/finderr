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
 * > [!IMPORTANT] Under a ROLE FILTER this is narrowed, and that is the server's doing
 * > `personPage` applies `where ... tp.category in (...)` to the grouped query as well as to
 * > the count (`src/lib/people.ts`), so filtering to Directing returns `categories:
 * > ["director"]` for a film somebody also wrote, and no characters at all. The note then
 * > reads "Directing" and the hover agrees with it. That is honest for the question asked --
 * > the reader narrowed to one job and is being shown that job -- but it means the hover is
 * > "all credits MATCHING THE FILTER", never all credits full stop.
 */
export function creditNote(credit: CreditLike): CardNote | null {
  const characters = splitCharacters(credit.characters ?? null);
  const roles = creditLabels(credit.categories ?? []);
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
