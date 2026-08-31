/**
 * Sonarr / Radarr client.
 *
 * Native fetch, no axios. The important design decision is not in this file but in
 * how it is used: the library is MIRRORED into local SQLite on a timer, so the
 * question "do we already have this?" is answered from memory during a render and
 * never over the network. That single choice is most of the speed difference.
 */

import type { ArrService } from "./config";

export interface ArrRootFolder {
  id: number;
  path: string;
  freeSpace?: number;
}

export interface ArrQualityProfile {
  id: number;
  name: string;
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
}

export interface SonarrSeries {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  imdbId?: string;
  monitored: boolean;
  statistics?: {
    episodeFileCount: number;
    episodeCount: number;
    percentOfEpisodes: number;
  };
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

export class ArrClient {
  constructor(
    protected readonly name: "radarr" | "sonarr",
    protected readonly svc: ArrService,
  ) {}

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(`/api/v3${path}`, this.svc.url);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
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
    const res = await fetch(this.url(path, opts.query), {
      method,
      headers: {
        "X-Api-Key": this.svc.apiKey,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });

    const text = await res.text();
    if (!res.ok) throw new ArrError(this.name, res.status, text);
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
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, { body });
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

  rootFolders() {
    return this.get<ArrRootFolder[]>("/rootfolder");
  }
  qualityProfiles() {
    return this.get<ArrQualityProfile[]>("/qualityprofile");
  }
  queue() {
    return this.get<{ records: QueueItem[] }>("/queue", { pageSize: 200 });
  }
}

// ---------------------------------------------------------------------------

export class RadarrClient extends ArrClient {
  constructor(svc: ArrService) {
    super("radarr", svc);
  }

  movies() {
    return this.get<RadarrMovie[]>("/movie");
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

export class SonarrClient extends ArrClient {
  constructor(svc: ArrService) {
    super("sonarr", svc);
  }

  series() {
    return this.get<SonarrSeries[]>("/series");
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
