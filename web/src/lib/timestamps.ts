/**
 * Printing an INSTANT -- a stored ISO timestamp -- for a reader.
 *
 * > [!IMPORTANT] This is not a second owner of `formatCalendarDate`, it is the other half
 * > `formatCalendarDate` (`./facet-panes.ts`) prints a `YYYY-MM-DD` that upstream metadata
 * > states as a CALENDAR DATE: a cinema release, an air date. Those carry no time and no
 * > zone, so they are formatted as the plain date they already are and a reader in Bangkok
 * > and a reader in Berlin see the same day.
 * >
 * > Everything here is a MOMENT our own database stamped with `new Date().toISOString()`:
 * > when a request was made, when a session was last seen. It has to be rendered in the
 * > reader's own zone, so it is a different rounding of a different fact and merging the two
 * > would make one of them wrong. If a third caller ever needs "the day this instant fell
 * > on, in UTC", that is a THIRD question and it gets its own function.
 *
 * Every function takes an explicit `locale`, defaulting to the browser's. The default is
 * what the app wants and the argument is what the tests need: `Intl` with no locale follows
 * whatever machine is running, so an assertion on a formatted string is otherwise
 * machine-dependent.
 */

/** How far apart two instants have to be before the next unit up is the honest one. */
const AGE_UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 86_400_000 },
  { unit: "month", ms: 30 * 86_400_000 },
  { unit: "week", ms: 7 * 86_400_000 },
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
];

/**
 * A stored timestamp as a calendar date in the reader's zone -- "4 Sept 2026".
 *
 * `fallback` is what an absent stamp reads as, and it is a PARAMETER because the answer is
 * genuinely different per caller: a session that has never been used is "never", while an
 * empty cell in a table is "—". Three copies of this function existed with those two
 * fallbacks between them, which is exactly the difference a prop takes.
 *
 * An unparseable string returns the fallback too. `Intl` prints "Invalid Date" for one,
 * which is a bug report rendered as content.
 */
export function formatStamp(iso: string | null | undefined, fallback = "—", locale?: string): string {
  if (!iso) return fallback;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return fallback;
  return at.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The same instant as an AGE -- "3 days ago", "in 2 hours".
 *
 * The request log leads with this rather than with a date, because the question it answers
 * is "how long has this been sitting there", and a reader converts "2 Sept" into that
 * themselves every time. The exact stamp still rides along in a `title`, so nothing is
 * lost -- see `LogRoute`.
 *
 * `now` is a parameter rather than `Date.now()` so the rule is testable against a fixed
 * clock, the same shape `pollWhileWorking` uses. Under a minute is "just now": every unit
 * we have would print a number that is stale by the time it is read.
 */
export function formatAge(
  iso: string | null | undefined,
  now: Date = new Date(),
  locale?: string,
): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const delta = at.getTime() - now.getTime();
  const size = Math.abs(delta);
  if (size < 60_000) return "just now";
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const { unit, ms } of AGE_UNITS) {
    if (size >= ms) return fmt.format(Math.round(delta / ms), unit);
  }
  return "just now";
}
