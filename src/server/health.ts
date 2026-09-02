/**
 * The `/api/health` payload.
 *
 * Extracted from the route handler for one reason: so a test can prove that asking
 * whether finderr is alive does not make it do work.
 *
 * On 2026-08-31 this endpoint took **1.9 seconds** against the real index, roughly 400
 * times the cost of a search, because it rebuilt every discovery shelf on every call to
 * report facet coverage. Docker's HEALTHCHECK polls it every 30 seconds, so a probe
 * nobody was reading burned about 6% of a core in perpetuity.
 *
 * The rule this file exists to enforce: **every field here is a COUNT or a READ, never
 * a QUERY -- except `facets.coverage`, which is opt-in.** `coverage` arrives as a thunk
 * precisely so the test can assert it was never invoked.
 */

import type { ShelfCoverage } from "./shelves";

export interface HealthRuntime {
  uptimeSeconds: number;
  rss: number;
  heapUsed: number;
  cgroup: {
    current: number;
    limit: number | null;
    ratio: number | null;
    anon: number | null;
    file: number | null;
    atLimit: number | null;
  } | null;
  cpuSeconds: number;
  gcSeconds: number | null;
  /**
   * The fuzzy pool's report, or `null` while there is no index open to ask.
   *
   * Nullable because health answers during the boot-time build, before any engine exists.
   * It was `string`, which is what let the call site reach through `live.current` and throw
   * on every probe of a first install -- see `LiveIndex.poolStats`.
   */
  fuzzy: string | null;
}

/**
 * What the last in-place index swap did.
 *
 * `null` until the daily refresh has run once in this process, which is the normal state
 * for most of a container's life and is not a fault. A REFUSED swap (`ok: false`) is the
 * field worth alerting on: it means a promoted index would not answer and we are
 * deliberately still serving the previous one. Without it that fact lives only in a log
 * line nobody tails.
 */
export interface HealthReload {
  ok: boolean;
  swapped: boolean;
  at: string;
  ms: number;
  reason?: string;
  canary?: { passed: number; total: number; ratio: number };
}

export interface HealthDeps {
  /** `reload` is a plain value read off the holder -- no work, same as every other field. */
  index: { rows: number; builtAt: string | null; reload: HealthReload | null };
  /**
   * `episodes` is the per-episode Sonarr mirror, and zero beside a non-zero `sonarr` is
   * the field worth reading: it means the series walk ran and every episode fetch failed,
   * which renders as a series page with no owned marks and no episode request buttons --
   * indistinguishable from "you own nothing" unless you look here.
   */
  library: { radarr: number; sonarr: number; episodes: number };
  /**
   * The Plex mirror: how many titles carry a play link, and which server they point at.
   *
   * `items: 0` with a configured URL is the field worth reading -- it means the walk ran
   * and matched nothing, which is what a library scanned by a LEGACY agent looks like
   * (`com.plexapp.agents.*` guids carry no `imdb://` child). `machineId: null` means no
   * successful sync has happened at all, and no link can be built without it.
   */
  plex: { items: number; machineId: string | null };
  /**
   * The upcoming mirror, one count per SOURCE, because they fail independently.
   *
   * A total would hide the failure worth seeing: each writer replaces only its own rows,
   * so Sonarr being unreachable empties one shelf while the other three stay full, and a
   * single number cannot say which. Read a zero beside a configured service as "the walk
   * ran and matched nothing", the same way `plex.items: 0` reads.
   *
   * `tmdbMovie`/`tmdbSeries` at zero is the ORDINARY case for a checkout with no TMDB key
   * -- the sync returns before calling anything, exactly like the `tmdb` plugin going dark.
   * Both at zero WITH a key set is the one to look into.
   */
  upcoming: { radarr: number; sonarr: number; tmdbMovie: number; tmdbSeries: number };
  /**
   * How many titles are on the mirrored trending list.
   *
   * Zero is the ORDINARY case with no TMDB key, exactly like `upcoming.tmdbMovie`. Zero
   * WITH a key is worth a look, and it has one benign cause worth knowing before you go
   * hunting: the crosswalk drops any trending title our INDEX cannot draw a card for, so
   * a week whose list is mostly brand-new streaming series legitimately keeps fewer than
   * the twenty TMDB sent.
   */
  trending: number;
  /**
   * The award mirror: how many nominations are stored, and which commit they came from.
   *
   * `rows: 0` is the field worth reading -- the import is optional and runs on its own
   * daily timer, so zero means either that a cold store has not reached its first import
   * yet (about twelve seconds after boot) or that the import has been failing, and the log
   * says which. `sha: null` beside a non-zero `rows` means the rows were parsed from `main`
   * without GitHub's commits API answering, so we cannot name what we read -- honest, and
   * the reason the field exists rather than a bare date.
   */
  awards: { rows: number; sha: string | null; importedAt: string | null };
  /**
   * Which services this instance is CONFIGURED to talk to. Not a reachability probe --
   * pinging three hosts on every health call would put a network round trip on the one
   * endpoint that has to answer while everything else is broken.
   *
   * `prowlarr: false` is a normal state and not a fault: it is read-only and optional, and
   * without it a request that has found nothing is reported as still looking rather than as
   * hopeless. That is the first thing to check when a diagnostics verdict looks vague.
   */
  services: { radarr: boolean; sonarr: boolean; prowlarr: boolean };
  /**
   * Identity, as three counts and a boolean -- no names, no ids, no tokens.
   *
   * Counts rather than identities: it says the system has users without saying who.
   * `users: 0` is the one worth reacting to -- it means the bootstrap invite in the boot
   * log is still the only way in.
   *
   * This block is ADMIN-ONLY, like everything else past `ok`. It used to carry a note
   * arguing that `/api/health` was safe for an anonymous caller to read in full; see the
   * caution on `healthPayload` for why that stopped being true and what replaced it.
   */
  auth: {
    users: number;
    admins: number;
    sessions: number;
    apiKey: boolean;
    /** `auth.noAuth`. TRUE means THE LOGIN WALL IS OPEN -- see that config field. */
    noAuth: boolean;
  };
  queue: unknown;
  artwork: unknown;
  /**
   * The held front page: whether it is on, whether it is complete, and when each tier last
   * rebuilt.
   *
   * The per-tier timestamps are the field worth reading. `enabled: true` with `ready: false`
   * means every request is falling back to computing the page -- which is CORRECT and
   * otherwise invisible, so nothing else would ever tell you the feature is not working. An
   * `arr` timestamp older than a couple of minutes says the 60-second library timer has
   * stopped, which is a bigger problem than the shelves.
   */
  shelves: unknown;
  plugins: string[];
  facetRows: number;
  facetImages: number;
  /**
   * Contributions deleted at boot because a plugin had superseded them.
   *
   * A BOOT-TIME FACT, not a running total: it is whatever the one sweep in this process
   * removed, so it stays put for the life of the container and reads 0 on a boot that found
   * nothing. That is the useful shape -- a large number here says the plugins changed since
   * the last restart, and `facets.rows` beside it is now honest rather than counting a pile
   * no read path can reach.
   */
  facetRowsPruned: number;
  /**
   * Where the time actually goes, at all three layers: what each ROUTE took, what each
   * provider took inside it, and what each upstream HOST took underneath that -- plus the
   * individual requests slow enough to have kept their arguments.
   *
   * `requests` and `slow` are two questions and neither answers the other. A distribution
   * says `/api/browse` is p95 3.6s; it cannot say which browse, and on this API
   * `?genre=Comedy` and `?kind=series` differ by 400x. See `src/lib/slow-log.ts`.
   *
   * A plain value rather than a thunk, unlike `coverage`: every side is an in-memory tally
   * over a bounded window, so reading them asks nobody anything and costs a sort of at most
   * a few hundred numbers. The rule this endpoint already states -- asking a question must
   * not do the work -- is what separates the two.
   */
  timings: {
    providers: Record<string, unknown>;
    outbound: Record<string, unknown>;
    requests: Record<string, unknown>;
    slow: unknown[];
  };
  runtime: HealthRuntime;
  /**
   * The expensive one. A THUNK, not a value: it runs every shelf query plus a facet
   * lookup per shelf title, and it must not be called unless the caller asked.
   */
  coverage: () => ShelfCoverage[];
}

/**
 * `detailed: false` is what an ANONYMOUS caller gets, and it is `{ ok: true }` and nothing
 * else.
 *
 * > [!CAUTION] This endpoint is reachable from the internet and everything below it is a
 * > fact about a private network
 * > `/api/health` is on the public path list because Docker's probe needs it, and the
 * > comment on `auth` below used to argue that everything here was therefore safe to read
 * > from outside. That was false the moment finderr got a public hostname, on 2026-08-31:
 * > `plex.machineId` is a stable identifier for somebody's Plex server, `library.radarr`
 * > and `library.sonarr` are the size of their collection, and `runtime.rss` plus
 * > `cpuSeconds` are a free oracle for whether an attack is landing.
 * >
 * > It also closed a cheaper hole than the disclosure: **`?coverage=1` costs ~1.9 seconds**
 * > of shelf queries, 400x a search, and an anonymous caller could ask for it in a loop.
 * > The early return happens BEFORE the thunk is read, so that lever is gone rather than
 * > merely expensive.
 *
 * The probe is unaffected -- the HEALTHCHECK reads `r.ok` and nothing else.
 */
export function healthPayload(
  deps: HealthDeps,
  opts: { coverage: boolean; detailed: boolean },
): Record<string, unknown> {
  if (!opts.detailed) return { ok: true };
  return {
    ok: true,
    index: deps.index,
    library: deps.library,
    plex: deps.plex,
    upcoming: deps.upcoming,
    trending: deps.trending,
    awards: deps.awards,
    // Resource use, with the CEILING beside the usage -- a byte count on its own cannot
    // be triaged, and `atLimit` rising is the clearest sign the heap has outgrown the
    // container. `gcSeconds` is cumulative CPU spent collecting; compare two samples to
    // get the share, which is what the periodic log line prints.
    runtime: deps.runtime,
    // TOP LEVEL, and it used to be `facets.timing`. It moved when `requests` and `slow`
    // joined it: a route's latency is not a fact about the facet cache, and nesting it
    // there would have made the one key a reader goes looking for on a slow page the
    // hardest one to find. Nothing consumed the old key.
    timings: deps.timings,
    services: deps.services,
    auth: deps.auth,
    queue: deps.queue,
    artwork: deps.artwork,
    shelves: deps.shelves,
    plugins: { loaded: deps.plugins },
    facets: {
      // `images` is how many facet images we have issued a proxy key for -- a zero
      // beside a non-zero `rows` means facets are landing but nothing is being
      // rewritten. Both are counts, not probes.
      rows: deps.facetRows,
      images: deps.facetImages,
      pruned: deps.facetRowsPruned,
      ...(opts.coverage ? { coverage: deps.coverage() } : {}),
    },
  };
}
