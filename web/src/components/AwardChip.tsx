import { Link } from "@tanstack/react-router";
import { awardById } from "../../../src/lib/award-registry";
import type { AwardMark } from "../lib/api";
import { editionLabel } from "../lib/awards-format";

/**
 * A title's top-prize win, as one line on its card.
 *
 * The award's NAME is resolved here rather than sent: the registry is already in the bundle
 * (`/lists` reads it), so a mark travels as `{ award, ceremony, year }` and the words come
 * from `awardById`. That is also what makes a fourth award a registry entry and nothing else.
 *
 * `warn` is the amber in the palette and is used here for its ONE remaining free meaning on a
 * card -- the accent green already means "in your library" and the muted grey is the year. A
 * mark drawn in muted grey is invisible, which would make the chip decoration; a rosette would
 * out-shout the poster. Gold at the card's own text size is the middle aannarr asked for.
 *
 * An award id the bundle does not know draws NOTHING. That happens for exactly one window: a
 * server deployed with a fourth award in its registry, answering a browser still holding the
 * previous bundle. Text with no name for its prize would be worse than no chip.
 */
export function AwardChip({ mark }: { mark: AwardMark }) {
  const def = awardById(mark.award);
  if (!def) return null;

  const edition = editionLabel(
    { title: def.title, editionKey: def.edition.key, editionOne: def.edition.one },
    mark.ceremony,
    mark.year,
  );

  return (
    <Link
      to="/awards/$award/$ceremony"
      params={{ award: mark.award, ceremony: String(mark.ceremony) }}
      // The visible words are the prize; the accessible name adds what it won and when, so
      // the chip is not a bare category read out of context. The visible text stays a prefix
      // of it, which is what keeps voice control able to address it by what is on screen.
      aria-label={`${def.anchorLabel} winner · ${edition}`}
      title={`${def.anchorLabel} winner · ${edition}`}
      className="inline-block max-w-full truncate align-bottom font-medium text-warn/90
                 outline-none hover:text-warn hover:underline focus-visible:underline"
    >
      {def.anchorLabel}
    </Link>
  );
}
