/**
 * IMDb's credit vocabulary, in the words a reader would use.
 *
 * > [!IMPORTANT] It lives in `src/lib` and not in `web/src/lib`, for the reason
 * > `src/lib/lists.ts` states about the list catalogue: BOTH SIDES read it now.
 * > The browser labels the role chips on a person page, and the server groups credits into
 * > the people boards `/lists` draws -- and "an actor and an actress are one job" has to be
 * > the same sentence in both places or the two surfaces disagree about what a board counts.
 *
 * Pure data and one pure function. No React, no fetch, no SQLite.
 */

/**
 * IMDb's vocabulary is not what a person would say out loud.
 *
 * Every value in `index.castCategories` needs a line here, or a composer's page draws a
 * chip reading `production_designer`. An unmapped category falls through to its raw name
 * rather than disappearing -- a filter that quietly dropped credits would be the worse
 * failure, and a chip that reads like a database column is at least self-reporting.
 *
 * `actor` and `actress` deliberately share a label. IMDb splits them and we do not:
 * "Acting (41)" is the answer a filmography is asking for, two gendered chips is a
 * distinction nobody browsing wants to make, and a leaderboard that split them would rank
 * half a profession against the other half.
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
