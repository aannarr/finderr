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

import type { MeterReport } from "../lib/cost-meter";
import type { PeakSample } from "../lib/runtime-stats";
import type { WarmAttempt, WarmState, WarmStatus } from "./live-index";
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
   * The largest this process has ever been while doing a named background job, and which one.
   *
   * `rss` above is a GAUGE and cannot answer the question this field exists for. The container
   * probes health every thirty seconds; a library walk that briefly doubles the process is
   * over long before the next probe, so every reading is taken between spikes and the process
   * looks steady right up until the kernel kills it. That is not hypothetical -- it is what
   * Seerr's #3307 reporter observed for sixteen days while Docker called the container
   * healthy. Read this beside `cgroup.limit`: a peak approaching it is the warning that a
   * gauge structurally cannot give you.
   *
   * `null` until a job has run, which on a fresh boot is the first minute.
   */
  peak: PeakSample | null;
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

/**
 * Whether the page-cache prefault ran, what it kept, and the settings it ran under.
 *
 * `state` and `ok` are owned by `LiveIndex` -- read `WarmState` there for what each value
 * means and why a failed prefault needed a name of its own. Everything else here answers a
 * different question and none substitutes for another: `last.readMb` is what the loop did,
 * `last.residentMb` is what the kernel still had afterwards, and `tuning` is what was asked
 * for. A deployment can fail at any one of them independently -- not running, running and
 * being reclaimed, or being told to map more memory than the container has.
 *
 * There is no `prefault` boolean here any more. It said exactly what `state !== "off"` says,
 * and it said it WRONG on the first-install path: no engine is open there, so the derivation
 * answered `false` for a prefault that was simply waiting for an index to exist.
 */
export interface HealthWarm {
  state: WarmState;
  /** The one field a probe keys on. False means a prefault ran and did not deliver the file. */
  ok: boolean;
  /** The last attempt to finish, success or failure. `null` before the first one completes. */
  last: WarmAttempt | null;
  tuning: {
    budgetMb: number;
    budgetSource: string;
    mmapMb: number;
    cacheMb: number;
    prefault: boolean;
  } | null;
}

/**
 * The holder's warm report, narrowed to what may leave the process.
 *
 * `StorageTuning.notes` deliberately does NOT travel: it is prose written for an operator
 * reading a boot log, and this endpoint is reachable from the internet. Numbers cross;
 * sentences stay in the log, the same rule `work.problems` follows for provider errors.
 */
export function warmHealth(s: WarmStatus): HealthWarm {
  return {
    state: s.state,
    ok: s.ok,
    last: s.last,
    tuning: s.tuning
      ? {
          budgetMb: s.tuning.budgetMb,
          budgetSource: s.tuning.budgetSource,
          mmapMb: Math.round(s.tuning.mmapBytes / 1024 / 1024),
          cacheMb: Math.round(s.tuning.cacheKib / 1024),
          prefault: s.tuning.prefault,
        }
      : null,
  };
}

export interface HealthDeps {
  /**
   * `reload` and `warm` are plain values read off the holder -- no work, like every other field.
   *
   * **`warm` is the field this endpoint was missing, and the gap was expensive.** The prefault
   * is worth up to 32x on first reads from a spinning array, it defaults on, and until it
   * shipped the only evidence it had run was one log line -- so a container reading every
   * query off the disk was indistinguishable from a healthy one. Alert on `warm.ok`; read
   * `warm.state` for which of the six situations it is; and read `warm.last.residentMb` far
   * below `readMb` as "it ran and the memory cap took most of it back", which is a different
   * problem again, with a different fix, and which `ok` deliberately does not fire on.
   */
  index: {
    rows: number;
    builtAt: string | null;
    reload: HealthReload | null;
    warm: HealthWarm | null;
    /**
     * The language preference, and whether the open index can actually serve it.
     *
     * > [!IMPORTANT] This field exists because of the crosswalk, not because it is tidy
     * > When the id crosswalk shipped, the container pulled the image, `hasIds` was false,
     * > and it STAYED false while every render bought the calls the crosswalk existed to
     * > remove -- nothing logged, health entirely green, found by hand days later.
     * > `configured` beside `available: false` is the same shape and a worse one: the
     * > operator has asked for a filter that is silently not being applied.
     *
     * `configured` is what `cfg.languages` holds, WITHOUT `UNKNOWN_LANG` -- the storage
     * code is an implementation detail and printing it here would invite somebody to
     * configure it.
     */
    origin: { available: boolean; configured: string[] };
  };
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
   * The award mirror, ONE ENTRY PER AWARD: how many rows are stored and where they came from.
   *
   * A list rather than a total, because a total is what hides the interesting failure: three
   * sources import independently and a Wikidata outage that leaves one award at zero would
   * disappear into the Oscars' twelve thousand rows.
   *
   * `rows: 0` is the field worth reading -- the import is optional and runs on its own
   * daily timer, so zero means either that a cold store has not reached its first import
   * yet (about twelve seconds after boot) or that the import has been failing, and the log
   * says which. `sha: null` beside a non-zero `rows` is ordinary for a Wikidata award (there
   * is no commit to name) and means something for `oscar_data`: the rows were parsed from
   * `main` without GitHub's commits API answering, so we cannot say what we read.
   */
  awards: { award: string; rows: number; sha: string | null; importedAt: string | null }[];
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
  /**
   * The private lists: how many titles are saved, and how many people keep one.
   *
   * A COUNT AND NOTHING ELSE, on the same rule as `auth` and `push` above -- the whole
   * promise of a watchlist is that it is yours, so what may be published about it is that
   * the feature is being used and never a title or a name. `WatchlistStats` is the one owner
   * of that shape.
   *
   * `rows` rising with `readers` at 1 is the ordinary shape of a small household. Both at
   * zero on a deployment where people are saving things is worth looking at; nothing else
   * reports on this table.
   */
  watchlist: { rows: number; readers: number };
  /**
   * Web push: whether it is switched on, and how many devices have subscribed.
   *
   * A COUNT, like everything else in `auth` above, and for the same reason: it says
   * notifications are reaching somebody without saying whose phone. `enabled: true` with
   * `devices: 0` is the ordinary state of a fresh install and is what to check first when
   * an arrival did not notify anybody -- before looking at the push service, look at whether
   * anybody ever turned it on.
   */
  push: { enabled: boolean; devices: number };
  /**
   * The arr callback: whether a password is configured, and what has arrived since boot.
   *
   * Three counts, and the pair worth reading is `received` beside `applied`. Configuring the
   * Webhook connections is a manual step on the arr side, so `received: 0` is how an operator
   * finds out they did not save it -- there is no other signal, and the poller keeps working
   * either way, which is exactly what makes a mis-configured webhook invisible. `refused`
   * rising is a wrong password or a caller that should not be there.
   */
  webhook: { enabled: boolean; received: number; applied: number; refused: number };
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
  /**
   * The addons that are loaded, and what each one is allowed to talk to.
   *
   * `hosts` rather than only the id, because "what addons are running" and "what do they
   * reach out to" are the same question for an operator deciding whether this container
   * should be on the internet -- and core REFUSES a fetch to anything not on this list, so it
   * is the whole outbound surface a plugin has. Both fields are read off `meta` in memory; no
   * query, like everything else here.
   *
   * PER-PLUGIN FACET ROW COUNTS ARE DELIBERATELY ABSENT. `facet_contribution` carries
   * `plugin_id`, but it is indexed on `entity_id` alone, so a `group by` is a full scan -- and
   * this endpoint is the one Docker polls every 30 seconds. `facets.rows` is the total, which
   * is the number that costs nothing. If the per-plugin split is ever wanted it belongs behind
   * an opt-in flag beside `?coverage=1`, which is the shape this file already uses for exactly
   * this trade.
   */
  plugins: { id: string; hosts: string[] }[];
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
   * How much evidence the search retune has, and whether any of it is being lost.
   *
   * `dropped` is the field worth watching: non-zero means a client is reporting clicks
   * faster than the 30-second flush drains the buffer, so rows are being refused rather
   * than memory growing. `pending` beside a `stored` that never rises says the flush timer
   * has stopped.
   *
   * It counts rows and states a switch; it contains no query and, by construction, nobody's
   * identity -- see `src/lib/search-log.ts`.
   */
  searchLog: {
    enabled: boolean;
    pending: number;
    searches: number;
    clicks: number;
    dropped: number;
    stored: { searches: number; clicks: number };
  };
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
  /**
   * Per-caller spend over the last minute. A thunk for a different reason from `coverage`:
   * it is cheap, but it is a SNAPSHOT of a rolling window, so reading it at call time is
   * what keeps it from being a number captured when the deps object was built.
   */
  load: () => MeterReport;
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
    /*
      WHO ATE THE MACHINE IN THE LAST MINUTE, and what was done about them.

      `timings` above says how long requests TOOK. This says who they took it FOR, which is
      the question an operator actually has when somebody reports that searching felt slow
      last night -- and it is the only field in this document that can answer it. Read
      `load.callers` for the spend, `load.slowed` for who is being paced, `load.refusals`
      for who was turned away.

      `contended: true` with one caller holding most of `busyMs` is the whole diagnosis in
      two fields. A non-empty `slowed` is NOT an alert: it is the tarpit working, and a fast
      agent living there permanently is the designed outcome.

      ADMIN-ONLY, like everything past `ok`, and for a sharper reason than the rest of this
      document: the caller keys are account ids and IP addresses. `healthPayload`'s early
      return is what keeps them off the internet.
    */
    load: deps.load(),
    services: deps.services,
    auth: deps.auth,
    watchlist: deps.watchlist,
    push: deps.push,
    webhook: deps.webhook,
    queue: deps.queue,
    artwork: deps.artwork,
    shelves: deps.shelves,
    searchLog: deps.searchLog,
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
