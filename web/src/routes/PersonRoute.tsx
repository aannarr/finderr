/**
 * One person, and everything we hold them credited on.
 *
 * The card's structural insight, taken literally: a person page, a genre page and a
 * browse page are the same filtered grid with a different header and a different loader.
 * So this route owns the header and the category filter, and hands the rows to the very
 * same `TitleGrid` search and browse use -- which is what makes a filmography render with
 * posters, library state and a working Request button for free.
 *
 * Local SQLite the whole way down. `/api/person/:nconst` reads the reverse index and asks
 * no provider, so this page is as fast as search and stays on the right side of the
 * governing rule.
 */

import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { NominationRow } from "../components/Awards";
import { ToggleChip } from "../components/Chip";
import { Pane } from "../components/FacetPane";
import { useKeyAction } from "../components/Kbd";
import { TitleGrid } from "../components/TitleGrid";
import { PERSON_LINK_CLASS } from "../components/TitlePanes";
import {
  type Collaborator,
  cachedPerson,
  getPerson,
  type PersonAwards,
  type PersonPage,
  subscribeTitleState,
  titleStateVersion,
} from "../lib/api";
import { prettyCategory } from "../lib/awards-format";
import { creditLabels, mergedCategories } from "../lib/credits";
import type { SearchParams } from "../lib/search-params";

const PAGE = 60;

/**
 * "Nominated 8 times, won 2" -- and every nomination behind a disclosure.
 *
 * `null` for nearly everybody, which renders as nothing rather than "0 nominations". The
 * summary line is always visible because it is the fact worth knowing; the list is behind
 * a `<details>` because John Williams has 54 of them and that is a page of its own sitting
 * on top of a filmography.
 *
 * No skeleton and no polling: awards arrive with the person payload from local SQLite, so
 * this is complete the moment the page paints. It is not a facet and must not be routed
 * through `paneView`.
 */
function PersonAwardsSummary({ awards }: { awards: PersonAwards | null }) {
  if (!awards || awards.nominations === 0) return null;

  return (
    <details className="group mt-1.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-ink">
        <span className="text-accent">★</span>
        <span className="tabular-nums">
          Nominated {awards.nominations} time{awards.nominations === 1 ? "" : "s"}
          {awards.wins > 0 && `, won ${awards.wins}`}
        </span>
        <span className="text-muted/60 transition-transform group-open:rotate-90" aria-hidden="true">
          ›
        </span>
      </summary>

      <ol className="mt-2 border-l border-line pl-3">
        {awards.entries.map((e) => (
          <NominationRow
            // Ceremony plus category is not unique on its own -- a songwriter can hold two
            // nominations in one category at one ceremony -- so the film joins the key.
            key={`${e.ceremony}-${e.category}-${e.films.map((f) => f.tconst ?? f.title).join("|")}`}
            won={e.won}
            detail={e.detail}
            subject={e.films.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: source order, never reordered
              <span key={`${f.tconst ?? f.title}-${i}`}>
                {i > 0 && " · "}
                {/*
                  No `titles` map on this payload, so a film links on having an id
                  rather than on our holding a row. The person page already accepts
                  that trade for its own credits -- a 404 on a click is a worse
                  outcome than plain text, but a far better one than a wrong page,
                  and the id came from the source rather than from a name match.
                */}
                {f.tconst ? (
                  <Link
                    to="/title/$tconst"
                    params={{ tconst: f.tconst }}
                    className="underline-offset-2 hover:text-accent hover:underline"
                  >
                    {f.title}
                  </Link>
                ) : (
                  f.title
                )}
              </span>
            ))}
            credit={
              <Link
                to="/awards/$award/$ceremony"
                params={{ award: awards.award, ceremony: String(e.ceremony) }}
                className="underline-offset-2 hover:text-accent hover:underline"
              >
                {prettyCategory(e.category)}, {e.year}
              </Link>
            }
          />
        ))}
      </ol>
    </details>
  );
}

/**
 * The people they keep working with, each one a page of their own.
 *
 * The cheapest edge on the discovery graph and the only one that costs no provider: it is
 * the credits table read the other way round, so it renders on the same local-SQLite terms
 * as the filmography above it.
 *
 * **Nothing at all when there is nobody to name.** The server admits a collaborator only
 * from the second shared title on, so a person with no repeat gets an empty list here and
 * this draws no heading -- the same failure a collection pane was filed for when it headed
 * an empty row. A pane is not an obligation to fill.
 *
 * Not a facet, not a provider, no skeleton: it arrives complete with the person payload,
 * so it is on the same footing as the awards summary above and must not be routed through
 * `paneView`.
 */
function CollaboratorsPane({ collaborators }: { collaborators: Collaborator[] }) {
  if (collaborators.length === 0) return null;

  return (
    <Pane heading="Frequently works with">
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {collaborators.map((c) => (
          <li key={c.nconst} className="leading-tight">
            <Link
              to="/person/$nconst"
              params={{ nconst: c.nconst }}
              search={{}}
              className={PERSON_LINK_CLASS}
            >
              {c.name}
            </Link>{" "}
            <span className="text-xs text-muted">
              {/* Their job on the shared work, which is what tells a reader whether this
                  is a co-star or the director who keeps casting them. */}
              {creditLabels(c.categories).join(" · ")}
              {" · "}
              <span className="tabular-nums">
                {c.shared} title{c.shared === 1 ? "" : "s"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Pane>
  );
}

/** "1974-2019", "1974-", or nothing at all. */
function lifespan(person: PersonPage["person"]): string | null {
  if (person.birthYear === null && person.deathYear === null) return null;
  if (person.deathYear !== null) return `${person.birthYear ?? "?"}-${person.deathYear}`;
  return String(person.birthYear);
}

export function PersonRoute() {
  const { nconst } = useParams({ strict: false }) as { nconst: string };
  const { role, sort } = useSearch({ strict: false }) as Pick<SearchParams, "role" | "sort">;
  const navigate = useNavigate();
  // `sort` is shared with browse, which spells its own non-default `rank`. Only `year`
  // means anything here, so anything else reads as the votes default rather than as an
  // ordering this page cannot produce.
  const byYear = sort === "year" ? "year" : undefined;

  const [page, setPage] = useState<PersonPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  // Seeded during render for the same reason BrowseRoute is: this route unmounts every
  // time you open a title from the filmography, and a null initial state would blank the
  // page on the way back.
  const requestKey = `${nconst}|${role ?? ""}|${byYear ?? ""}`;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== requestKey) {
    setSeededFor(requestKey);
    setPage(cachedPerson(nconst, { category: role, sort: byYear, limit: PAGE, offset: 0 }) ?? null);
    setError(null);
  }

  useEffect(() => {
    if (cachedPerson(nconst, { category: role, sort: byYear, limit: PAGE, offset: 0 })) return;

    let stale = false;
    setLoading(true);
    getPerson(nconst, { category: role, sort: byYear, limit: PAGE, offset: 0 })
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [nconst, role, byYear]);

  const loadMore = async () => {
    if (!page) return;
    setLoading(true);
    try {
      const next = await getPerson(nconst, {
        category: role,
        sort: byYear,
        limit: PAGE,
        offset: page.credits.length,
      });
      setPage({ ...next, credits: [...page.credits, ...next.credits] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // A person page's one page-level action is the same one a browse grid has, so it wears
  // the same key. Bound before the early returns below, because hooks must be.
  const loadMoreKey = useKeyAction(
    "loadMore",
    () => void loadMore(),
    Boolean(page) && !loading && (page?.credits.length ?? 0) < (page?.total ?? 0),
  );

  if (error) {
    return (
      <p className="py-16 text-center text-muted">
        {error === "unknown person" ? "We hold no one by that id." : error}{" "}
        <Link to="/" className="underline hover:text-ink">
          Back to search
        </Link>
      </p>
    );
  }

  // No skeleton: the whole page is one local query, so it is either here or it is a
  // frame away. A skeleton for a query this fast is a flash, not a reassurance.
  if (!page) return null;

  const years = lifespan(page.person);
  const roles = mergedCategories(page.categories);

  return (
    <>
      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">{page.person.name}</h2>
        <p className="mt-0.5 text-xs text-muted">
          {years && <span className="tabular-nums">{years}</span>}
          {years && " · "}
          {page.total.toLocaleString()} {page.total === 1 ? "credit" : "credits"}
        </p>
        {/*
          Their award record, which is null for nearly everybody and therefore draws
          nothing at all. It sits in the header rather than under the grid because it is a
          fact ABOUT the person, like the lifespan beside it -- the grid below is what they
          were in, and this is what it got them.
        */}
        <PersonAwardsSummary awards={page.awards ?? null} />
      </div>

      {/*
        Only worth a filter when there is something to filter BETWEEN. One role means
        every chip is a no-op, and a control that cannot change anything is noise.
      */}
      {roles.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          <ToggleChip
            label="All"
            active={!role}
            onClick={() => navigate({ to: "/person/$nconst", params: { nconst }, search: { sort } })}
          />
          {roles.map((r) => {
            const value = r.values.join(",");
            return (
              <ToggleChip
                key={r.label}
                label={r.label}
                count={r.count}
                active={role === value}
                onClick={() =>
                  navigate({ to: "/person/$nconst", params: { nconst }, search: { role: value, sort } })
                }
              />
            );
          })}
        </div>
      )}

      {/*
        A SECOND row, under the roles rather than beside them, because the two chip groups
        answer different questions -- which credits, then in which order -- and one run-on
        row of chips reads as a single set where picking two would be a contradiction.

        Worth drawing only where there is something to reorder. One credit is the same list
        either way, so the control would be a no-op exactly like a lone role chip is.
      */}
      {page.total > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-xs text-muted">Sort</span>
          <ToggleChip
            label="Popular"
            active={!byYear}
            onClick={() => navigate({ to: "/person/$nconst", params: { nconst }, search: { role } })}
          />
          <ToggleChip
            label="Latest"
            active={Boolean(byYear)}
            onClick={() =>
              navigate({ to: "/person/$nconst", params: { nconst }, search: { role, sort: "year" } })
            }
          />
        </div>
      )}

      <TitleGrid titles={page.credits} />

      {page.credits.length < page.total && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            {...loadMoreKey.props}
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
          >
            {loading ? "Loading…" : `Show ${Math.min(PAGE, page.total - page.credits.length)} more`}
            {loadMoreKey.hint}
          </button>
        </div>
      )}

      {/*
        Under the grid and its control, where "more like this" sits on a title page: the
        filmography is what the reader came for, and this is where they go next.
      */}
      <CollaboratorsPane collaborators={page.collaborators ?? []} />
    </>
  );
}
