/**
 * `/lists` -- what lists exist, and how much of each one you already own.
 *
 * An INDEX rather than a view: every row is a link and no titles are fetched. Drawing a
 * strip of posters per list would make this page slower than the lists it points at, and it
 * would need a request per row to say something the row's own name already says.
 *
 * ONE request now, and it is the exception that proves that rule rather than a break with
 * it: `/api/lists/completion` answers for the whole catalogue at once, and it says the one
 * thing a row's name cannot -- "you own 178 of 250". The page renders complete without it,
 * so the counts fill in behind the links rather than gating them.
 *
 * The membership rules live in `src/lib/lists.ts` and are pure data, so this component
 * decides only how a group of links looks. A new list is one entry there and no change
 * here -- which was true of the COMPUTED half and quietly false of the curated one: the
 * `CURATED` array had been declared, documented as rendered here and tested for months
 * without any component reading it, so `/awards/oscars` was reachable only from the top nav
 * and the one hand-curated list finderr owns was missing from the page listing the lists.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  type ComputedList,
  CURATED,
  type CuratedPath,
  completionNoun,
  listGroups,
  RANK_EXPLAINER,
} from "../../../src/lib/lists";
import { Completion } from "../components/Completion";
import type { SearchParams } from "../lib/search-params";
import { useListCompletions } from "../lib/use-list-completions";

/**
 * A list's browse params: its filters, plus the ordering that makes it a list.
 *
 * `sort: "rank"` is spelled HERE rather than stored on every catalogue entry, because it is
 * true of every computed list by definition -- a row that could carry a different sort would
 * be a row that could stop being a list without anything noticing.
 */
function searchOf(list: ComputedList): SearchParams {
  return { ...list.filters, sort: "rank" };
}

export function ListsRoute() {
  const groups = listGroups(new Date().getFullYear());
  const completions = useListCompletions();

  return (
    <>
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight">Lists</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{RANK_EXPLAINER}</p>
      </div>

      {/*
        The curated lists come FIRST, and that is an editorial order rather than a
        chronological one: somebody maintains these, so they are the ones worth meeting
        before twenty-six generated rows. The section disappears entirely when `CURATED` is
        empty -- a bare heading over nothing is a promise the page cannot keep.
      */}
      {CURATED.length > 0 && (
        <Section heading="Curated" blurb="Lists somebody maintains, with their own pages.">
          {CURATED.map((list) => (
            <ListCard key={list.id} title={list.title} subtitle={list.subtitle} to={list.to} />
          ))}
        </Section>
      )}

      {groups.map((group) => (
        <Section key={group.heading} heading={group.heading} blurb={group.blurb}>
          {group.lists.map((list) => {
            const done = completions[list.id];
            return (
              <ListCard
                key={list.id}
                title={list.title}
                subtitle={list.subtitle}
                to="/browse"
                search={searchOf(list)}
              >
                {done && (
                  <Completion
                    owned={done.owned}
                    total={done.size}
                    noun={completionNoun(list.filters.kind)}
                    className="mt-1.5 text-xs text-muted"
                  />
                )}
              </ListCard>
            );
          })}
        </Section>
      ))}
    </>
  );
}

/** A heading, its blurb, and the grid of cards under it. */
function Section({ heading, blurb, children }: { heading: string; blurb?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="mb-1 text-sm font-semibold tracking-tight">{heading}</h3>
      {blurb && <p className="mb-3 max-w-2xl text-xs text-muted">{blurb}</p>}
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>
    </section>
  );
}

/**
 * One row: a name, a line under it, and whatever the caller wants below that.
 *
 * `to` and `search` are passed straight through to the router rather than being derived
 * here, because that is the ONE thing a curated row and a computed row genuinely differ on
 * -- its own page versus a browse. Everything else about them is identical, which makes
 * this a prop rather than two components.
 */
function ListCard({
  title,
  subtitle,
  to,
  search,
  children,
}: {
  title: string;
  subtitle?: string;
  to: "/browse" | CuratedPath;
  search?: SearchParams;
  children?: ReactNode;
}) {
  return (
    <li>
      <Link
        to={to}
        search={search ?? {}}
        className="block rounded-lg border border-line px-3 py-2 transition-colors hover:border-accent/60"
      >
        <span className="text-sm">{title}</span>
        {subtitle && <span className="mt-0.5 block text-xs text-muted">{subtitle}</span>}
        {children}
      </Link>
    </li>
  );
}
