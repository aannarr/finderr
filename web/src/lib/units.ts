/**
 * Numbers a person reads, as opposed to numbers a machine stores.
 *
 * Sibling of `./timestamps.ts`, which does the same job for instants. Anything here has more
 * than one caller by the time it lands -- a formatter with one is better off next to the
 * markup that uses it.
 */

/**
 * A byte count, rounded to whatever precision the SCALE deserves.
 *
 * Two callers with two scales, which is what moved it out of `RequestOptions.tsx`: an arr
 * reports free space in terabytes and an operator choosing a disk wants "is there room", while
 * `/api/health` reports resident memory in hundreds of megabytes and "1 GB" for all of them is
 * the same answer to three different questions. One decimal at TB and GB, whole numbers below,
 * so nothing ever reads as more precise than it is.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/**
 * A count with its noun, pluralised. `count(1, "title")` -> `"1 title"`.
 *
 * The regular-English case only, and deliberately so: an irregular plural is the caller's to
 * spell out (`count(n, "person", "people")`), because a formatter that tried to know them all
 * would be a dictionary nobody can review.
 */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * How long something has been running, to ONE unit -- "2 hours", "41 seconds".
 *
 * Its own function rather than `formatAge` on a derived instant: that reads "Up 2 hours ago",
 * which is a different and slightly wrong sentence. One unit because the question is "has it
 * restarted recently", and "2 days, 4 hours and 11 minutes" answers it no better.
 *
 * Two callers with the same question about different lifetimes: the server process on
 * `/admin`, and one playback session in the player's stats panel.
 */
export function uptime(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) return count(Math.floor(seconds / size), name);
  }
  // Floored at zero: the session caller subtracts a SERVER stamp from the BROWSER's clock, so
  // a few seconds of skew would otherwise print "-3 seconds" on a session that just started.
  return count(Math.max(0, Math.round(seconds)), "second");
}
