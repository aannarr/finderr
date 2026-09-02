/**
 * IMDb's credit vocabulary, in the words a reader would use.
 *
 * ONE owner of the mapping, because there are now two readers of it: the role chips on a
 * person page and the roles printed beside a frequent collaborator. A second copy would
 * drift on the first category the index learns to ingest.
 */

import type { PersonPage } from "./api";

/**
 * IMDb's vocabulary is not what a person would say out loud.
 *
 * Every value in `index.castCategories` needs a line here, or a composer's page draws a
 * chip reading `production_designer`. An unmapped category falls through to its raw name
 * rather than disappearing -- a filter that quietly dropped credits would be the worse
 * failure, and a chip that reads like a database column is at least self-reporting.
 */
const CATEGORY_LABEL: Record<string, string> = {
  actor: "Acting",
  actress: "Acting",
  casting_director: "Casting",
  cinematographer: "Cinematography",
  composer: "Music",
  director: "Directing",
  editor: "Editing",
  producer: "Production",
  production_designer: "Production Design",
  writer: "Writing",
};

/** What one IMDb category is called on screen; its raw name when we have no word for it. */
export function creditLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

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
