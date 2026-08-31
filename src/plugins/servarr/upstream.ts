/**
 * How the two Servarr endpoints spell a date, and how we spell it back.
 *
 * Both `api.radarr.video` and `skyhook.sonarr.tv` are Servarr's own infrastructure and we
 * are an uninvited third party on it, so every call goes through the `c.fetch` core hands
 * a plugin -- that wrapper owns the honest User-Agent, the timeout, the https rule and the
 * per-host pacing. Asking for JSON is `getJson` in `src/lib/plugin-fetch.ts`, shared with
 * every other plugin. Nothing here re-implements any of it.
 *
 * These files are NOT plugins. The loader globs `*.ts` in `src/plugins/` and `Bun.Glob`'s
 * `*` does not cross a `/`, so a module in this subdirectory is never load-attempted.
 */

/**
 * `YYYY-MM-DD`, whichever of the two date spellings arrived.
 *
 * Radarr sends `2010-07-15T00:00:00Z` and skyhook sends `2010-12-05`. A facet consumer
 * should not have to know which upstream a date came from, so both are normalised here to
 * the shorter form -- these are calendar dates, and the time component Radarr sends is
 * always midnight UTC rather than a real instant.
 */
export function calendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match ? match[0] : null;
}

/** The earliest and latest of a set of dates, ignoring the ones that are missing. */
export function dateRange(dates: (string | null)[]): { first: string | null; last: string | null } {
  const known = dates.filter((d): d is string => d !== null).sort();
  return { first: known[0] ?? null, last: known.at(-1) ?? null };
}
