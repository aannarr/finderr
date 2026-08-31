import type { Facets, Filters } from "../lib/api";
import { ClearChip, ToggleChip } from "./Chip";
import type { KeyAction } from "./Kbd";

/**
 * Refinement buttons derived from the result set.
 *
 * These do real work beyond narrowing: they EXPOSE the noise. A search for "hobbit"
 * surfaces 7 documentaries about the films, and one click on Adventure removes them.
 * A plain ranked list gives the user no way to say "not those".
 */

const KIND_LABEL: Record<string, string> = {
  movie: "Films",
  tvSeries: "Series",
  tvMiniSeries: "Mini-series",
  tvMovie: "TV films",
};

export function FacetBar({
  facets,
  active,
  onToggle,
  onClear,
  clearShortcut,
  activeCount,
}: {
  facets: Facets;
  active: Filters;
  onToggle: (patch: Filters) => void;
  onClear: () => void;
  /** The `esc` binding that runs `onClear`, so the button can wear its own key. */
  clearShortcut: KeyAction;
  activeCount: number;
}) {
  const hasAny =
    facets.genre.length > 0 || facets.decade.length > 0 || facets.kind.length > 0 || facets.year.length > 0;
  if (!hasAny) return null;

  return (
    <div className="mt-2.5 -mx-4 overflow-x-auto px-4 pb-1">
      <div className="flex items-center gap-1.5">
        {activeCount > 0 && <ClearChip count={activeCount} onClick={onClear} shortcut={clearShortcut} />}

        {/* Type first -- "did you mean the series or the film" is the single most
            common disambiguation, so it should be the closest to the cursor. */}
        {facets.kind.length > 1 &&
          facets.kind.map((k) => (
            <ToggleChip
              key={`k${k.value}`}
              label={KIND_LABEL[k.value] ?? k.value}
              count={k.count}
              active={active.kind === k.value}
              onClick={() => onToggle({ kind: k.value })}
            />
          ))}

        {facets.kind.length > 1 && facets.genre.length > 0 && <Divider />}

        {facets.genre.slice(0, 8).map((g) => (
          <ToggleChip
            key={`g${g.value}`}
            label={g.value}
            count={g.count}
            active={active.genre === g.value}
            onClick={() => onToggle({ genre: g.value })}
          />
        ))}

        {facets.decade.length > 1 && <Divider />}

        {facets.decade.length > 1 &&
          facets.decade
            .slice(0, 8)
            .map((d) => (
              <ToggleChip
                key={`d${d.value}`}
                label={`${d.value}s`}
                count={d.count}
                active={active.decade === d.value}
                onClick={() => onToggle({ decade: d.value })}
              />
            ))}
      </div>
    </div>
  );
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden="true" />;
}
