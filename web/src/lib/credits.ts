/**
 * IMDb's credit vocabulary, as the BROWSER groups it.
 *
 * The mapping itself moved to `src/lib/credits.ts` when the server grew a reader of it --
 * the people boards on `/lists` group credits by the same labels these chips print, and
 * two copies of "an actor and an actress are one job" would drift. What is left here is
 * the part that is genuinely about the browser's own shapes: `PersonPage.categories`.
 */

import { creditLabel } from "../../../src/lib/credits";
import type { PersonPage } from "./api";

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
