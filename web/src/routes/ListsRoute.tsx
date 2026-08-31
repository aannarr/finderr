/**
 * `/lists` -- what lists exist, and nothing else.
 *
 * An INDEX rather than a view: every row is a link, no titles are fetched, and the page
 * costs one render with no request at all. That is deliberate. Drawing a strip of posters
 * per list would make this page slower than the lists it points at, and it would need a
 * request per row to say something the row's own name already says.
 *
 * The membership rules live in `../lib/lists.ts` and are pure data, so this component
 * decides only how a group of links looks. A new list is one entry there and no change
 * here.
 */

import { Link } from "@tanstack/react-router";
import { listGroups, RANK_EXPLAINER } from "../lib/lists";
import type { SearchParams } from "../lib/search-params";

/**
 * A list's browse params, widened to what the router's validator accepts.
 *
 * The catalogue stores strings because they are URL values; `decade` is the one the
 * validator reads back as a number, so it is converted HERE rather than in the catalogue.
 * Keeping the catalogue stringly-typed is what lets it stay a plain table with no
 * knowledge of the router.
 */
function searchOf(search: Record<string, string>): SearchParams {
  const out: SearchParams = {};
  if (search.genre) out.genre = search.genre;
  if (search.kind) out.kind = search.kind;
  if (search.sort === "rank") out.sort = "rank";
  if (search.decade) out.decade = Number.parseInt(search.decade, 10);
  return out;
}

export function ListsRoute() {
  const groups = listGroups(new Date().getFullYear());

  return (
    <>
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight">Lists</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{RANK_EXPLAINER}</p>
      </div>

      {groups.map((group) => (
        <section key={group.heading} className="mb-8">
          <h3 className="mb-1 text-sm font-semibold tracking-tight">{group.heading}</h3>
          {group.blurb && <p className="mb-3 max-w-2xl text-xs text-muted">{group.blurb}</p>}
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.lists.map((list) => (
              <li key={list.id}>
                <Link
                  to="/browse"
                  search={searchOf(list.search)}
                  className="block rounded-lg border border-line px-3 py-2 transition-colors hover:border-accent/60"
                >
                  <span className="text-sm">{list.title}</span>
                  {list.subtitle && <span className="mt-0.5 block text-xs text-muted">{list.subtitle}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
