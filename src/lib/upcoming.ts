/**
 * What is landing soon, gathered from the three sources that know a real DATE.
 *
 * The `upcoming` table in `store.ts` is the mirror; this file is its writers and the pure
 * rules that decide what goes in it. Nothing here runs on the render path -- a shelf reads
 * the table, and the table is filled on a timer, which is the whole reason a shelf about
 * the future can exist without a handler ever blocking on a network call.
 *
 * WHY A MIRROR AT ALL. The IMDb dumps carry a release YEAR and nothing finer. On
 * 2026-08-31 the shelf that read them ranked five films that had been in cinemas for
 * months at the top of "Coming soon", and it could not have done otherwise: it ordered by
 * `numVotes`, and a vote count is itself a measure of how long a title has been out. There
 * is no column to add. A date has to come from outside the corpus.
 *
 * WHO KNOWS WHAT, and what each costs:
 *
 *   radarr / sonarr  their own /api/v3/calendar. LAN, free, and already keyed on the IMDb
 *                    id everything here uses, so there is no crosswalk. These answer "what
 *                    that I already follow is landing", which is a question TMDB cannot
 *                    answer at all.
 *   tmdb             /discover, for titles nobody here has asked for yet. Costs a key, a
 *                    call per region per kind, and one /external_ids per title ever.
 *
 * A title with no row in our own index is DROPPED rather than rendered as a bare string:
 * a card is built from an index row, so a title we cannot draw is a title we do not claim.
 * Measured 2026-08-31: 42 of 43 from Radarr, 27 of 27 from Sonarr, 38 of 41 from TMDB.
 */

import type { RadarrCalendarEntry, RadarrClient, SonarrCalendarEntry, SonarrClient } from "./arr";
import type { Store, UpcomingRow } from "./store";
import type { TmdbApi } from "./tmdb-api";

/** How far ahead each source is asked. Films move slowly; an episode airs this week. */
export const RADARR_WINDOW_DAYS = 90;
export const SONARR_WINDOW_DAYS = 14;

/** How many TMDB pages per region per kind. One page is 20 titles, which fills a shelf. */
export const TMDB_PAGES = 1;

/** `2026-11-18T00:00:00Z` and `2026-11-18` both arrive; the table stores the second. */
export function toCalendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** `today` and `today + days`, as the plain dates both arrs expect. */
export function calendarWindow(days: number, now: Date): { start: string; end: string } {
  const end = new Date(now.getTime() + days * 86_400_000);
  return { start: now.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/**
 * The soonest of several dates that has not already happened, or null if none has not.
 *
 * THIS IS THE RULE THE WHOLE FILE TURNS ON, and getting it wrong is how the old shelf
 * lied. Radarr hands back three dates and any of them may be historic: a 1986 film is on
 * next week's calendar because of a physical re-release. Taking the first non-null date
 * would put 1986 on a shelf called "Releasing soon"; taking the earliest would do the
 * same. Only "earliest one still ahead of us" is the date such a row is actually about.
 *
 * `today` counts as future -- a film released this morning is still today's news.
 */
export function soonestFutureDate(
  candidates: readonly (readonly [kind: UpcomingRow["date_kind"], value: string | null | undefined])[],
  today: string,
): { date: string; date_kind: UpcomingRow["date_kind"] } | null {
  let best: { date: string; date_kind: UpcomingRow["date_kind"] } | null = null;
  for (const [kind, raw] of candidates) {
    const date = toCalendarDate(raw);
    if (!date || date < today) continue;
    if (!best || date < best.date) best = { date, date_kind: kind };
  }
  return best;
}

/**
 * Radarr's calendar, as mirror rows.
 *
 * Pure and separate from the fetch so the date rule above is tested against the awkward
 * real entries (a 1986 cinema date beside a 2026 digital one) without a live server.
 */
export function radarrUpcomingRows(entries: RadarrCalendarEntry[], today: string): UpcomingRow[] {
  const rows: UpcomingRow[] = [];
  for (const e of entries) {
    const tconst = e.imdbId?.trim();
    if (!tconst) continue;
    const when = soonestFutureDate(
      [
        ["cinemas", e.inCinemas],
        ["digital", e.digitalRelease],
        ["physical", e.physicalRelease],
      ],
      today,
    );
    if (!when) continue;
    rows.push({ tconst, kind: "movie", source: "radarr", detail: null, ...when });
  }
  return dedupeSoonest(rows);
}

/**
 * Sonarr's calendar, collapsed to ONE ROW PER SERIES carrying its next episode.
 *
 * The calendar is episode-shaped and this table is title-shaped. A show airing four
 * episodes in the window is one card, not four, and the card should say which episode is
 * next -- so the collapse keeps the EARLIEST episode and labels it. Doing it here rather
 * than in the shelf query is what keeps every shelf a plain ordered select.
 */
export function sonarrUpcomingRows(entries: SonarrCalendarEntry[], today: string): UpcomingRow[] {
  const rows: UpcomingRow[] = [];
  for (const e of entries) {
    const tconst = e.series?.imdbId?.trim();
    if (!tconst) continue;
    const when = soonestFutureDate([["airDate", e.airDate]], today);
    if (!when) continue;
    rows.push({ tconst, kind: "series", source: "sonarr", detail: episodeLabel(e), ...when });
  }
  return dedupeSoonest(rows);
}

/** `S2E9`, or null when Sonarr sent an entry without numbers on it. */
function episodeLabel(e: SonarrCalendarEntry): string | null {
  if (e.seasonNumber === undefined || e.episodeNumber === undefined) return null;
  return `S${e.seasonNumber}E${e.episodeNumber}`;
}

/**
 * One row per title, keeping the soonest.
 *
 * The table's primary key would silently keep whichever row was inserted LAST, which for
 * a series airing three times in a fortnight is an arbitrary episode. Deciding it here
 * makes the choice a rule rather than an insertion-order accident -- the same reason
 * `mergeRatings` ranks on content rather than on which call returned first.
 */
function dedupeSoonest(rows: UpcomingRow[]): UpcomingRow[] {
  const best = new Map<string, UpcomingRow>();
  for (const row of rows) {
    const seen = best.get(row.tconst);
    if (!seen || row.date < seen.date) best.set(row.tconst, row);
  }
  return [...best.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Only titles our own index can draw a card for. */
function renderable(rows: UpcomingRow[], hasRow: (tconst: string) => boolean): UpcomingRow[] {
  return rows.filter((r) => hasRow(r.tconst));
}

export interface SyncDeps {
  store: Store;
  /** The index says whether a card can be drawn at all. */
  hasRow: (tconst: string) => boolean;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface SyncResult {
  source: string;
  rows: number;
}

/**
 * Mirror both arr calendars.
 *
 * Each arr writes its OWN source and a throw is never caught into an empty write: a
 * failed walk must leave the previous rows standing, exactly as `syncPlex` does, because
 * an emptied shelf looks like "nothing is coming" rather than like a broken sync.
 */
export async function syncArrCalendars(
  deps: SyncDeps,
  clients: { radarr?: RadarrClient; sonarr?: SonarrClient },
): Promise<SyncResult[]> {
  const now = deps.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const out: SyncResult[] = [];

  if (clients.radarr) {
    const w = calendarWindow(RADARR_WINDOW_DAYS, now);
    const entries = (await clients.radarr.calendar(w.start, w.end)) ?? [];
    const rows = renderable(radarrUpcomingRows(entries, today), deps.hasRow);
    out.push({ source: "radarr", rows: deps.store.replaceUpcoming("radarr", rows) });
  }

  if (clients.sonarr) {
    const w = calendarWindow(SONARR_WINDOW_DAYS, now);
    const entries = (await clients.sonarr.calendar(w.start, w.end)) ?? [];
    const rows = renderable(sonarrUpcomingRows(entries, today), deps.hasRow);
    out.push({ source: "sonarr", rows: deps.store.replaceUpcoming("sonarr", rows) });
  }

  return out;
}

/** The kv prefix under which a tmdbId -> tconst answer is parked forever. */
const XWALK_PREFIX = "tmdb_imdb_";

/**
 * Mirror TMDB's upcoming lists for both kinds, across every configured region.
 *
 * REGIONS ARE A UNION. `/discover` scopes release dates to one country per call, so each
 * region is its own call and a title both regions return is one row. Measured 2026-08-31,
 * US and SE together answered 41 distinct films and differed by two of them, so a second
 * region is cheap and buys little here.
 *
 * The crosswalk is the only per-title cost and it is paid ONCE EVER: a TMDB id's IMDb id
 * cannot change, so the answer -- including a null one -- is parked in `kv`. Steady state
 * for a daily run is therefore the discover calls alone.
 */
export async function syncTmdbUpcoming(
  deps: SyncDeps,
  api: TmdbApi,
  regions: readonly string[],
): Promise<SyncResult[]> {
  const now = deps.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const out: SyncResult[] = [];

  for (const [media, source, kind] of [
    ["movie", "tmdb-movie", "movie"],
    ["tv", "tmdb-series", "series"],
  ] as const) {
    const rows: UpcomingRow[] = [];
    for (const region of regions) {
      for (let page = 1; page <= TMDB_PAGES; page++) {
        const answer = await api.discoverUpcoming(media, { region, after: today, page });
        for (const result of answer?.results ?? []) {
          const date = toCalendarDate(result.release_date ?? result.first_air_date);
          if (!date || date < today) continue;
          const tconst = await crosswalk(deps, api, result.id, media);
          if (!tconst) continue;
          rows.push({
            tconst,
            kind,
            source,
            date,
            date_kind: media === "tv" ? "airDate" : "cinemas",
            detail: null,
          });
        }
      }
    }
    const keep = renderable(dedupeSoonest(rows), deps.hasRow);
    out.push({ source, rows: deps.store.replaceUpcoming(source, keep) });
  }

  return out;
}

/**
 * A TMDB id's IMDb id, asked at most once ever.
 *
 * A null is cached as deliberately as a hit: four of twenty upcoming series simply have
 * no IMDb id at TMDB, and re-asking every night would be a call per title per day to
 * learn the same nothing.
 */
async function crosswalk(
  deps: SyncDeps,
  api: TmdbApi,
  tmdbId: number,
  media: "movie" | "tv",
): Promise<string | null> {
  const key = `${XWALK_PREFIX}${media}_${tmdbId}`;
  const cached = deps.store.getKv(key);
  if (cached !== null) return cached === "" ? null : cached;
  const imdb = await api.imdbIdOf(tmdbId, media);
  deps.store.setKv(key, imdb ?? "");
  return imdb;
}
