/**
 * `/lists` -- what lists exist, how much of each one you already own, and who is in them.
 *
 * An INDEX rather than a view, and still ONE request. Drawing a strip of posters per list
 * would make this page slower than the lists it points at if each strip cost a fetch -- so
 * none of them does: `/api/lists/completion` answers for the whole page at once, and
 * everything added to this route since has ridden that same call rather than earning a
 * second round trip. The page renders complete without it, so counts, posters and people
 * fill in behind the links rather than gating them.
 *
 * THREE SECTIONS, and the difference between them is what a row IS:
 *
 * - CURATED -- eight award lists with their own pages, each drawing up to five posters of
 *   what its top prize has recently gone to. Ids only, so the strip is a hint at the list
 *   rather than a copy of it, and no title card machinery is involved -- see `ListPoster`
 *   for why that matters.
 * - COMPUTED -- the generated genre and decade rows, text with a completion count. Thirty
 *   poster strips is the page this docstring rejects, and correctly.
 * - PEOPLE -- a list of PEOPLE rather than titles, ranked over the membership of the
 *   all-time lists above. Drawn with `PeopleLeaderboard`, the same component the award
 *   people pages use: the ranking is the parameter and the page is not.
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
  completionNoun,
  listGroups,
  RANK_EXPLAINER,
} from "../../../src/lib/lists";
import type { ListPoster } from "../../../src/server/lists";
import { Completion } from "../components/Completion";
import { PeopleLeaderboard } from "../components/PeopleLeaderboard";
import { Poster } from "../components/Poster";
import type { SearchParams } from "../lib/search-params";
import { useListsIndex } from "../lib/use-lists-index";

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
  const { completions, posters, boards } = useListsIndex();

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
          <CardGrid>
            {CURATED.map((list) => (
              <ListCard
                key={list.id}
                title={list.title}
                subtitle={list.subtitle}
                to="/awards/$award"
                params={{ award: list.id }}
              >
                <PosterStrip posters={posters[list.id]} />
              </ListCard>
            ))}
          </CardGrid>
        </Section>
      )}

      {groups.map((group) => (
        <Section key={group.heading} heading={group.heading} blurb={group.blurb}>
          <CardGrid>
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
          </CardGrid>
        </Section>
      ))}

      {/*
        The caveat is stated ONCE, here, rather than on each of the three boards: they count
        the same thing over the same set, so three copies of one sentence is not a caveat.
        The section is absent entirely on an index built without the cast tables, which is
        the same rule every other section on this page follows for a thing it cannot draw.
      */}
      {boards.length > 0 && (
        <Section
          heading="People"
          blurb="Who turns up most across the two finderr Top 250 lists above -- the ranked head of the index, not a career total."
        >
          <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <PeopleLeaderboard key={board.id} board={board} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

/** A heading, its blurb, and whatever the section lays out under it. */
function Section({ heading, blurb, children }: { heading: string; blurb?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="mb-1 text-sm font-semibold tracking-tight">{heading}</h3>
      {blurb && <p className="mb-3 max-w-2xl text-xs text-muted">{blurb}</p>}
      {children}
    </section>
  );
}

/**
 * The grid of link cards.
 *
 * Split out of `Section` when the people boards arrived: they are a section of this page
 * with a heading and a blurb like any other, and they are emphatically not a `ul` of cards.
 */
function CardGrid({ children }: { children: ReactNode }) {
  return <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>;
}

/**
 * A few posters of what a curated list holds, drawn inside its link.
 *
 * `aria-hidden`, and that is the correct answer rather than a shortcut: the strip sits
 * INSIDE the row's link, which already names the award it goes to, so five film titles read
 * out after it would bury the destination. It is decoration for a link that is already
 * labelled -- and being inside the link is also why no poster here is a link of its own.
 *
 * Nothing at all until the payload lands, and nothing ever for an award we hold no artwork
 * for. There is no placeholder row: `Poster` reserves its own frame, so a strip that appears
 * one beat later grows the card downward and moves nothing above it.
 */
function PosterStrip({ posters }: { posters?: ListPoster[] }) {
  if (!posters || posters.length === 0) return null;
  return (
    // A `div` rather than a `span`: `Poster` draws a `div`, and an `a` is transparent
    // content, so this is valid inside the row's link where a span wrapping a div is not.
    <div className="mt-2 flex gap-1.5" aria-hidden="true">
      {posters.map((poster) => (
        <Poster
          key={poster.tconst}
          title={poster}
          // Matched to the rendered width: a 40px frame has no use for a 342px image.
          size="w92"
          className="aspect-2/3 w-10 shrink-0 overflow-hidden rounded bg-surface-2"
        />
      ))}
    </div>
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
  params,
  search,
  children,
}: {
  title: string;
  subtitle?: string;
  to: "/browse" | "/awards/$award";
  /** The award id, for a curated row. A computed row's destination takes no parameters. */
  params?: { award: string };
  search?: SearchParams;
  children?: ReactNode;
}) {
  return (
    <li>
      <Link
        to={to}
        params={params ?? {}}
        search={search ?? {}}
        className="block rounded-lg border border-line px-3 py-2 transition-colors hover:border-accent/60"
      >
        <span className="text-sm">{title}</span>
        {subtitle && <span className="mt-0.5 block text-xs text-muted">{subtitle}</span>}
        {/*
          THE SLOT IS A BLOCK, and that is a fix rather than a wrapper.

          `Completion` is `inline-flex` and carried its own top margin, which a subtitle above
          it made look right -- a margin puts space above a line that is already its own line.
          On the nineteen genre and decade rows, which have NO subtitle, it flowed straight on
          from the name: "Best Actionyou own 66 of 250 top-ranked films", on every one of them.
          Found in a browser; no assertion about either component could have caught it, because
          each was correct and it was their composition that was not.
        */}
        {children && <div>{children}</div>}
      </Link>
    </li>
  );
}
