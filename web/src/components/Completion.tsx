/**
 * "you own 14 of 38 films", with the bar that makes the ratio readable at a glance.
 *
 * The one number a thin proxy over TMDB structurally cannot answer, which is why it is
 * worth a component rather than a sentence -- it needs somebody's actual library, and it is
 * the same sentence whether the denominator is a ceremony's nominees or the top 250 horror
 * films. It lived in `Awards.tsx` until the list catalogue wanted it too; a second copy
 * spelling "of" and rounding a percentage its own way is exactly how two screens end up
 * disagreeing about what 99% means.
 *
 * A zero denominator renders NOTHING rather than "0 of 0": a ceremony whose films we cannot
 * identify, or a list with no ranked members, has no completion to report, and printing 0%
 * would read as a failure of the library rather than of the data.
 */

export function Completion({
  owned,
  total,
  noun,
  className = "",
}: {
  owned: number;
  total: number;
  noun: string;
  className?: string;
}) {
  if (total === 0) return null;
  const pct = Math.round((owned / total) * 100);
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="tabular-nums">
        you own {owned.toLocaleString()} of {total.toLocaleString()} {noun}
      </span>
      <span
        className="h-1 w-16 overflow-hidden rounded-full bg-surface-2"
        role="img"
        aria-label={`${pct}% of ${noun} in your library`}
      >
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
