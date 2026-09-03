/**
 * The chip look, owned once.
 *
 * A chip that goes to the grid is `BrowseChip`; one that goes to a term page, or does not
 * go at all, is `TermChip`; a chip that goes nowhere at all is `InertChip`; one that
 * changes what you are looking at without leaving is `ToggleChip`; one that drops every
 * refinement at once is `ClearChip`. They must be visually identical minus the hover and
 * the pressed state, so the class lists live here rather than being re-typed in each --
 * two copies would drift the moment either is restyled.
 */

import type { KeyAction } from "./Kbd";

export const CHIP_PILL = "rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted";

/**
 * A chip with no destination.
 *
 * If it looks clickable it must land on results, so this one does not look clickable. It is
 * what `TermChip` falls back to for a term whose page would hold nothing but the title you
 * are already on -- and what every keyword chip was before term pages existed, when
 * `/browse` accepted genre, year, decade and kind and nothing else.
 */
export function InertChip({ label }: { label: string }) {
  return <span className={CHIP_PILL}>{label}</span>;
}

export interface ToggleChipProps {
  label: string;
  /** How many things are behind it -- results, episodes. Omitted where there is no count. */
  count?: number;
  active: boolean;
  onClick: () => void;
}

/**
 * A chip that narrows or switches the view under it, and says which one is chosen.
 *
 * `aria-pressed` rather than a link or a radio: nothing navigates, the URL does not
 * change, and a reader who cannot see the accent colour still gets told which chip is
 * the active one. Shared by the search refinement bar and the season selector, which are
 * the same control over different nouns -- a second copy would drift on the next restyle.
 */
export function ToggleChip({ label, count, active, onClick }: ToggleChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "shrink-0 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
        active
          ? "border-accent bg-accent text-black font-medium"
          : "border-line bg-surface text-muted hover:border-muted hover:text-ink",
      ].join(" ")}
    >
      {label}
      {count !== undefined && <span className="ml-1 tabular-nums opacity-60">{count}</span>}
    </button>
  );
}

/**
 * Drop every active refinement at once.
 *
 * The search refinement bar and the browse filter row are two spellings of one idea, and
 * both had -- or wanted -- their own escape hatch. One control, one look, and one key:
 * `esc` is bound wherever this is drawn, and the glyph it wears comes from that binding
 * rather than from a character typed here. Pass the `KeyAction` whose handler does the
 * clearing, so the button and the key cannot disagree about whether it is live.
 */
export function ClearChip({
  count,
  onClick,
  shortcut,
}: {
  /** How many refinements go away. The number IS the reassurance. */
  count: number;
  onClick: () => void;
  shortcut: KeyAction;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...shortcut.props}
      className="shrink-0 rounded-full border border-danger/50 bg-danger/10 px-2.5 py-1 text-xs whitespace-nowrap"
    >
      Clear {count}
      {shortcut.hint}
    </button>
  );
}
