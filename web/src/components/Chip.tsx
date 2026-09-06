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
 * What a chip is SAYING, when it is saying something other than "here is a word".
 *
 * The admin screens need a pill that carries a verdict -- an administrator, a shut-out
 * account, an invitation about to expire -- and every one of those is the same pill wearing
 * a different colour. So this is a PROP on the chip that already exists rather than a second
 * badge component beside it; the registry's `badge` stays deliberately unadded for exactly
 * this reason (see `components/ui/button.tsx`).
 *
 * `neutral` is the shape every existing caller already had, so nothing on the title page,
 * the search bar or the season selector moves.
 */
export type ChipTone = "neutral" | "accent" | "danger" | "warn";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-surface-2 text-muted",
  // Tinted rather than filled: a solid accent pill is the ACTIVE state `ToggleChip` owns,
  // and a row of solid green "Administrator" badges would read as a row of live controls.
  accent: "bg-accent/15 text-accent",
  danger: "bg-danger/15 text-danger",
  warn: "bg-warn/15 text-warn",
};

/** The pill's geometry, without a colour. Both callers below build on it. */
const CHIP_SHAPE = "rounded-full px-2 py-0.5 text-xs";

export function chipTone(tone: ChipTone): string {
  return `${CHIP_SHAPE} ${CHIP_TONES[tone]}`;
}

/**
 * A chip with no destination.
 *
 * If it looks clickable it must land on results, so this one does not look clickable. It is
 * what `TermChip` falls back to for a term whose page would hold nothing but the title you
 * are already on -- and what every keyword chip was before term pages existed, when
 * `/browse` accepted genre, year, decade and kind and nothing else.
 */
export function InertChip({ label, tone = "neutral" }: { label: string; tone?: ChipTone }) {
  return <span className={chipTone(tone)}>{label}</span>;
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
