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
import type { Store, TrendingRow, UpcomingRow } from "./store";
import type { TmdbApi } from "./tmdb-api";

/** How far ahead each source is asked. Films move slowly; an episode airs this week. */
export const RADARR_WINDOW_DAYS = 90;
export const SONARR_WINDOW_DAYS = 14;

/**
 * How far BACK the Sonarr window reaches, and the whole reason it reaches back at all.
 *
 * "Do I have that episode?" is the question this shelf exists to answer, and Sonarr's
 * `hasFile` answers it for free on every calendar entry -- but for an episode that has not
 * aired yet it is `false` by definition and says nothing. It only carries information once
 * the episode is out. So the window includes the recent past, and the most useful row on
 * the shelf becomes "S2E9 aired Tuesday and you do NOT have it" rather than a list of
 * dates nobody can act on.
 *
 * FOUR days, aannarr 2026-08-31, after Last Week Tonight showed on "Airing soon" with an
 * episode from 23 August -- eight days old and plainly not soon. A week was too generous:
 * it is long enough to hold a whole broadcast cycle, so a weekly show that has not aired
 * yet this week still surfaces last week's episode. Four days keeps "the one that just
 * aired" and drops "the one from last week".
 */
export const SONARR_LOOKBACK_DAYS = 4;

/** How many TMDB pages per region per kind. One page is 20 titles, which fills a shelf. */
export const TMDB_PAGES = 1;

/** `2026-11-18T00:00:00Z` and `2026-11-18` both arrive; the table stores the second. */
export function toCalendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** `today - back` to `today + days`, as the plain dates both arrs expect. */
export function calendarWindow(days: number, now: Date, back = 0): { start: string; end: string } {
  const start = new Date(now.getTime() - back * 86_400_000);
  const end = new Date(now.getTime() + days * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Whole days between two plain dates, signed: negative is in the past. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
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
    /*
      A FILM WE ALREADY HOLD IS NOT RELEASING SOON, WHATEVER THE CALENDAR SAYS.

      aannarr caught this on the live shelf 2026-08-31: Supergirl and In the Grey were both
      on "Releasing soon" while sitting on disk. Radarr lists them because their PHYSICAL
      (disc) date falls in the window -- cinemas and digital are months past -- so the shelf
      was announcing a Blu-ray to somebody who already has the film. Two of five cards were
      noise.

      `hasFile` is the same fact the card already draws as "In library", so keeping these
      rows would have the shelf contradict the badge printed on it.
    */
    if (e.hasFile) continue;
    /*
      CINEMAS AND DIGITAL ONLY. THE DISC DATE IS NOT TRACKED.

      aannarr, 2026-08-31: track the cinema release, and the air date or streaming date for
      a series -- not the physical one. A disc pressing is not an event a reader of this
      shelf can act on, and it was the direct cause of the two worst rows on the live
      shelf: Supergirl and In the Grey both appeared MONTHS after they were watchable,
      purely because a Blu-ray was dated inside the window.

      `physicalRelease` is therefore read from Radarr and deliberately dropped. Both of the
      remaining kinds answer "when can I watch this": in cinemas, or at home.
    */
    const when = soonestFutureDate(
      [
        ["cinemas", e.inCinemas],
        ["digital", e.digitalRelease],
      ],
      today,
    );
    if (!when) continue;
    // A film has no episode, and Radarr's calendar says nothing about whether the file
    // has landed -- `library.has_file` already answers that for a title, and the card
    // draws it as "In library". Null here means "not a question this source answers".
    rows.push({
      tconst,
      kind: "movie",
      source: "radarr",
      detail: null,
      episode_title: null,
      has_file: null,
      ...when,
    });
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
export function sonarrUpcomingRows(
  entries: SonarrCalendarEntry[],
  today: string,
  window: { back?: number; ahead?: number } = {},
): UpcomingRow[] {
  /*
    THE WINDOW IS ENFORCED HERE, because Sonarr does not honour the one we asked for.

    Measured 2026-08-31: `?start=2026-08-24` came back carrying episodes dated 2026-08-23.
    Sonarr filters on `airDateUtc` while the entries report a local `airDate`, so the
    answer spills a day past both ends of the request. That is how Last Week Tonight put
    an episode from EIGHT days ago on a shelf with a four-day look-back -- the request was
    right and the answer simply ignored it.

    So the request bounds are a hint to the server and this is the actual rule. Anything
    that filters on a date must re-check it on the way in.
  */
  const back = window.back ?? SONARR_LOOKBACK_DAYS;
  const ahead = window.ahead ?? SONARR_WINDOW_DAYS;

  const rows: UpcomingRow[] = [];
  for (const e of entries) {
    const tconst = e.series?.imdbId?.trim();
    const date = toCalendarDate(e.airDate);
    if (!tconst || !date) continue;
    const offset = daysBetween(today, date);
    if (offset < -back || offset > ahead) continue;
    rows.push({
      tconst,
      kind: "series",
      source: "sonarr",
      date,
      date_kind: "airDate",
      detail: episodeLabel(e),
      episode_title: e.title?.trim() || null,
      // Sonarr always answers, so an absent field is "no" rather than "unknown".
      has_file: e.hasFile ? 1 : 0,
    });
  }
  return oneNearestNow(rows, today);
}

/**
 * One row per series: the episode CLOSEST TO NOW, past or future.
 *
 * Not "the next one to air", which is what this did while the window was future-only.
 * With a look-back the interesting row for a weekly show is usually the one that aired
 * two days ago and did NOT land -- picking the next one instead would show a date a week
 * out and a `has_file: 0` that means nothing, which is the shelf answering a question
 * nobody asked.
 *
 * Distance rather than "prefer the most recent aired": a show that finished its season
 * six days ago and returns tomorrow should say tomorrow. Ties go to the EARLIER date, so
 * an episode airing today beats one airing tomorrow and the shelf never skips over
 * something that has already happened.
 */
function oneNearestNow(rows: UpcomingRow[], today: string): UpcomingRow[] {
  const best = new Map<string, UpcomingRow>();
  for (const row of rows) {
    const seen = best.get(row.tconst);
    if (!seen) {
      best.set(row.tconst, row);
      continue;
    }
    const a = Math.abs(daysBetween(today, row.date));
    const b = Math.abs(daysBetween(today, seen.date));
    if (a < b || (a === b && row.date < seen.date)) best.set(row.tconst, row);
  }
  return [...best.values()].sort((a, b) => a.date.localeCompare(b.date));
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
    const w = calendarWindow(SONARR_WINDOW_DAYS, now, SONARR_LOOKBACK_DAYS);
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
            // TMDB is a discovery source: it answers what exists, never what we hold.
            episode_title: null,
            has_file: null,
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

/**
 * Mirror this week's trending list.
 *
 * IT LIVES HERE, BESIDE `syncTmdbUpcoming`, because it is the same shape of thing: an
 * external list mirrored on a timer so the render path stays local SQLite, crosswalked
 * through the same permanently-parked `tmdbId -> tconst` answers. Sharing `crosswalk` is
 * the point -- an upcoming film that later trends is already paid for.
 *
 * ONE CALL plus whatever crosswalks are not yet cached. TMDB's response ORDER is the
 * ranking and is preserved as `position`, counted over the rows we KEEP rather than over
 * the raw response, so a list with gaps in it still numbers 0..n-1.
 *
 * A THROW NEVER REACHES THE STORE, which is the rule every mirror in this tree follows.
 * `api.get` answers `null` on a non-200, and that is treated as a failure rather than as
 * an empty list: an emptied shelf and a broken sync look identical on screen, so the
 * previous week's list is left standing instead. A successful call that genuinely matches
 * nothing DOES clear the table, because that is a real answer.
 */
export async function syncTmdbTrending(deps: SyncDeps, api: TmdbApi): Promise<SyncResult> {
  const page = await api.trending("week");
  if (!page) throw new Error("tmdb trending: no answer");

  const rows: TrendingRow[] = [];
  for (const result of page.results ?? []) {
    // `media_type` is the only thing saying which id space this id belongs to, and
    // `/movie/{id}` and `/tv/{id}` collide happily. Anything else TMDB starts returning
    // here -- `person` is the one that exists today -- is not a title and is skipped.
    const media = result.media_type === "movie" ? "movie" : result.media_type === "tv" ? "tv" : null;
    if (!media) continue;
    const tconst = await crosswalk(deps, api, result.id, media);
    // Not in our index means no card can be drawn, the same filter `renderable` applies.
    if (!tconst || !deps.hasRow(tconst)) continue;
    rows.push({ tconst, kind: media === "tv" ? "series" : "movie", position: rows.length });
  }

  return { source: "tmdb-trending", rows: deps.store.replaceTrending(rows) };
}
