import { Link } from "@tanstack/react-router";
import type { Filters } from "../lib/api";
import { CHIP_PILL } from "./Chip";

/**
 * A facet value that goes somewhere.
 *
 * Genre, year and decade all land on the same `/browse` grid, so the link is built
 * in ONE place rather than re-typed at every call site. Callers say which filters
 * the chip stands for; the chip owns the destination and the look.
 *
 * `tone` is the only thing that varies: `pill` on the detail page, where a chip has
 * room to look like a chip, and `inline` in a card's dense meta line, where a pill
 * would out-shout the poster and the title.
 *
 * Every destination now lands somewhere real. `/api/browse` used to floor every result
 * set at 1000 votes, which made sparse filters -- pre-1913 cinema, an unreleased year,
 * a Reality-TV film -- dead-end on "Nothing matches that". A year or decade filter no
 * longer gets the floor at all, and where it still applies the empty state says how
 * many titles it hid and offers to show them.
 */
export function BrowseChip({
  filters,
  label,
  tone = "pill",
  sort,
}: {
  filters: Filters;
  label: string;
  tone?: "pill" | "inline";
  /**
   * Ask for the RANKED grid rather than the votes-ordered default.
   *
   * `rank` is browse's whole sort vocabulary (`BrowseRoute` narrows the shared `sort` key to
   * it), and it rides here rather than inside `filters` because it selects no rows -- the
   * same split `filtersOf` enforces on the URL. A chip standing for a facet VALUE wants the
   * default; one offering a whole shelf -- "best Crime in Swedish" -- has to say "best" in
   * the destination as well as on the label, or the link disagrees with its own text.
   */
  sort?: "rank";
}) {
  return (
    <Link
      to="/browse"
      search={sort ? { ...filters, sort } : filters}
      className={
        tone === "pill"
          ? `${CHIP_PILL} hover:text-ink`
          : "outline-none hover:text-ink hover:underline focus-visible:underline"
      }
    >
      {label}
    </Link>
  );
}
