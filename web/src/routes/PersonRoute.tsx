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
import { PERSON_TILE_SIZE_CLASS, PersonPortrait } from "../components/PersonPortrait";
import { useChipGroup } from "../components/RovingFocus";
import { StaleResults, TitleGrid } from "../components/TitleGrid";
import { PERSON_LINK_CLASS } from "../components/TitlePanes";
import {
  type Collaborator,
  cachedPerson,
  cachedPersonRun,
  getPerson,
  type PersonAwards,
  type PersonPage,
  type PersonQuery,
  subscribeTitleState,
  titleStateVersion,
} from "../lib/api";
import { prettyCategory } from "../lib/awards-format";
import { creditLabels, mergedCategories, noteForFilmography } from "../lib/credits";
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

/**
 * Who this page is about: their face, their name, their span and their award record.
 *
 * A COMPONENT rather than markup inline in the route, for the same reason the two panes
 * below are: it is the one part of this page that does not change when a role chip or a
 * sort chip is pressed, and naming it is what makes that visible in the route body.
 *
 * **The portrait is the same `PersonPortrait` a search tile and a cast tile draw**, at the
 * same size, so the face a reader clicked on is the face that greets them. Until this
 * shipped the page drew none at all, while the Open Graph card for the very same link
 * already carried one -- so sharing a person looked richer than opening them.
 *
 * Initials remain the ordinary fallback, and the tile keeps its footprint either way: the
 * header is one portrait beside text, so a person we hold no face for costs no more vertical
 * space than one we do.
 */
export function PersonHeader({
  person,
  image,
  total,
  awards,
}: Pick<PersonPage, "person" | "image" | "total" | "awards">) {
  const years = lifespan(person);

  return (
    <div className="mb-4 flex items-start gap-4">
      <div className={PERSON_TILE_SIZE_CLASS}>
        <PersonPortrait name={person.name} image={image ?? null} />
      </div>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">{person.name}</h2>
        <p className="mt-0.5 text-xs text-muted">
          {years && <span className="tabular-nums">{years}</span>}
          {years && " · "}
          {total.toLocaleString()} {total === 1 ? "credit" : "credits"}
        </p>
        {/*
          Their award record, which is null for nearly everybody and therefore draws
          nothing at all. It sits in the header rather than under the grid because it is a
          fact ABOUT the person, like the lifespan beside it -- the grid below is what they
          were in, and this is what it got them.
        */}
        <PersonAwardsSummary awards={awards ?? null} />
      </div>
    </div>
  );
}

/**
 * One filmography request, spelled once.
 *
 * The render-phase cache probe, the effect that fetches and "Show more" all ask the same
 * question with a different offset, and the cache is keyed on the answer -- so a fourth
 * copy of this object literal that forgot `sort` would silently serve the wrong page.
 */
function creditsQuery(role: string | undefined, sort: "year" | undefined, offset = 0): PersonQuery {
  return { category: role, sort, limit: PAGE, offset };
}

/**
 * The credits on screen, and the request that produced them.
 *
 * The key travels WITH the payload rather than in a second `useState`, because the whole
 * point is the window where the two disagree: while a newly chosen role is in flight the
 * grid still shows the PREVIOUS role's rows, and two independent states could report that
 * window inconsistently for a render.
 */
interface ShownCredits {
  key: string;
  page: PersonPage;
}

export function PersonRoute() {
  const { nconst } = useParams({ strict: false }) as { nconst: string };
  const { role, sort } = useSearch({ strict: false }) as Pick<SearchParams, "role" | "sort">;
  const navigate = useNavigate();
  // `sort` is shared with browse, which spells its own non-default `rank`. Only `year`
  // means anything here, so anything else reads as the votes default rather than as an
  // ordering this page cannot produce.
  const byYear = sort === "year" ? "year" : undefined;

  const [shown, setShown] = useState<ShownCredits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  /*
    Seeded during render for the same reason BrowseRoute is: this route unmounts every time
    you open a title from the filmography, and a null initial state would blank the page on
    the way back.

    > [!IMPORTANT] A new FILTER on the same person does NOT blank the page
    > Only a different PERSON does. Everything above the grid -- the name, the lifespan, the
    > award record, both chip rows -- is the same for every role and every order, so throwing
    > it away and rebuilding it is a full-page flash that says nothing, and it unmounts the
    > chip the reader just pressed, which takes their focus with it. The grid keeps the
    > previous role's rows and fades them until the next ones land.
  */
  const requestKey = `${nconst}|${role ?? ""}|${byYear ?? ""}`;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== requestKey) {
    setSeededFor(requestKey);
    setError(null);
    // EVERY cached page, not just the first. `loadMore` caches each fetch under its own
    // offset and appends into `shown`, so seeding from the offset-0 entry alone handed a
    // reader who had pressed "Show more" twice their first 60 rows back -- on a page whose
    // scroll was then restored against a document half the height it had been. See
    // `cachedPersonRun`, which carries the measurement.
    const cached = cachedPersonRun(nconst, { category: role, sort: byYear, limit: PAGE });
    if (cached) setShown({ key: requestKey, page: cached });
    else if (shown && shown.page.person.nconst !== nconst) setShown(null);
  }

  useEffect(() => {
    // Served from cache, so nothing is outstanding -- and saying so is not redundant. An
    // earlier request that this one overtook was marked stale by the cleanup below, so its
    // own `finally` declines to clear the flag, and without this line "Loading…" would
    // stick on a page that has already finished loading.
    if (cachedPerson(nconst, creditsQuery(role, byYear))) {
      setLoading(false);
      return;
    }

    let stale = false;
    setLoading(true);
    getPerson(nconst, creditsQuery(role, byYear))
      .then((p) => {
        if (!stale) setShown({ key: requestKey, page: p });
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
  }, [nconst, role, byYear, requestKey]);

  /** Is the grid below the answer to the question the chips currently say is being asked? */
  const showingCurrentCredits = shown !== null && shown.key === requestKey;

  const loadMore = async () => {
    // Only ever extends rows it can see. Mid-filter-change the grid still holds the previous
    // role's credits, and appending the next role's onto those makes one grid out of two
    // questions -- with an offset counted against the wrong total.
    if (!shown || !showingCurrentCredits) return;
    const held = shown.page.credits;
    setLoading(true);
    try {
      const next = await getPerson(nconst, creditsQuery(role, byYear, held.length));
      setShown({ key: requestKey, page: { ...next, credits: [...held, ...next.credits] } });
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
    showingCurrentCredits && !loading && shown.page.credits.length < shown.page.total,
  );

  /*
    A prolific person has a dozen roles, which is a dozen tab stops between their name and
    their filmography, so the role row is ONE stop and ← → move within it.

    > [!NOTE] STILL no `selectionFollowsFocus`, but the reason changed
    > It used to be that this route blanked itself while the filtered page loaded, so the
    > chip focus was sitting on was unmounted by its own selection and the row could be
    > entered and stepped through exactly once. That is fixed -- the page now keeps its
    > header and both chip rows -- and the remaining objection is the one the hook's own doc
    > gives for the refinement bar: choosing a role is a `navigate`, and a pushed history
    > entry per arrow press turns a dozen roles into a dozen presses of Back. The season
    > selector takes the prop because its steps are free and leave no history.
    >
    > Whether that trade is worth making is filed rather than settled here:
    > `should-the-person-page-s-role-row-take-selectionfollowsfocus`.
  */
  const roleChips = useChipGroup();

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

  // Nothing at all only for a person we hold NOTHING for yet -- no skeleton, because the
  // whole page is one local query and is either here or a frame away. A filter change on a
  // person already on screen never reaches this: `shown` still holds their last page.
  if (!shown) return null;
  const page = shown.page;

  const roles = mergedCategories(page.categories);
  /*
    What each card says this person did here -- the character, and the job only when the job
    tells two cards apart. `noteForFilmography` owns that rule and returns one of two
    module-level functions, so this is a STABLE reference and `TitleGrid`'s `memo` holds.

    It is handed the CREDITS rather than `roles`, and that is not an oversight: the role
    breakdown says Nolan holds three, while every card of his prints "Directing". Only the
    rows answer the question. See its docstring for what that costs.
  */
  const noteFor = noteForFilmography(page.credits);
  /** Both chip rows below go to the same place with a different question. */
  const showCredits = (search: Pick<SearchParams, "role" | "sort">) =>
    navigate({ to: "/person/$nconst", params: { nconst }, search });

  return (
    <>
      <PersonHeader person={page.person} image={page.image} total={page.total} awards={page.awards} />

      {/*
        Only worth a filter when there is something to filter BETWEEN. One role means
        every chip is a no-op, and a control that cannot change anything is noise.

        A named group, for the same reason the season row has one: ← and → act on the SET
        rather than on any one chip, and a screen reader is told so by the role rather than
        by each button. `group` and not `toolbar` because these chips filter the grid below
        them; the refinement bar is the toolbar of the search page.
      */}
      {roles.length > 1 && (
        /* biome-ignore lint/a11y/useSemanticElements: the rule's suggested <fieldset> is for form
           fields, and there is no form on this page -- these chips filter the grid rather than
           carrying a value anything submits. The season row declines the same suggestion. */
        <div
          role="group"
          aria-label="Filter credits by role"
          ref={roleChips.ref}
          onKeyDown={roleChips.onKeyDown}
          className="mb-2 flex flex-wrap gap-1.5"
        >
          <ToggleChip label="All" active={!role} onClick={() => showCredits({ sort })} />
          {roles.map((r) => {
            const value = r.values.join(",");
            return (
              <ToggleChip
                key={r.label}
                label={r.label}
                count={r.count}
                active={role === value}
                onClick={() => showCredits({ role: value, sort })}
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

        DELIBERATELY NOT a `useChipGroup`, unlike the role row above. Two chips is a
        two-key tab walk, and a roving group would trade that for a one-key walk plus a
        rule the reader has to learn -- that Tab now skips a chip they can see. The hook
        pays for itself over a dozen roles or nine seasons; over two it is a cost with no
        matching saving.
      */}
      {page.total > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-xs text-muted">Sort</span>
          <ToggleChip label="Popular" active={!byYear} onClick={() => showCredits({ role })} />
          <ToggleChip
            label="Latest"
            active={Boolean(byYear)}
            onClick={() => showCredits({ role, sort: "year" })}
          />
        </div>
      )}

      {/*
        The grid and its own control are the ONLY things a role or a sort changes, so they
        are the only things that fade while the next answer is in flight. Everything above
        stays put, which is what keeps focus on the chip that was just pressed.
      */}
      <StaleResults stale={!showingCurrentCredits}>
        <TitleGrid titles={page.credits} noteFor={noteFor} />

        {page.credits.length < page.total && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loading || !showingCurrentCredits}
              {...loadMoreKey.props}
              className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
            >
              {loading ? "Loading…" : `Show ${Math.min(PAGE, page.total - page.credits.length)} more`}
              {loadMoreKey.hint}
            </button>
          </div>
        )}
      </StaleResults>

      {/*
        Under the grid and its control, where "more like this" sits on a title page: the
        filmography is what the reader came for, and this is where they go next.
      */}
      <CollaboratorsPane collaborators={page.collaborators ?? []} />
    </>
  );
}
