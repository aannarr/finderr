/**
 * Sonarr / Radarr client.
 *
 * Native fetch, no axios. The important design decision is not in this file but in
 * how it is used: the library is MIRRORED into local SQLite on a timer, so the
 * question "do we already have this?" is answered from memory during a render and
 * never over the network. That single choice is most of the speed difference.
 */

import type { ArrService, ServarrService } from "./config";
import { streamResponseArray } from "./json-array-stream";

/** Every servarr finderr speaks to. Used for log lines and for `safeArrMessage`. */
export type ServarrName = "radarr" | "sonarr" | "prowlarr";

export interface ArrRootFolder {
  id: number;
  path: string;
  freeSpace?: number;
}

export interface ArrQualityProfile {
  id: number;
  name: string;
}

/**
 * What an arr already knows about the CONTENT of a file it imported.
 *
 * Both arrs run MediaInfo at import and serve the result, so finderr can decide a transcode
 * plan from its own six-hourly mirror rather than probing 1,175 files. Verified against the
 * live Radarr and Sonarr on 2026-09-08; every field is optional because the arr omits the
 * whole block for a file it imported before it scanned, and one absent codec must not lose
 * the path beside it.
 *
 * > [!IMPORTANT] `videoCodec` is the arr's RELEASE vocabulary, not ffmpeg's
 * > It says `x265` where ffprobe says `hevc`, and `h264` where ffprobe agrees. It is a
 * > normalised label rather than a stream codec name, so anything matching on it maps
 * > through one table -- and the authority for an actual playback decision is the ffprobe
 * > at click time, never this. This block is for deciding CHEAPLY and in bulk: which titles
 * > would need a transcode at all, what the library looks like, what to warn about.
 *
 * > [!WARNING] `subtitles` is a LANGUAGE list and never a format, and the difference is expensive
 * > `"eng"` does not say whether that track is SRT (converts to WebVTT for nothing) or PGS
 * > (a bitmap, which forces a full video transcode to burn in). Nothing here can tell you,
 * > which is exactly why the click-time probe still exists.
 */
export interface ArrMediaInfo {
  videoCodec?: string;
  videoBitDepth?: number;
  videoDynamicRange?: string;
  audioCodec?: string;
  audioChannels?: number;
  audioLanguages?: string;
  subtitles?: string;
  resolution?: string;
  runTime?: string;
}

/** A file an arr imported, as both arrs describe one. Same shape, two endpoints. */
export interface ArrFile {
  id: number;
  /** ABSOLUTE, as the ARR's container sees it. Never opened without `media-path.ts`. */
  path?: string;
  size?: number;
  mediaInfo?: ArrMediaInfo;
}

export interface RadarrMovie {
  id: number;
  title: string;
  year: number;
  tmdbId: number;
  imdbId?: string;
  hasFile: boolean;
  monitored: boolean;
  sizeOnDisk?: number;
  /**
   * The segment Radarr's own UI routes on -- `/movie/:titleSlug`.
   *
   * Radarr 6.x fills this with the tmdbId as a string ("700391"), which is NOT what the
   * name suggests and NOT what Sonarr does. Mirror it; never build it.
   */
  titleSlug?: string;
  /** The imported file, embedded in `/movie` at no extra cost. Absent when `hasFile` is false. */
  movieFile?: ArrFile;
}

export interface SonarrSeries {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  imdbId?: string;
  monitored: boolean;
  /** The segment Sonarr's UI routes on -- `/series/:titleSlug`, e.g. "preacher". */
  titleSlug?: string;
  statistics?: {
    episodeFileCount: number;
    episodeCount: number;
    percentOfEpisodes: number;
  };
}

/** One episode as Sonarr's `/episode?seriesId=` lists it. */
export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDate?: string | null;
  hasFile?: boolean;
  monitored?: boolean;
  /** Present only because `episodes()` asks for `includeEpisodeFile`. See that method. */
  episodeFile?: ArrFile;
}

/**
 * One entry from Radarr's calendar.
 *
 * All three dates are optional AND any of them may be in the past: Radarr lists a film
 * whose PHYSICAL release falls in the window even though it was in cinemas years ago.
 * Measured 2026-08-31 against the live server -- "The Golden Child" came back with
 * `inCinemas` in 1986 and `digitalRelease` next week.
 */
export interface RadarrCalendarEntry {
  title?: string;
  imdbId?: string;
  inCinemas?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
  /** Already on disk. A held film is dropped from the shelf -- see `radarrUpcomingRows`. */
  hasFile?: boolean;
}

/** One entry from Sonarr's calendar. `series` arrives only with `includeSeries=true`. */
export interface SonarrCalendarEntry {
  airDate?: string | null;
  seasonNumber?: number;
  episodeNumber?: number;
  /** The EPISODE's own name, e.g. "And the Toy Phone" -- not the series title. */
  title?: string;
  /**
   * Do we hold THIS episode? Present on every entry at no extra cost, and the reason the
   * Sonarr window looks backwards -- it says nothing about an episode that has not aired.
   */
  hasFile?: boolean;
  monitored?: boolean;
  series?: { title?: string; imdbId?: string };
}

export interface QueueItem {
  id: number;
  title: string;
  status: string;
  size: number;
  sizeleft: number;
  movieId?: number;
  seriesId?: number;
  errorMessage?: string;
  /**
   * When the arr expects this to finish, as an ISO instant.
   *
   * An INSTANT rather than the sibling `timeleft` duration, because the answer is read by a
   * browser up to a reconcile period after it was written: a duration would be stale by
   * however long the row sat in SQLite, while an instant stays correct as the clock moves.
   * Absent for a queued-but-not-started item, and free to be in the past for a stalled one.
   */
  estimatedCompletionTime?: string;
}

/**
 * One row of a Radarr or Sonarr history page.
 *
 * The two services agree on everything here and differ only in which id is populated,
 * which is the same shape `/queue` already has -- so one type serves both.
 *
 * > [!IMPORTANT] `quality.quality.name` is the ONE string from an arr this feature forwards
 * > It is a profile name Radarr shows in its own UI ("Bluray-1080p"), chosen from a closed
 * > list the operator configured, and it carries no path, no hostname and no free text.
 * > Everything else on this record -- `sourceTitle`, `data` -- is a release name or the
 * > arr's own prose and is NOT safe to forward. See `safeArrMessage`.
 */
export interface ArrHistoryRecord {
  /**
   * `grabbed`, `downloadFolderImported`, `downloadFailed`, ... Only the first is read here
   * -- see `ARR_GRAB_EVENT` in `../server/diagnose-requests.ts`.
   */
  eventType?: string;
  date?: string;
  movieId?: number;
  seriesId?: number;
  quality?: { quality?: { name?: string } };
}

/**
 * The one arr capability withdrawing a request needs: stop searching for a library item.
 *
 * Named as an interface rather than reached for as `RadarrClient | SonarrClient`, so the
 * withdraw policy depends on the one method it calls and nothing else -- and so a test hands
 * it an object literal that records what it was asked to do. Both clients satisfy it with
 * the same signature, which is what lets the caller pick a client and then stop caring which
 * one it picked.
 */
export interface ArrUnmonitor {
  /** `arrId` is the arr's OWN row id -- `RadarrMovie.id` / `SonarrSeries.id`. */
  unmonitor(arrId: number): Promise<unknown>;
}

/**
 * What the arr is holding on disk for one library item, in the three facts a confirmation
 * has to show before anything is deleted.
 *
 * Read LIVE rather than from the library mirror, and that is the point: the mirror answers
 * "is it here" (`has_file`) and deliberately carries no size, because a byte count changes
 * on every upgrade and nothing renders it. A confirmation that quoted a stale size would be
 * describing a different file from the one about to be removed.
 */
export interface ArrHoldings {
  /** Files the arr holds. 0 or 1 for a film; the episode file count for a series. */
  files: number;
  /** Total bytes on disk, or null when the arr reports none. */
  bytes: number | null;
  /**
   * The arr's own quality name, e.g. "Bluray-1080p", or null.
   *
   * Null for a SERIES and that is honest rather than missing: Sonarr holds one quality per
   * episode file and has no single answer for the series. Safe to forward for the reason
   * `ArrHistoryRecord` gives -- it is a profile name from a closed list the operator
   * configured, with no path and no free text in it.
   */
  quality: string | null;
}

/**
 * The two arr capabilities REMOVING media needs: look at what is there, then take it out.
 *
 * A separate interface from `ArrUnmonitor` rather than more methods on it, and the split is
 * the safety property. `withdrawRequest` depends on `ArrUnmonitor` and therefore CANNOT
 * reach a delete however it is edited later; `removeMedia` depends on this one and is the
 * only caller in the tree that can. Two names for two authorities, checked by the compiler
 * rather than remembered.
 */
export interface ArrRemoval {
  /** `arrId` is the arr's OWN row id. Null when the arr no longer holds that row. */
  holdings(arrId: number): Promise<ArrHoldings | null>;
  /**
   * Remove the library item. `deleteFiles` decides whether the files go with it -- the arr
   * forgets the title either way.
   */
  remove(arrId: number, opts: { deleteFiles: boolean }): Promise<unknown>;
}

export class ArrError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `${service} responded ${status}: ${body.slice(0, 300)}`);
    this.name = "ArrError";
  }
}

/**
 * What a USER may be told about a failed request.
 *
 * > [!CAUTION] An arr's own error text is not safe to forward
 * > `ArrError.message` embeds up to 300 bytes of the arr's response body, which routinely
 * > carries root folder paths (`/plex/movie`), internal hostnames and occasionally a
 * > stack. That string is stored on the request row and the row goes to the browser -- so
 * > before auth it leaked the shape of the NAS to anybody on the LAN, and once finderr is
 * > public it would leak it to the internet.
 *
 * The full message still reaches the LOG, which is where an operator debugging a failed
 * add should be looking. What comes back here is a short, closed vocabulary: enough for a
 * reader to know whether to retry, tell an admin, or give up.
 */
export function safeArrMessage(err: unknown): string {
  if (!(err instanceof ArrError)) return "the request could not be sent";
  if (err.status === 401 || err.status === 403) return `${err.service} rejected our credentials`;
  if (err.status === 404) return `${err.service} could not find that title`;
  if (err.status === 400 && /already|exist/i.test(err.body)) return `${err.service} already has that title`;
  if (err.status >= 500) return `${err.service} is having trouble -- try again shortly`;
  return `${err.service} refused the request (HTTP ${err.status})`;
}

/**
 * The HTTP half of talking to a *arr, with nothing media-specific in it.
 *
 * Split out from `ArrClient` when Prowlarr arrived. Every servarr shares this exact
 * transport -- `X-Api-Key`, JSON in and out, a void controller action answering 200 with a
 * zero-byte body -- and differs only in its API VERSION and in which endpoints exist. Two
 * copies of the empty-body handling would have been two places to relearn it.
 *
 * It stops here rather than growing `queue()` and friends because Prowlarr has neither a
 * queue nor a root folder: a subclass that inherits methods its service will 404 on forces
 * every caller to know which of them are real.
 */
export class ServarrHttp<S extends ServarrService = ServarrService> {
  constructor(
    protected readonly name: ServarrName,
    protected readonly svc: S,
    /** The path segment after `/api`. Radarr and Sonarr are v3; Prowlarr is v1. */
    private readonly apiVersion: string = "v3",
  ) {}

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(`/api/${this.apiVersion}${path}`, this.svc.url);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * The call itself, up to and including "did it fail". Split out from `request` so the
   * streaming reader below shares the URL, the credential and the failure vocabulary rather
   * than growing a second copy of them.
   *
   * A failure body is read WHOLE here even on the streaming path, and that is deliberate:
   * an arr's error is a sentence, and `ArrError` is what turns it into something a person
   * can act on. Only the SUCCESS body is ever large.
   */
  private async send(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    const res = await fetch(this.url(path, opts.query), {
      method,
      headers: {
        "X-Api-Key": this.svc.apiKey,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new ArrError(this.name, res.status, await res.text());
    return res;
  }

  /**
   * Every arr DELETE is a void controller action: HTTP 200 with a zero-byte body.
   * Calling res.json() unconditionally makes a SUCCESSFUL delete throw
   * "Unexpected end of JSON input". Handle the empty body explicitly.
   */
  private async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<T | null> {
    const text = await (await this.send(method, path, opts)).text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * A GET whose answer is a JSON ARRAY, handed over one element at a time.
   *
   * For the endpoints that answer with a whole library and cannot be paged -- see
   * `streamJsonArray` for the measurement, and for why the page parameters an arr accepts
   * are worse than none at all. A caller that projects each record down to the few fields
   * it keeps has a peak that does not grow with the library.
   *
   * The timeout is generous compared to `get`'s twenty seconds because it now has to cover
   * the whole transfer rather than a small answer, and the libraries these serve are the
   * ones expected to get much larger. It is still a timeout: a wedged arr does not hold a
   * mirror pass open forever.
   */
  getStream<T>(path: string, query?: Record<string, string | number | undefined>): AsyncGenerator<T> {
    return streamResponseArray<T>(this.send("GET", path, { query, timeoutMs: 120_000 }));
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, { body });
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, { body });
  }
  del<T>(path: string, query?: Record<string, string | number | undefined>) {
    return this.request<T>("DELETE", path, { query });
  }

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const s = await this.get<{ version: string }>("/system/status");
      return { ok: true, version: s?.version };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/**
 * What Radarr and Sonarr share on top of the transport: a library, a queue, and the two
 * lists an admin picks a request's destination from.
 *
 * Prowlarr deliberately does NOT extend this -- see `ProwlarrClient` in `./prowlarr.ts`.
 */
export class ArrClient extends ServarrHttp<ArrService> {
  rootFolders() {
    return this.get<ArrRootFolder[]>("/rootfolder");
  }
  qualityProfiles() {
    return this.get<ArrQualityProfile[]>("/qualityprofile");
  }
  queue() {
    return this.get<{ records: QueueItem[] }>("/queue", { pageSize: 200 });
  }

  /**
   * The most recent history events, newest first.
   *
   * ONE call for the whole library rather than one per open request. The alternative --
   * Radarr's `/history/movie?movieId=` and Sonarr's `/history/series?seriesId=` -- is a
   * call per request on a 30-second timer, which is the shape of load that gets an arr
   * treated as the reason the NAS is slow.
   *
   * A GRAB is what this is for and grabs are rare, so a page of 200 covers a long way
   * back. Nothing here is authoritative about a request that has been open for weeks:
   * the evidence is written down when it is seen, and staying in the page is not a
   * condition for keeping it.
   */
  history(pageSize = 200) {
    return this.get<{ records: ArrHistoryRecord[] }>("/history", {
      page: 1,
      pageSize,
      sortKey: "date",
      sortDirection: "descending",
    });
  }

  /**
   * Switch monitoring off for one library item through the arr's bulk EDITOR, which is the
   * only shape of this call that cannot delete anything.
   *
   * > [!CAUTION] The destructive form of `/{movie,series}/editor` is a DIFFERENT HTTP VERB
   * > Read against Radarr's `MovieEditorController` and Sonarr's `SeriesEditorController`
   * > (both `develop`, 2026-09-05): `[HttpPut] SaveAll` copies `monitored`, the profile, the
   * > root folder and the tags onto the rows it loaded and saves them. `deleteFiles` is not
   * > read by that handler at all -- it belongs to `[HttpDelete]`, a separate action. So a
   * > `PUT` here has no expressible way to remove a movie, a series or a file, whatever else
   * > ends up in the body. That property is why withdrawing goes through the editor rather
   * > than through `PUT /movie/:id` with a whole mirrored record: the safe verb is enforced
   * > by the endpoint instead of by us remembering not to send a field.
   *
   * The body sends ONE id because a withdraw is one request row. The endpoint's own shape is
   * a list, and it stays a list here rather than being flattened into a scalar the arr would
   * reject.
   */
  protected unmonitorVia(path: string, idsField: string, arrId: number): Promise<unknown> {
    return this.put<unknown>(path, { [idsField]: [arrId], monitored: false });
  }

  /**
   * Take one library item out of the arr, optionally with its files.
   *
   * > [!CAUTION] THE IMPORT EXCLUSION IS SENT EXPLICITLY FALSE, and never left to default
   * > `addImportExclusion` (Radarr) / `addImportListExclusion` (Sonarr) adds the title to a
   * > permanent block list, so a later import list -- or a person re-requesting it here --
   * > silently gets nothing. That is a much bigger decision than "take this back out", it is
   * > invisible from finderr, and it is undone only in the arr's own settings. Both arrs
   * > currently default it to false; sending it says we MEAN false rather than that we did
   * > not think about it, and the pair of tests in `arr.test.ts` is what keeps it that way.
   *
   * The two services spell that parameter differently, which is why the field NAME is an
   * argument here in the same shape `unmonitorVia` takes `idsField`: one implementation, and
   * the per-service difference stays a value rather than a second copy of the method.
   */
  protected removeVia(
    path: string,
    exclusionField: string,
    arrId: number,
    deleteFiles: boolean,
  ): Promise<unknown> {
    return this.del<unknown>(`${path}/${arrId}`, {
      deleteFiles: String(deleteFiles),
      [exclusionField]: "false",
    });
  }

  /**
   * One library item as the arr describes it right now, reduced to `ArrHoldings`.
   *
   * The FETCH and the missing-row rule live here; the per-service READ is the callback,
   * because that is the only part Radarr and Sonarr genuinely disagree about. A 404 is not
   * an error to report: it means the arr does not hold that row, which is exactly what
   * `null` says and what a caller about to remove it needs to know.
   */
  protected async holdingsOf(
    path: string,
    arrId: number,
    read: (body: Record<string, unknown>) => ArrHoldings,
  ): Promise<ArrHoldings | null> {
    try {
      const body = await this.get<Record<string, unknown>>(`${path}/${arrId}`);
      return body ? read(body) : null;
    } catch (err) {
      if (err instanceof ArrError && err.status === 404) return null;
      throw err;
    }
  }
}

/** `movieFile.quality.quality.name` off an untyped Radarr body, or null at any missing step. */
function radarrFileQuality(body: Record<string, unknown>): string | null {
  const file = body.movieFile as { quality?: { quality?: { name?: unknown } } } | undefined;
  const name = file?.quality?.quality?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

// ---------------------------------------------------------------------------

export class RadarrClient extends ArrClient implements ArrUnmonitor, ArrRemoval {
  constructor(svc: ArrService) {
    super("radarr", svc);
  }

  /**
   * The whole movie library, one film at a time.
   *
   * Streamed rather than returned as an array because Radarr answers with everything and
   * cannot be paged, and each record is ~5.5 KB of which the mirror keeps about six fields.
   * Project inside the loop and the peak stops tracking the library's size -- see
   * `getStream` and `streamJsonArray`.
   */
  movies(): AsyncGenerator<RadarrMovie> {
    return this.getStream<RadarrMovie>("/movie");
  }

  /** Stop Radarr looking for one movie. The file, if there is one, is untouched. */
  unmonitor(movieId: number) {
    return this.unmonitorVia("/movie/editor", "movieIds", movieId);
  }

  /**
   * What Radarr holds for one movie. A film is one file, so `files` is 0 or 1 and the
   * quality is the single answer `movieFile` carries.
   */
  holdings(movieId: number) {
    return this.holdingsOf("/movie", movieId, (body) => ({
      files: body.hasFile === true ? 1 : 0,
      bytes: typeof body.sizeOnDisk === "number" ? body.sizeOnDisk : null,
      quality: radarrFileQuality(body),
    }));
  }

  /** Take one movie out of Radarr, with its file when asked. See `removeVia`. */
  remove(movieId: number, opts: { deleteFiles: boolean }) {
    return this.removeVia("/movie", "addImportExclusion", movieId, opts.deleteFiles);
  }

  /**
   * Films in the library with a release date inside the window.
   *
   * Radarr answers with `imdbId` on every entry, which is the id everything else here is
   * keyed on, so the upcoming mirror needs no crosswalk at all. Three dates ride along
   * (`inCinemas`, `digitalRelease`, `physicalRelease`) and any of them may be in the
   * past -- see `soonestFutureDate` in `upcoming.ts` for which one a row is about.
   */
  calendar(start: string, end: string) {
    return this.get<RadarrCalendarEntry[]>("/calendar", { start, end });
  }

  /** Resolve an IMDb id through Radarr's own metadata proxy -- no TMDB key needed. */
  async lookupByImdb(imdbId: string): Promise<Record<string, unknown> | null> {
    const res = await this.get<Record<string, unknown>[]>("/movie/lookup", {
      term: `imdb:${imdbId}`,
    });
    return res?.[0] ?? null;
  }

  async add(opts: {
    imdbId: string;
    rootFolderPath?: string;
    qualityProfileId?: number;
    searchOnAdd?: boolean;
  }): Promise<RadarrMovie> {
    const found = await this.lookupByImdb(opts.imdbId);
    if (!found) throw new ArrError("radarr", 404, "", `Radarr could not resolve ${opts.imdbId}`);

    const body = {
      ...found,
      qualityProfileId: opts.qualityProfileId ?? this.svc.qualityProfileId ?? 4,
      rootFolderPath: opts.rootFolderPath ?? this.svc.rootFolder,
      monitored: true,
      minimumAvailability: "released",
      addOptions: { searchForMovie: opts.searchOnAdd !== false },
    };
    const created = await this.post<RadarrMovie>("/movie", body);
    if (!created) throw new ArrError("radarr", 500, "", "Radarr returned an empty body when adding");
    return created;
  }
}

/**
 * The `seasons` + `addOptions` half of an add, split out because it is the only part
 * with a decision in it and it is worth testing without a live Sonarr.
 *
 * With no selection this returns Sonarr's historical behaviour verbatim -- `monitor:
 * "all"`, seasons untouched -- so a request made without opening the selector is byte
 * for byte the request finderr sent before the selector existed.
 *
 * With a selection we do BOTH halves, and both are necessary:
 *
 * - **`monitor: "none"`** stops Sonarr applying its own policy over the top. Left at
 *   `"all"` it re-monitors every season after the add and the reader's choice lasts
 *   about a second.
 * - **the per-season `monitored` flags** are the choice itself. We rewrite the array
 *   the lookup returned rather than building one, because a season carries fields
 *   beyond these two and dropping them would hand Sonarr a partial season.
 *
 * A season the reader named that Sonarr does not know about is IGNORED rather than
 * invented -- the lookup is the authority on which seasons exist, and a fabricated
 * entry is how you get a monitored season with no episodes in it.
 */
export function seasonSelection(
  found: Record<string, unknown>,
  seasons: readonly number[] | null | undefined,
  searchOnAdd: boolean,
): Record<string, unknown> {
  const addOptions = { searchForMissingEpisodes: searchOnAdd, monitor: "all" };
  if (!seasons || seasons.length === 0) return { addOptions };

  const wanted = new Set(seasons);
  const known = Array.isArray(found.seasons) ? (found.seasons as Record<string, unknown>[]) : [];

  return {
    seasons: known.map((s) => ({ ...s, monitored: wanted.has(s.seasonNumber as number) })),
    addOptions: { ...addOptions, monitor: "none" },
  };
}

export class SonarrClient extends ArrClient implements ArrUnmonitor, ArrRemoval {
  constructor(svc: ArrService) {
    super("sonarr", svc);
  }

  /** The whole series library, one show at a time. Same shape and same reason as `RadarrClient.movies`. */
  series(): AsyncGenerator<SonarrSeries> {
    return this.getStream<SonarrSeries>("/series");
  }

  /**
   * What Sonarr holds for one series, from the `statistics` block it already computes.
   *
   * The quality is NULL by construction: a series holds one quality per episode file, and
   * picking one of them to print would be inventing a fact about the other ninety.
   */
  holdings(seriesId: number) {
    return this.holdingsOf("/series", seriesId, (body) => {
      const stats = body.statistics as { episodeFileCount?: unknown; sizeOnDisk?: unknown } | undefined;
      return {
        files: typeof stats?.episodeFileCount === "number" ? stats.episodeFileCount : 0,
        bytes: typeof stats?.sizeOnDisk === "number" ? stats.sizeOnDisk : null,
        quality: null,
      };
    });
  }

  /** Take one series out of Sonarr, with its files when asked. See `removeVia`. */
  remove(seriesId: number, opts: { deleteFiles: boolean }) {
    return this.removeVia("/series", "addImportListExclusion", seriesId, opts.deleteFiles);
  }

  /**
   * Stop Sonarr looking for one series. Every file it already holds is untouched.
   *
   * The SERIES flag is enough and the per-season and per-episode flags are deliberately left
   * alone: Sonarr's `MonitoredEpisodeSpecification` rejects any release whose series is
   * unmonitored, so nothing is grabbed while this is off -- and leaving the inner flags as
   * the reader set them is what makes re-requesting restore the selection they chose.
   */
  unmonitor(seriesId: number) {
    return this.unmonitorVia("/series/editor", "seriesIds", seriesId);
  }

  /**
   * Episodes airing inside the window, each carrying its series.
   *
   * `includeSeries=true` is what makes this usable: without it an entry names only a
   * `seriesId`, which is Sonarr's own integer and not something any other table here
   * knows. With it, `series.imdbId` arrives on every row and no crosswalk is needed.
   *
   * The answer is EPISODE-shaped while the mirror is title-shaped, so the collapse to one
   * row per series happens in `upcoming.ts` rather than here -- this stays a plain read.
   */
  calendar(start: string, end: string) {
    return this.get<SonarrCalendarEntry[]>("/calendar", { start, end, includeSeries: "true" });
  }

  /**
   * Every episode Sonarr lists for one series, aired or not, one at a time.
   *
   * Bounded by one series rather than by the library, so this is the least urgent of the
   * three walks -- but a long-running anime is thousands of episodes, and reading it the
   * same way as the other two means there is one answer to "how does finderr read an arr
   * list" rather than two that must be kept in step.
   */
  episodes(seriesId: number): AsyncGenerator<SonarrEpisode> {
    // `includeEpisodeFile` is what makes the playback mirror FREE. Verified against the live
    // Sonarr 2026-09-08: the episode records come back carrying `episodeFile` with its path,
    // size and full `mediaInfo` -- so finderr learns every codec it needs to plan a
    // transcode without a second call per series. Radarr needs no equivalent flag; its
    // `/movie` list already embeds `movieFile`.
    return this.getStream<SonarrEpisode>("/episode", { seriesId, includeEpisodeFile: "true" });
  }

  /**
   * Monitor or unmonitor a set of episodes.
   *
   * Sonarr will not search for an unmonitored episode -- it accepts the command and finds
   * nothing -- so this is not optional decoration before a search, it is half of it.
   * The endpoint takes episode IDS only; there is no season/number form.
   */
  monitorEpisodes(episodeIds: readonly number[], monitored = true) {
    return this.put<unknown>("/episode/monitor", { episodeIds: [...episodeIds], monitored });
  }

  /** Ask Sonarr to go looking for these episodes right now. */
  searchEpisodes(episodeIds: readonly number[]) {
    return this.post<{ id: number }>("/command", {
      name: "EpisodeSearch",
      episodeIds: [...episodeIds],
    });
  }

  /** Sonarr keys on tvdbId, so an IMDb id has to go through its lookup first. */
  async lookupByImdb(imdbId: string): Promise<Record<string, unknown> | null> {
    const res = await this.get<Record<string, unknown>[]>("/series/lookup", {
      term: `imdb:${imdbId}`,
    });
    return res?.[0] ?? null;
  }

  async add(opts: {
    imdbId: string;
    rootFolderPath?: string;
    qualityProfileId?: number;
    searchOnAdd?: boolean;
    seasonFolder?: boolean;
    /**
     * Season numbers to monitor. Omit (or null) to keep Sonarr's own `monitor: "all"`,
     * which is what every request did before the selector existed.
     */
    seasons?: readonly number[] | null;
  }): Promise<SonarrSeries> {
    const found = await this.lookupByImdb(opts.imdbId);
    if (!found) throw new ArrError("sonarr", 404, "", `Sonarr could not resolve ${opts.imdbId}`);

    const body = {
      ...found,
      qualityProfileId: opts.qualityProfileId ?? this.svc.qualityProfileId ?? 4,
      rootFolderPath: opts.rootFolderPath ?? this.svc.rootFolder,
      monitored: true,
      seasonFolder: opts.seasonFolder !== false,
      ...seasonSelection(found, opts.seasons, opts.searchOnAdd !== false),
    };
    const created = await this.post<SonarrSeries>("/series", body);
    if (!created) throw new ArrError("sonarr", 500, "", "Sonarr returned an empty body when adding");
    return created;
  }
}
