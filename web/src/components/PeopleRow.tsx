/**
 * The people a search found, above the grid of titles it found.
 *
 * A ROW OF ITS OWN, never mixed into the grid. A person and a title are different nouns
 * with different cards and different destinations, and a reader scanning for "the Nolan
 * film" and a reader scanning for "Nolan" are asking two questions the page can answer at
 * once as long as it keeps them apart.
 *
 * **Nothing at all when there is nobody to draw** -- no heading, no empty row. The same
 * rule every pane in this tree follows, and the reason `SearchResponse.people` distinguishes
 * an absent key from an empty one: an index that cannot search people yet must look like a
 * search that found none, rather than like a broken row.
 */

import { Link } from "@tanstack/react-router";
import type { PersonHit } from "../lib/api";
import { PERSON_ROW_CLASS, PERSON_TILE_CLASS, PersonPortrait } from "./PersonPortrait";
import { PERSON_LINK_CLASS } from "./TitlePanes";

export function PeopleRow({ people }: { people: PersonHit[] }) {
  if (people.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-medium text-ink">People</h2>
      {/* A real ul/li, like the shelves: a row of people IS a list. */}
      <ul className={PERSON_ROW_CLASS}>
        {people.map((person) => (
          <li key={person.nconst} className={PERSON_TILE_CLASS}>
            {/* The portrait is part of the link, as on a cast tile: a face is the most
                clickable thing on a tile, and a name that navigates beside a picture that
                does not is an inconsistency people notice by feel. */}
            <Link
              to="/person/$nconst"
              params={{ nconst: person.nconst }}
              search={{}}
              className={`block ${PERSON_LINK_CLASS}`}
            >
              {/*
                A FACE WHEN WE HAVE ONE, INITIALS WHEN WE DO NOT, and the second is the
                ordinary case rather than a failure.

                This used to be a hardcoded `null`, on the correct-at-the-time grounds that
                every headshot finderr holds was cached against one TITLE's cast facet and
                keyed by the image URL, so nothing could answer "the face of nm0000093".
                `person_image` (`src/lib/store.ts`) is that missing edge: the title route
                already resolves credits to nconsts in the same breath as it rewrites their
                images, so the pair is filed there and read back here in one batched query.
                No provider call, no keystroke cost -- the point that argument turned on.

                Coverage therefore grows with the titles people open and is never complete.
                A person nobody's filmography has been visited through still draws initials.
              */}
              <PersonPortrait name={person.name} image={person.image ?? null} />
              <p className="mt-1.5 text-xs font-medium leading-tight text-ink">{person.name}</p>
            </Link>
            {/* What we hold for them, which is also what the row is ranked on beneath the
                popularity of their best-known title. It says "this link goes somewhere". */}
            <p className="text-xs leading-tight text-muted">
              {person.credits} title{person.credits === 1 ? "" : "s"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
