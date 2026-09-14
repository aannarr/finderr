/**
 * A term that goes somewhere -- or the same term as plain text when it does not.
 *
 * THE ONE PLACE the dead-end rule is spent. A keyword, a service or a studio becomes a link
 * only once its page holds more than the title you are already looking at
 * (`isTermLinkable`), and every surface that draws a term asks HERE rather than re-deciding
 * for itself. That is what stops one chip row linking on a rule another row disagrees with.
 *
 * `terms` is what the server measured for THIS title (`/api/terms/:tconst`); a term missing
 * from it -- because the answer has not arrived yet, or because nothing else carries it --
 * renders as text. Text is the honest default here rather than a degraded one: it is
 * exactly what these chips were before this card, and a link that lands on a grid holding
 * one film is worse than a word.
 */

import { Link } from "@tanstack/react-router";
import { isTermLinkable, MIN_TERM_TITLES, type TermDimension } from "../../../src/lib/terms";
import type { Place, Term } from "../lib/api";
import { CHIP_PILL, InertChip } from "./Chip";

/**
 * The term for one raw value, out of what the server sent for this title.
 *
 * Matched on the FOLDED key rather than on the label, because the label is the corpus's
 * commonest spelling and the value in hand is whichever spelling this title's provider
 * used -- `Heist` here, `heist` in the count.
 */
export function findTerm(terms: readonly Term[] | undefined, dimension: TermDimension, key: string) {
  return terms?.find((t) => t.dimension === dimension && t.key === key);
}

export function TermChip({ term, label }: { term: Term | undefined; label: string }) {
  if (!term || !isTermLinkable(term)) return <InertChip label={label} />;
  return (
    <Link
      to="/term/$dimension/$value"
      params={{ dimension: term.dimension, value: term.key }}
      className={`${CHIP_PILL} hover:text-ink`}
      // The count IS the reassurance, and it is the same number the link was gated on --
      // so a reader hovering a chip learns why this one is a link and its neighbour is not.
      title={`${term.label} -- ${term.titles} titles we hold`}
    >
      {label}
    </Link>
  );
}

/**
 * A filming location, on the SAME rule: a link once we hold more than this one title for it.
 *
 * Its own component rather than a fifth term dimension, because a place is built into the
 * title index and goes to `/place/$id` -- but the threshold is `MIN_TERM_TITLES`, read from
 * the same constant, so a place and a keyword can never disagree about what counts as
 * somewhere to go. The count is the server's, measured at build time.
 *
 * A LINE OF TEXT, NOT A PILL. Keywords are one or two words; a place is often a whole name --
 * "Commodore Schuyler F. Heim Bridge" -- and in the 16rem rail a pill that long wraps into a
 * two-line blob. Read off a real browser on 2026-09-14. The link is told apart from plain text
 * by its underline, the same quiet treatment the title page's links row uses.
 */
export function PlaceLink({ place }: { place: Place }) {
  if (place.titles < MIN_TERM_TITLES) return <span className="text-ink">{place.label}</span>;
  return (
    <Link
      to="/place/$id"
      params={{ id: place.id }}
      className="text-ink underline decoration-line underline-offset-4 transition-colors hover:decoration-muted"
      title={`${place.label} -- ${place.titles} titles we hold`}
    >
      {place.label}
    </Link>
  );
}
