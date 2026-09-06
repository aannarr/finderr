/**
 * `/awards/oscars/people` -- which PEOPLE the nomination table describes.
 *
 * The table already answers "who was nominated for this film" from four directions; this is
 * the one question it was never asked, and it is one `group by` away: the same rows read down
 * the nconst column instead of across it.
 *
 * A STATIC segment beside `/awards/$award/$ceremony`, which the router resolves first, so
 * `people` can never be read as an edition key. `?class=Acting` narrows every board to one of
 * the source's own coarse classes and lives in the URL because it is part of what the page
 * MEANS -- "most nominated" and "most nominated actor" are two different lists, and only one
 * of them should come back when the link is opened again.
 *
 * Local SQLite the whole way down, like the timeline and the ceremony page: the server counts
 * imported rows and asks no provider, so there is no polling here, no skeleton and no `work`
 * to watch. The boards themselves are `PeopleLeaderboard`, which knows nothing about awards --
 * a second ranking source is a payload, not a second page.
 */

import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AwardSourceLine } from "../components/Awards";
import { ToggleChip } from "../components/Chip";
import { PeopleLeaderboard } from "../components/PeopleLeaderboard";
import { useChipGroup } from "../components/RovingFocus";
import { type AwardPeople, cachedAwardPeople, getAwardPeople } from "../lib/api";
import { prettyCategory } from "../lib/awards-format";

export function AwardPeopleRoute() {
  const { award } = useParams({ strict: false }) as { award: string };
  const { class: className } = useSearch({ strict: false }) as { class?: string };
  const navigate = useNavigate();

  const asked = className ?? null;
  const [page, setPage] = useState<AwardPeople | null>(() => cachedAwardPeople(award, asked) ?? null);
  const [error, setError] = useState<string | null>(null);

  // Seeded during render for the same reason `AwardsRoute` and `CeremonyRoute` are: switching
  // class must not draw the previous class's boards under the new chip for a frame.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seed = `${award}/${asked ?? ""}`;
  if (seededFor !== seed) {
    setSeededFor(seed);
    setPage(cachedAwardPeople(award, asked) ?? null);
    setError(null);
  }

  useEffect(() => {
    if (cachedAwardPeople(award, asked)) return;
    let stale = false;
    getAwardPeople(award, asked)
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [award, asked]);

  /*
    Eight classes is eight tab stops between the heading and the first board, so the row is
    ONE stop and ← → move within it -- the same trade the person page's role row takes, and
    for the same reason it declines `selectionFollowsFocus`: each chip is a navigate, and a
    history entry per arrow press turns eight classes into eight presses of Back.
  */
  const classChips = useChipGroup();

  if (error) {
    return (
      <p className="py-16 text-center text-muted">
        {error === "unknown award or class" ? "We hold no leaderboard under that name." : error}{" "}
        <Link to="/awards/$award" params={{ award }} className="underline hover:text-ink">
          Back to the timeline
        </Link>
      </p>
    );
  }

  // No skeleton, for the same reason the timeline has none: one local query is either here or
  // a frame away, and a skeleton for that is a flash rather than a reassurance.
  if (!page) return null;

  const showClass = (next: string | null) =>
    navigate({ to: "/awards/$award/people", params: { award }, search: next ? { class: next } : {} });

  return (
    <>
      <header className="mb-4">
        <p className="mb-1 text-xs text-muted">
          <Link
            to="/awards/$award"
            params={{ award: page.award.id }}
            className="underline-offset-2 hover:text-ink hover:underline"
          >
            ← {page.award.title}
          </Link>
        </p>
        <h2 className="text-xl font-semibold tracking-tight">Most nominated</h2>
        <p className="mt-1 max-w-prose text-xs text-muted">
          The same nominations the {page.award.editionMany} are built from, counted by person instead of by{" "}
          {page.award.editionOne}. Every name goes to their own page.
        </p>
      </header>

      {/*
        Only worth a filter when there is more than one class to filter BETWEEN -- a lone chip
        beside "All" is two spellings of the same list. The classes come from the server, so a
        class this award never uses is never offered.
      */}
      {page.classes.length > 1 && (
        /* biome-ignore lint/a11y/useSemanticElements: the rule's suggested <fieldset> is for form
           fields and there is no form here -- these chips narrow the boards below rather than
           carrying a value anything submits. The person page's role row declines the same. */
        <div
          role="group"
          aria-label="Narrow to one class of award"
          ref={classChips.ref}
          onKeyDown={classChips.onKeyDown}
          className="mb-2 flex flex-wrap gap-1.5"
        >
          <ToggleChip label="All" active={page.className === null} onClick={() => showClass(null)} />
          {page.classes.map((c) => (
            <ToggleChip
              key={c.className}
              /*
                The source's own word for the group, which is already readable -- unlike a
                stored CATEGORY, which is shouted. `prettyCategory` runs anyway so a class
                added upstream in the shouted style is not the one chip that yells.
              */
              label={prettyCategory(c.className)}
              count={c.people}
              active={page.className === c.className}
              onClick={() => showClass(c.className)}
            />
          ))}
        </div>
      )}

      {/*
        Boards the server found nobody for never arrive, so an empty page here means the award
        names no people at all -- which is the true state of a winner-only Wikidata list, and
        is worth saying rather than drawing three blank headings.
      */}
      {page.boards.length === 0 ? (
        <p className="py-16 text-center text-muted">
          This award's rows name films rather than people, so there is nobody to rank.
        </p>
      ) : (
        page.boards.map((board) => <PeopleLeaderboard key={board.id} board={board} />)
      )}

      <AwardSourceLine source={page.source} className="mt-8" />
    </>
  );
}
