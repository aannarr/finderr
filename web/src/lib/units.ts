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
