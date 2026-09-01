#!/usr/bin/env bun
/**
 * finderr server.
 *
 * INVITE-ONLY. Every route below is closed to an anonymous caller except `/api/health`
 * and the sign-in ceremonies -- see `withAuth` in `./auth-routes.ts`, which wraps this
 * whole table rather than trusting each handler to remember. An anonymous browser is
 * served a deliberately bare sign-in page and never the app shell.
 *
 * The governing rule for every handler here: THE RENDER PATH TOUCHES NOTHING BUT
 * LOCAL SQLITE AND LOCAL DISK. Any handler that can block on a network call while a
 * user waits is a bug. Outbound calls to Sonarr/Radarr happen on a timer or in a
 * background queue, never inside a request the browser is waiting on.
 */

import { existsSync, mkdirSync } from "node:fs";
import { awardSourceMeta, importAwards } from "../jobs/import-awards";
import { RadarrClient, SonarrClient } from "../lib/arr";
import { arrLink } from "../lib/arr-links";
import { isoIn, visibleRequest } from "../lib/auth";
import { AuthStore } from "../lib/auth-store";
import { OSCARS, personAwards, titleAwards } from "../lib/awards";
import { collectionPage, collectionsMatchingName } from "../lib/collections";
import { loadConfig, paths } from "../lib/config";
import type { EpisodeState } from "../lib/episodes";
import { FacetResolver, isLiveContribution, type ResolvedFacets } from "../lib/facet-resolver";
import { entityKindFor, type FacetEntity } from "../lib/facets";
import { rollback } from "../lib/index-builder";
import { loadLogoIndex } from "../lib/logos";
import { renderPanes } from "../lib/panes";
import { PlexClient, plexLinks, syncPlex } from "../lib/plex";
import { createPluginFetch, DEFAULT_OUTBOUND_POLICY, HostPacer, outboundTimings } from "../lib/plugin-fetch";
import { loadPlugins } from "../lib/plugins";
import { hasOverrides, parseRequestOverrides } from "../lib/request-overrides";
import { ResourceMonitor, snapshot as runtimeSnapshot } from "../lib/runtime-stats";
import { type BrowseSort, isBrowseSort, type TitleRow } from "../lib/search";
import { parseSeasonsInput } from "../lib/seasons";
import { prepareSqlite } from "../lib/spellfix";
import { Store, syncLibrary } from "../lib/store";
import { TMDB_HOST, TmdbApi } from "../lib/tmdb-api";
import { syncArrCalendars, syncTmdbUpcoming } from "../lib/upcoming";
import { ArtworkService, DEFAULT_IMAGE_SIZE } from "./artwork";
import { AuthService, withAuth } from "./auth-routes";
import { type AwardsDeps, ceremonyPayload, timelinePayload } from "./awards";
import { FACET_IMAGE_PATH, FacetImageProxy } from "./facet-images";
import { healthPayload } from "./health";
import { ImageCache } from "./images";
import { buildingPage, INDEX_GATE_PUBLIC_PATHS, IndexBuild, withIndexGate } from "./index-build";
import { LiveIndex } from "./live-index";
import { RequestWorker } from "./request-worker";
import { discoveryShelves, facetCoverage, frontPageTitles } from "./shelves";

const cfg = loadConfig();
const p = paths(cfg);
mkdirSync(p.root, { recursive: true });

const log = (...args: unknown[]) => console.log(`[finderr]`, ...args);

// MUST run before the first `new Database()` anywhere in this process. On macOS,
// Apple's SQLite refuses to load extensions, so Bun has to be pointed at a different
// libsqlite3 -- and that switch is process-global and one-shot. No-op on Linux.
prepareSqlite(log);

// --- index -----------------------------------------------------------------
/*
  No index yet.

  `index.refreshOnBoot` decides what that means, and until 2026-08-31 it decided nothing at
  all -- the key was declared, defaulted and mapped from ENV, and no code read it. The boot
  message below named it as a remedy, so a first-time operator set it, restarted, and
  watched the identical crash loop. See `./index-build.ts` for why the build is a
  subprocess and why the server comes up first.
*/
const indexMissingAtBoot = !existsSync(p.db);
if (indexMissingAtBoot && !cfg.index.refreshOnBoot) {
  console.error(
    `\n[finderr] No title index at ${p.db}, and FINDERR_INDEX_REFRESH_ON_BOOT is off.\n` +
      "          Run:  bun src/jobs/build-index.ts\n" +
      "          (or set FINDERR_INDEX_REFRESH_ON_BOOT=true, which builds one on boot)\n",
  );
  process.exit(1);
}
if (indexMissingAtBoot) {
  log(
    "no title index yet -- building one. The server comes up now and serves a progress page until it is ready.",
  );
}

// The engine is held behind `live` rather than in a const, so the daily refresh can swap
// a freshly promoted index in WITHOUT a restart. Every call site below reads
// `live.current` at the moment of use -- never destructure it into a local that outlives
// an `await`, or that handler goes on serving the retired index. See `./live-index.ts`.
const live = new LiveIndex({
  path: p.db,
  cfg,
  log: (m) => log(m),
  // Not optional in practice. Once `promote()` has renamed the live path out from under
  // our open connection, the engine we hold mostly throws and occasionally hands back
  // yesterday's row with no error -- measured, see the warning on `LiveIndex.reload()`.
  // So if the promoted index turns out to be bad, refusing it and standing pat would
  // leave the server erroring on most requests and lying on the rest, which is worse
  // than either. `rollback()` moves `titles.prev.db` back and the reload retries.
  recover: () => rollback(cfg),
  // Only ever true when the file is genuinely absent AND we are allowed to build one --
  // the exit above has already fired otherwise, so this cannot mask a missing index.
  allowMissing: indexMissingAtBoot,
});
if (live.ready) {
  const meta = live.meta();
  log(`index: ${Number(meta.rows ?? 0).toLocaleString()} titles, built ${meta.built_at ?? "?"}`);
}

/*
  The boot-time build, or `null` when there was already an index.

  Started here so it runs WHILE the rest of boot happens -- the store, the plugins and the
  arr mirrors all set themselves up against local SQLite and none of them need the title
  index. What is adopted, and when, is wired at the bottom of this file beside the daily
  refresh, because the completion handler wants `warmShelves`.
*/
const indexBuild = live.ready
  ? null
  : new IndexBuild({ script: `${import.meta.dir}/../jobs/build-index.ts`, log: (m) => log(m) });

// --- state + clients -------------------------------------------------------
const store = new Store(cfg);
const radarr = cfg.radarr ? new RadarrClient(cfg.radarr) : undefined;
const sonarr = cfg.sonarr ? new SonarrClient(cfg.sonarr) : undefined;
const images = new ImageCache(cfg);
const artwork = new ArtworkService(cfg, store, { radarr, sonarr }, log);
// Cast headshots, season posters and episode stills, served from our own origin. Reuses
// the artwork service for the bytes -- a face is not a different kind of JPEG.
const facetImages = new FacetImageProxy({ store, bytes: artwork });
const worker = new RequestWorker({ store, radarr, sonarr, log });

// Identity. Shares the app database connection -- one file, one writer, one migration.
const authStore = new AuthStore(store.db);
const auth = new AuthService({
  auth: authStore,
  store,
  cfg,
  log: (m) => log(m),
  // Read at call time, so the closure can name `server` before Bun.serve has returned it.
  addressOf: (req: Request) => server.requestIP(req)?.address ?? null,
});

/*
  DEVELOPMENT LOGIN, and it is deliberately the loudest thing this process ever prints.

  It runs BEFORE the bootstrap block below, and that ordering is the point: `ensureDevUser`
  creates the account, so `userCount()` is no longer zero and no bootstrap invite is minted.
  There is already a way in, and printing an invite nobody needs would train a reader to
  ignore the one that matters.

  The banner names the account and the bind, because both are things somebody could otherwise
  get wrong silently -- a developer who set the flag and then wondered why the LAN could not
  reach the server deserves to be told here rather than in a config file.
*/
const devUser = auth.ensureDevUser();
if (devUser) {
  log("");
  log("  ##########################################################");
  log("  #  AUTHENTICATION IS OFF -- FINDERR_DEV_LOGIN_AS IS SET  #");
  log("  ##########################################################");
  log(
    `  every request is signed in as ${JSON.stringify(devUser.displayName)} (${devUser.role}) -- no login wall`,
  );
  log(`  anyone who can reach ${cfg.host}:${cfg.port} is an admin here`);
  log("  this process holds the Radarr, Sonarr and Plex credentials. Do not expose it.");
  log("");
}

/*
  Bootstrap.

  An empty user table is a locked front door with nobody holding a key, so the FIRST boot
  mints an admin invite and prints it. It is printed rather than persisted anywhere a
  reader could find it later: the token exists in this log line and in the invitee's
  browser, and if the line scrolls away the fix is to mint another with the system key.

  It fires only when there are no users at all -- not on every boot, and not when the last
  admin has merely been disabled, because "the board is empty" and "the admins are locked
  out" want different answers and only the second one is a judgement call.
*/
if (authStore.userCount() === 0) {
  const { token } = authStore.createInvite({
    role: "admin",
    note: "first-boot bootstrap",
    displayName: "admin",
    createdBy: "bootstrap",
    expiresAt: isoIn(cfg.auth.inviteHours * 3_600_000),
  });
  log("");
  log("  no users yet -- open ONE of these to create the first admin account:");
  /*
    EVERY configured origin, not just the first.

    The first is whatever name the app is CONFIGURED to live at, which may not be reachable
    yet -- printing only that hands the operator a link that 404s at their proxy.
    The server has no way to know which origin the reader can actually reach, so it lists
    them all rather than guessing, and the reader picks the one that works.
  */
  for (const origin of cfg.auth.origins) log(`    ${origin}/invite/${token}`);
  log(`  (valid for ${cfg.auth.inviteHours}h; mint another with the system API key)`);
  log("  NOTE: a passkey needs an https origin -- over plain http, use Continue with Plex.");
  log("");
}
if (!cfg.auth.adminApiKey) {
  log("note: FINDERR_ADMIN_API_KEY is unset -- the admin API is reachable only by an admin session");
}
// Read once at boot. Every logo lookup after this is a Set hit, never a file stat.
const logos = await loadLogoIndex(undefined, log);

// Facet providers. A plugin supplies facts core does not know how to fetch; the resolver
// keeps them in SQLite so no handler ever waits on one. Two ways in, one loader: files in
// the plugins directory, and installed packages named in `pluginModules`.
const plugins = await loadPlugins({
  dir: cfg.pluginsDir || undefined,
  modules: cfg.pluginModules,
  kv: store,
  log,
});
const facets = new FacetResolver({ store, registry: plugins, log });
log(`plugins: ${plugins.list().length} loaded`);

/*
  Sweep the contributions the loaded plugins have superseded.

  AFTER the registry is built, never during the load: mid-flight, a plugin that has not
  registered yet is indistinguishable from one that is gone, and the sweep would delete a
  live cache. It is a pure DELETE -- no provider is asked anything, so this cannot become a
  crawl of somebody else's infrastructure, and refilling stays the paced warm loop's job.

  It runs on EVERY boot rather than on a detected change. Editing a plugin is what strands a
  generation, and a boot is when a new version first becomes known; a no-op sweep costs one
  indexed DELETE per plugin against rows that are not there.
*/
const facetRowsPruned = store.pruneFacetContributions(plugins.currentVersions());
if (facetRowsPruned > 0) {
  log(`facets: pruned ${facetRowsPruned} contribution(s) superseded by a plugin version bump`);
}

if (!radarr && !sonarr) {
  log(
    "WARNING: neither Radarr nor Sonarr is configured -- requests will fail. Set FINDERR_RADARR_URL / FINDERR_SONARR_URL.",
  );
}

/*
  Plex, mirrored on the same timer and for the same reason.

  Unset URL or token = no client, `syncPlex` returns immediately and every title's `plex`
  field is null. Nothing else changes -- a finderr with no Plex is the ordinary case for a
  fresh checkout, exactly like a keyless `tmdb` plugin going dark.
*/
const plex = cfg.plex.url && cfg.plex.token ? new PlexClient(cfg.plex.url, cfg.plex.token) : undefined;
if (!plex) {
  log("plex: no FINDERR_PLEX_URL/FINDERR_PLEX_TOKEN -- play links are off");
}

/**
 * Whether our own index can draw a card for a title.
 *
 * The upcoming mirror stores only titles this returns true for -- see `upcoming.ts`. It
 * reads `live.current` at the moment of use rather than closing over an engine, because a
 * handle held across an index promote is unusable (see `live-index.ts`).
 */
function indexHasRow(tconst: string): boolean {
  return live.current.byTconst(tconst) !== null;
}

// Mirror the arr libraries on a timer so "do we have it?" is a local lookup.
async function refreshLibrary(): Promise<void> {
  // The episode half is SLICED rather than swept: it costs one Sonarr call per series, so
  // walking the whole library on this 60s timer would be hundreds of requests a minute.
  // `syncEpisodes` in `../lib/store` has the arithmetic.
  const res = await syncLibrary(
    store,
    { radarr, sonarr },
    { batch: cfg.episodeRefreshBatch, staleSeconds: cfg.episodeRefreshSeconds },
    log,
  );
  for (const e of res.errors) log(`library sync error -- ${e}`);
  // Same cadence, one function: "can I request it" and "can I play it" go stale together.
  // A failed walk leaves the previous mirror in place rather than emptying it -- a
  // ratingKey is stable, so stale beats absent for the one thing this feeds.
  const mirrored = await syncPlex(store, plex, log);
  if (mirrored.error) log(`library sync error -- ${mirrored.error}`);

  /*
    The arr calendars ride here too, and for the third time the same reason: they are the
    same fact going stale on the same clock. It is free -- both arrs are on the LAN and
    both already answer with the IMDb id, so there is no crosswalk and no third party.

    Caught rather than thrown, and caught PER SOURCE inside `syncArrCalendars`, because an
    upcoming shelf failing must not take the library mirror down with it.
  */
  try {
    for (const r of await syncArrCalendars({ store, hasRow: indexHasRow, log }, { radarr, sonarr })) {
      log(`upcoming: ${r.rows} from ${r.source}`);
    }
  } catch (err) {
    log(`upcoming sync error -- ${(err as Error).message}`);
  }
}
void refreshLibrary();
setInterval(() => void refreshLibrary(), cfg.libraryRefreshSeconds * 1000);

// Reconcile in-flight requests against the arr queues.
setInterval(() => void worker.reconcile(), 30_000);
worker.start();

/**
 * Say out loud what this process costs, on a timer.
 *
 * Added after an idle container sat at 20% of a core and 94% of its memory limit
 * with nothing in the logs but "1371 movies mirrored" once a minute. The cause was
 * the fuzzy pool's 9M-object heap keeping the collector permanently busy, and finding
 * that meant a manual dig through cgroup and per-thread /proc counters. A process
 * that cannot describe its own resource use makes every such question archaeology.
 *
 * The GC share is the field that matters: it is what distinguishes "busy" from
 * "thrashing", and it is invisible in process-wide CPU because JSC marks on its own
 * threads.
 */
const resources = new ResourceMonitor(log, () => live.current.poolStats());
resources.start(cfg.resourceLogSeconds * 1000);

/** The front page, as `./shelves` defines it, against this process's index and mirror. */
const shelvesOf = () => discoveryShelves({ engine: live.current, store });

/**
 * Warm everything reachable in ONE CLICK from a cold front page, so nothing on screen
 * is ever fetched while somebody waits.
 *
 * Two halves, in the order the eye needs them. Artwork is materialised completely --
 * resolve AND pull the bytes -- and pinned so eviction can never take it, because a
 * poster is the first thing that renders. Facets come second and are paced per title:
 * they are third-party calls, and a burst of them is the difference between a polite
 * client and a crawler.
 *
 * NEVER further than one click. Warming everything a user *might* search for is how
 * this becomes a 1.27M-row crawl; search results are deliberately not pre-warmable and
 * do not need to be, since a result card wants only local index data and a poster.
 *
 * Runs at boot and again every six hours. The second run is nearly free: an immutable
 * facet is fetched once in the product's lifetime, and shelf membership barely moves
 * from one day to the next, so a warm title costs neither a call nor a pause.
 */
async function warmShelves(): Promise<void> {
  const titles = frontPageTitles(shelvesOf());

  const res = await artwork.materialise(
    titles.map((t) => ({ tconst: t.tconst, kind: t.kind })),
    { pin: true },
  );
  const disk = await artwork.diskUsage();
  log(
    `artwork: shelves warmed -- ${res.ok} cached, ${res.missing} without art; ` +
      `cache ${disk.files} files / ${(disk.bytes / 1e6).toFixed(1)} MB`,
  );
  await artwork.evict(cfg.tmdb.cacheMaxBytes);

  // Rows cached before the studio column existed have a poster and no studio, and
  // nothing else ever revisits them -- so without this the badge stays missing on
  // exactly the titles the shelves show. Runs after warming so the shelf rows, which
  // are the ones on screen, are filled first.
  void artwork.backfillStudios(400).catch(() => {});

  const facetWarm = await facets.prewarm(titles.map(entityFor));
  log(
    `facets: shelves warmed -- ${facetWarm.fetched} titles fetched, ` +
      `${facetWarm.alreadyWarm} already warm, of ${titles.length}`,
  );
}

/*
  TMDB's upcoming lists, on a SLOW timer and deliberately not the library one.

  Six-hourly rather than every libraryRefreshSeconds because the answer barely moves -- a
  film's release date changes a handful of times in its life -- and because unlike the arr
  calendars this one costs a third party. It runs BEFORE `warmShelves` in the same tick so
  the titles it adds are warmed on this pass rather than waiting six hours for the next.

  No key means no shelf, quietly, the same way the `tmdb` plugin goes dark: two rows fewer
  and nothing else changes.
*/
async function refreshTmdbUpcoming(): Promise<void> {
  if (!cfg.tmdb.apiKey) return;
  const api = new TmdbApi(
    createPluginFetch({
      pluginId: "upcoming-sync",
      hosts: [TMDB_HOST],
      pacer: new HostPacer(DEFAULT_OUTBOUND_POLICY.minIntervalMsPerHost),
    }),
    cfg.tmdb.apiKey,
  );
  try {
    const res = await syncTmdbUpcoming({ store, hasRow: indexHasRow, log }, api, cfg.regions);
    for (const r of res) log(`upcoming: ${r.rows} from ${r.source}`);
  } catch (err) {
    // safeUrl already stripped the key from anything getJson reports; nothing here adds a URL.
    log(`upcoming sync error -- ${(err as Error).message}`);
  }
}

// Give the library mirror a moment to land first: "recently added" is read straight
// out of it, and owned titles are excluded from every other shelf -- so warming
// before it lands both misses a shelf and pays for posters we then filter out.
setTimeout(() => void refreshTmdbUpcoming().then(warmShelves), 8_000);
setInterval(() => void refreshTmdbUpcoming().then(warmShelves), 6 * 60 * 60 * 1000);

/**
 * Import the award nominations, in-process and never on a request path.
 *
 * ONCE at boot if there is nothing stored, then daily. It is not on the six-hourly loop
 * above because the data genuinely changes once a year: the Academy announces in March and
 * `oscar_data` catches up within weeks. A daily check costs one conditional-ish 2.2 MB read
 * of somebody's public repo, which is polite; six-hourly would be four times that for no
 * new fact.
 *
 * Failures are logged and swallowed. A finderr with no nominations is a finderr whose
 * awards page is empty, which is the same shape as a keyless `tmdb` plugin going dark -- it
 * must never be the reason the server does not come up.
 */
async function refreshAwards(): Promise<void> {
  try {
    const meta = await importAwards(store);
    log(`awards: ${meta.rows.toLocaleString()} nominations from ${meta.sha?.slice(0, 10) ?? "main"}`);
  } catch (err) {
    log(`awards import failed -- ${(err as Error).message}`);
  }
}

// Only on a cold store. A redeploy keeps its data directory, so re-importing on every boot
// would download 2.2 MB to write rows that are already there -- and a container that
// restarts in a loop would do it every time.
if (store.awardCount(OSCARS) === 0) {
  log("awards: nothing stored -- importing");
  setTimeout(() => void refreshAwards(), 12_000);
}
setInterval(() => void refreshAwards(), 24 * 60 * 60 * 1000);

// --- helpers ---------------------------------------------------------------

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // A JSON body must never be sniffed into something executable, whoever asked.
      "X-Content-Type-Options": "nosniff",
      ...(init.headers ?? {}),
    },
  });

/**
 * The headers every HTML response carries. finderr will be internet-facing, and the app
 * ships no inline scripts, no external fonts and no cross-origin fetches (posters and
 * facet images are proxied through our own origin; the only third-party URLs are plain
 * navigations) -- so `'self'` everywhere is a statement of fact, not an aspiration.
 * `style-src` allows inline because Tailwind-driven style ATTRIBUTES fall under it.
 */
const HTML_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
} as const;

const bad = (msg: string, status = 400) => json({ error: msg }, { status });

/** The width an image route was asked for. One reader, so both routes accept the same thing. */
function sizeOf(req: Request): string {
  return new URL(req.url).searchParams.get("size") ?? DEFAULT_IMAGE_SIZE;
}

/** Decide which service a title belongs to. Everything episodic goes to Sonarr. */
function serviceFor(kind: string): "radarr" | "sonarr" {
  // Same "is this episodic?" question the facet vocabulary answers, so it has one owner.
  return entityKindFor(kind) === "series" ? "sonarr" : "radarr";
}

/**
 * An index row as the thing a facet provider is asked about.
 *
 * `ids` is the field that was declared for this from the start and stood empty but for the
 * tconst until the crosswalk landed: **external ids we already hold**. A provider handed
 * `ids.tmdb` skips its own `/find`, which was the first link in two of the three chains a
 * cold title used to walk. One indexed primary-key lookup against a table already open,
 * and `idsFor` answers `{}` rather than throwing on an index built before it existed.
 *
 * `live.current` is read HERE rather than being closed over, per the retired-engine rule.
 */
function entityFor(row: TitleRow): FacetEntity {
  return {
    kind: entityKindFor(row.kind),
    tconst: row.tconst,
    title: row.title,
    originalTitle: row.orig,
    year: row.year,
    runtime: row.runtime,
    ids: { imdb: row.tconst, ...live.current.idsFor(row.tconst) },
  };
}

/**
 * Attach library + request + artwork state to search hits, from local mirrors only.
 *
 * `posterUrl` always points at OUR proxy, never at image.tmdb.org or thetvdb --
 * finderr will be internet-facing while Radarr/Sonarr stay on the LAN, so the
 * browser must never be told a URL it could not reach anyway, and we do not want
 * to leak which metadata providers sit behind us.
 *
 * A title we have already looked up and found no artwork for gets `null`, so the
 * client renders its fallback tile immediately instead of firing a doomed request.
 *
 * `studioLogo` is resolved HERE rather than in the browser: the slug set lives on the
 * server, so the client is handed a ready path or a null and needs no manifest, no
 * slugify, and no 404-probing for logos that do not exist.
 *
 * `plex` is resolved here for the same reason, and it is the one field that is a URL out
 * rather than a fact. The address needs the server's `machineIdentifier`, which the client
 * has no business holding a copy of, so the server builds the pair or sends null. Note that
 * it is NOT implied by `hasFile`: the arr can have imported a file that Plex has not
 * scanned yet, and only the Plex mirror knows the difference -- which is exactly why it is
 * a separate mirror rather than a third `service` in the library table.
 */
function decorate<T extends TitleRow>(rows: T[]) {
  const lib = store.libraryMap();
  const reqs = store.requestMap();
  const plex = store.plexMap();
  const machineId = store.plexMachineIdentifier() ?? "";
  return rows.map((r) => {
    const l = lib.get(r.tconst);
    const q = reqs.get(r.tconst);
    const art = store.getArtwork(r.tconst);
    const ratingKey = plex.get(r.tconst);
    return {
      ...r,
      inLibrary: !!l,
      hasFile: l ? l.has_file === 1 : false,
      progress: l?.progress ?? null,
      requestStatus: q?.status ?? null,
      service: serviceFor(r.kind),
      posterUrl: art !== undefined && art.url === null ? null : `/img/t/${r.tconst}`,
      studio: art?.studio ?? null,
      studioLogo: logos.urlForTitle(r.kind, art?.studio),
      plex: ratingKey ? plexLinks(machineId, ratingKey) : null,
    };
  });
}

/**
 * Our Sonarr's per-episode state for one series.
 *
 * Read straight out of the mirror, so this is local SQLite like every other render-path
 * read. The shape and the reason it is a list rather than a keyed object are stated once,
 * in `src/lib/episodes.ts`.
 */
function episodeStateFor(tconst: string): EpisodeState[] {
  return [...store.episodeMap(tconst).values()].map((e) => ({
    season: e.season,
    episode: e.episode,
    arrEpisodeId: e.arr_episode_id,
    hasFile: e.has_file === 1,
    monitored: e.monitored === 1,
    airDate: e.air_date,
  }));
}

/**
 * The index rows for a resolved `collection` facet's members, in the collection's order.
 *
 * Local lookups only -- the tconsts already arrived with the facet, so this is the render
 * path doing what the render path is allowed to do. A member missing from our index (a
 * title type we do not ingest, or one below no floor we apply here but simply absent)
 * yields nothing rather than a placeholder.
 */
function collectionRows(resolvedFacets: ResolvedFacets): TitleRow[] {
  const resolved = resolvedFacets.collection;
  if (resolved?.status !== "ready" || !resolved.data) return [];
  return rowsFor(resolved.data.parts);
}

/**
 * The same, for `related` -- "more like this".
 *
 * A recommendation whose tconst never resolved, or which we simply do not index, yields
 * nothing. That is what keeps the row honest: every card in it is a real destination.
 */
function relatedRows(resolvedFacets: ResolvedFacets): TitleRow[] {
  const resolved = resolvedFacets.related;
  if (resolved?.status !== "ready" || !resolved.data) return [];

  // Recommendations name films by TMDB id and we index by IMDb. The crosswalk is done
  // HERE, against `externalIds` rows we already hold, precisely so it costs no upstream
  // call: asking the proxy per recommendation is eleven calls for one film view, which is
  // the sweep the one-click-deep rule forbids. Coverage grows as titles are opened.
  const needed = resolved.data.flatMap((r) => (!r.tconst && r.tmdbId ? [r.tmdbId] : []));
  const known = store.tconstsByTmdbId(needed);

  return rowsFor(resolved.data.map((r) => ({ tconst: r.tconst ?? known.get(r.tmdbId ?? -1) ?? null })));
}

/**
 * Index rows for a list of facet entries that name titles, in the order given.
 *
 * One helper rather than one per facet: `collection` and `related` differ in what they
 * MEAN, not in how a tconst becomes a card, and a second copy would drift the first time
 * either grew a rule about what to drop.
 */
function rowsFor(entries: readonly { tconst: string | null }[]): TitleRow[] {
  return entries.flatMap((e) => {
    const row = e.tconst ? live.current.byTconst(e.tconst) : null;
    return row ? [row] : [];
  });
}

/**
 * Cached `collection` contributions the loaded plugins still stand behind.
 *
 * The one place the reverse read is assembled, so both collection handlers apply the
 * same liveness rule the title page does -- a page built on rows from a deleted plugin
 * would outlive the plugin that produced them.
 */
function liveCollectionRows(contentId?: string) {
  return store
    .facetContributionsByContentId("collection", contentId)
    .filter((row) => isLiveContribution(plugins, row));
}

/**
 * Facet coverage per shelf -- the card's acceptance, one `curl` away.
 *
 * `isWarm` reads the facet cache and asks no provider: a health check that warmed the
 * cache would only ever be reporting on itself. It costs one indexed SQLite lookup per
 * shelf title on top of the shelf queries, which is why it lives on `/api/health` and
 * on no path a user is waiting on.
 */
const shelfCoverage = () => facetCoverage(shelvesOf(), (row) => facets.isWarm(entityFor(row)));

/**
 * What the award handlers read, resolved at the moment of use.
 *
 * `live.current` is read INSIDE the function rather than captured, for the reason stated
 * at length in `live-index.ts`: an engine held across a promote either throws a disk I/O
 * error or, under load, silently serves yesterday's row.
 *
 * The provenance is read from `kv` on every call. It is one indexed lookup against a row
 * that changes once a year, and caching it in a module const is exactly how the awards
 * page would go on naming last year's commit after an import.
 */
const awardsDeps = (): AwardsDeps => ({
  store,
  engine: live.current,
  decorate,
  source: awardSourceMeta(store),
});

const staticDir = `${import.meta.dir}/../../web/dist`;
const haveStatic = existsSync(staticDir);
if (!haveStatic) log(`note: no web build at ${staticDir} -- API only. Run 'bun run build'.`);

// --- routes ----------------------------------------------------------------

/*
  The application's own routes, as a value.

  They are declared here rather than inline in `Bun.serve` so `withAuth` can wrap the whole
  table -- which is what makes a route added tomorrow private by DEFAULT. The cost is that
  Bun can no longer infer `req.params` from the path literal, so every handler with a
  parameter names its own `Bun.BunRequest<"...">`. That is the trade taken deliberately:
  seven explicit annotations against a guard that cannot be forgotten.
*/
const appRoutes = {
  /**
   * Is there an index to search yet, and if not, how is the build going?
   *
   * PUBLIC and deliberately so -- the progress page it feeds is what an anonymous visitor
   * gets during a first install, before any account exists to sign in with. It discloses
   * only a phase, a duration and the build job's own newest line; no path, no host, no
   * counts. Contrast `/api/health`, which is public for liveness and hands the DETAIL
   * only to an admin.
   *
   * On a server with an index this is a constant `{ ready: true, build: null }`, which is
   * what lets the page reload itself the moment the swap lands.
   */
  "/api/index-status": () => json({ ready: live.ready, build: indexBuild?.state ?? null }),

  /**
   * Liveness, and optionally the expensive coverage report.
   *
   * `?coverage=1` adds `facets.coverage`, which runs every shelf query plus one
   * facet lookup per shelf title. That costs ~1.9 SECONDS against the real index --
   * 400x a search -- and it used to run on EVERY call. Docker's HEALTHCHECK hits
   * this endpoint every 30 seconds, so the probe alone burned ~6% of a core forever,
   * asking a question nobody was reading.
   *
   * The acceptance check the metadata epic documents still works, it just has to ask
   * for it: `curl 'localhost:7979/api/health?coverage=1' | jq .facets.coverage`.
   */
  "/api/health": (req: Request) => {
    // Liveness is public; every FACT below it is not. See the caution on `healthPayload`.
    // An admin session or the system API key gets the detail, anybody else gets `ok`.
    const detailed = auth.principal(req)?.role === "admin";
    const rt = runtimeSnapshot();
    // Read from the holder, NOT from a `meta` captured at boot. That const is what made
    // this endpoint go stale the moment the index was swapped -- it would have gone on
    // reporting yesterday's row count and build date forever.
    const meta = live.meta();
    return json(
      healthPayload(
        {
          index: {
            rows: Number(meta.rows ?? 0),
            builtAt: meta.built_at ?? null,
            reload: live.lastReload,
          },
          library: store.libraryCount(),
          plex: { items: store.plexCount(), machineId: store.plexMachineIdentifier() },
          upcoming: {
            radarr: store.upcomingCount("radarr"),
            sonarr: store.upcomingCount("sonarr"),
            tmdbMovie: store.upcomingCount("tmdb-movie"),
            tmdbSeries: store.upcomingCount("tmdb-series"),
          },
          awards: (() => {
            const meta = awardSourceMeta(store);
            return {
              rows: store.awardCount(OSCARS),
              sha: meta?.sha ?? null,
              importedAt: meta?.importedAt ?? null,
            };
          })(),
          services: { radarr: !!radarr, sonarr: !!sonarr },
          auth: {
            users: authStore.userCount(),
            admins: authStore.adminCount(),
            sessions: authStore.sessionCount(),
            apiKey: !!cfg.auth.adminApiKey,
            // The NAME, not a boolean: "auth is off" and "auth is off and everyone is aannarr"
            // are different facts, and the second is the one that explains what a reader is
            // looking at. Null is the ordinary case and every deployment. This block is
            // admin-only, so it discloses the account name to nobody who could not already
            // list every user.
            devLoginAs: cfg.auth.devLoginAs ?? null,
          },
          queue: worker.stats(),
          artwork: artwork.stats(),
          plugins: plugins.list().map((p) => p.meta.id),
          facetRows: store.facetCacheCount(),
          facetImages: store.facetImageCount(),
          facetRowsPruned,
          timings: { providers: facets.timingReport(), outbound: outboundTimings().report() },
          runtime: {
            uptimeSeconds: Math.round(rt.uptimeSeconds),
            rss: rt.rss,
            heapUsed: rt.heapUsed,
            cgroup: rt.cgroup
              ? {
                  current: rt.cgroup.current,
                  limit: rt.cgroup.limit,
                  ratio: rt.cgroup.ratio,
                  anon: rt.cgroup.anon,
                  file: rt.cgroup.file,
                  atLimit: rt.cgroup.maxEvents,
                }
              : null,
            cpuSeconds: Math.round(rt.cpu.totalSeconds),
            gcSeconds: rt.cpu.gcSeconds === null ? null : Math.round(rt.cpu.gcSeconds),
            fuzzy: live.current.poolStats(),
          },
          // Passed as a thunk, never a value -- see health.ts.
          coverage: shelfCoverage,
        },
        { coverage: new URL(req.url).searchParams.get("coverage") === "1", detailed },
      ),
    );
  },

  "/api/search": (req: Request) => {
    /*
        The one route with its own limiter on top of the login wall.

        A fuzzy query is real CPU work over a 1.27M-row index -- roughly 400x a cached read
        -- so a loop of typos pins a core. That is true of a SIGNED-IN caller too, which is
        why the check is here rather than in the guard: authentication says who somebody
        is, not how much of the machine they may have.
      */
    // The SAME key derivation the auth limiter uses, on purpose: a second copy here
    // would go on counting the whole internet against the proxy's socket address the
    // day proxy trust is turned on for the auth routes.
    const key = auth.clientIp(req);
    if (!auth.searchLimiter.take(key)) {
      return json(
        { error: "too many searches" },
        { status: 429, headers: { "Retry-After": String(auth.searchLimiter.retryAfter(key)) } },
      );
    }

    const u = new URL(req.url);
    const q = u.searchParams.get("q")?.trim() ?? "";
    if (!q)
      return json({
        hits: [],
        facets: { genre: [], decade: [], year: [], kind: [] },
        tier: "empty",
        ms: 0,
      });

    const num = (k: string) => {
      const v = u.searchParams.get(k);
      if (v === null) return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? undefined : n;
    };

    const res = live.current.search(q, {
      limit: Math.min(num("limit") ?? 25, 100),
      genre: u.searchParams.get("genre") ?? undefined,
      decade: num("decade"),
      year: num("year"),
      kind: u.searchParams.get("kind") ?? undefined,
    });

    // Resolve artwork for whatever the user is about to look at, in the
    // background. Never blocks the response.
    artwork.prewarm(res.hits.map((h) => ({ tconst: h.tconst, kind: h.kind })));

    return json(
      { ...res, hits: decorate(res.hits) },
      // Identical queries are extremely common while typing. A short private cache
      // means the back button and repeated keystrokes cost nothing at all.
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  },

  /**
   * A title, plus whatever facets are already cached.
   *
   * The handler NEVER awaits a provider: it reads the facet cache and kicks the
   * resolver in the background. A facet nobody has answered yet comes back `pending`,
   * which the page renders as a skeleton, and it is there on the next view.
   */
  "/api/title/:tconst": (req: Bun.BunRequest<"/api/title/:tconst">) => {
    const row = live.current.byTconst(req.params.tconst);
    if (!row) return bad("unknown title", 404);

    const entity = entityFor(row);
    // Rewritten before it leaves: every image a provider sent points at this origin, so
    // no upstream hostname appears in the JSON and `localImageUrl()` in the browser
    // passes it. Reads and writes local SQLite only.
    const cached = facetImages.rewrite(facets.read(entity));
    // Read the work state BEFORE warming: `workState` asks nobody, and taking it after
    // `warm()` would report the providers this very request just started as outstanding
    // even when they answer instantly from a coalesced in-flight call.
    const work = facets.workState(entity);
    facets.warm(entity);

    return json(
      {
        ...decorate([row])[0],
        facets: cached,
        /*
            WHERE AN ADMIN GOES TO MANAGE THIS TITLE, and null for everybody else.

            Stripped on the SERVER rather than hidden in the component, exactly as
            `requested_by` is: an arr's address describes the private network finderr
            fronts, and a component that declines to draw a link still ships the string.
            `arrLink` (`src/lib/arr-links.ts`) is the single owner of the rule -- it is
            also the only place in this product that deliberately sends a browser an
            upstream URL, which is why it takes the role rather than being handed one.
          */
        arrLink: arrLink(cfg, store.libraryMap().get(row.tconst), auth.principal(req)?.role ?? null),
        /*
            OUR SONARR'S per-episode state, one entry per episode it lists.

            Beside the facets rather than inside them, the same reasoning `people` follows:
            the `episodes` facet is skyhook's answer to "what exists", and this is our own
            Sonarr answering "which of those do we hold, and may one be asked for". The
            shape, and why it is a list keyed on two integers rather than a string, are
            stated once in `src/lib/episodes.ts`.

            An EMPTY array means Sonarr does not hold this series, which is a real answer
            and renders as no marks at all rather than as a row of crosses.
          */
        episodeState: episodeStateFor(row.tconst),
        /*
            IS ANYONE STILL WORKING ON THIS TITLE, AND WHAT HAS ALREADY GONE WRONG.

            The client polls on `working` rather than on a timer of its own. That matters
            because `pending` alone cannot answer the question: a facet is `pending` while
            any provider owes it an answer, so a facet whose provider was REFUSED by the
            outbound gate is `pending` with nobody working on it. A browser guessing from
            statuses would keep a skeleton up for work that is not happening.

            It terminates without needing a client-side cap: every provider either answers
            or is cancelled at the hard deadline, and `callProvider` writes a row for every
            outcome, so `working` drains on its own.

            `problems` names the PLUGIN and a fixed reason CODE -- never an error message,
            which can carry an upstream URL with a credential in it. The code's job is to
            tell a reader which addon failed and send them to the log for the detail.
          */
        work,
        /*
            Our own ids for the people credited on this title, keyed by folded name.
            Sent alongside the facets rather than merged into them: the cast facet is a
            PROVIDER's data and identifies people by TMDB id, while this is OUR index
            answering a different question. Writing nconsts into the facet would make the
            cached provider payload depend on which index built it.

            One indexed lookup, and empty on an index without cast tables -- the client
            then renders names as plain text, which is what the dead-end rule wants when
            there is nowhere to go.
          */
        people: Object.fromEntries(live.current.nconstsByNameForTitle(row.tconst)),
        /*
            The collection's other films as OUR rows, decorated like any search hit.

            A sibling to the facet rather than folded into it, for the same reason
            `people` is: the facet is a PROVIDER's answer and says only tconst + title,
            while a card needs a poster, library state and a request button -- none of
            which a provider knows and all of which come from local state.

            A member we do not hold is DROPPED rather than drawn as a stub: a tile with
            no poster, no library state and no request button is a dead end wearing a
            poster frame. Order is the collection's own, which is release order.
          */
        collectionTitles: decorate(collectionRows(cached)),
        /** "More like this", as our rows. Same reasoning as `collectionTitles`. */
        relatedTitles: decorate(relatedRows(cached)),
        /*
            Plugin-authored panes, RENDERED HERE rather than in the browser.

            `render` is a function, so it cannot travel; and shipping plugin code to the
            client would weld every addon to our React version and let an addon bug take
            the page down. So it runs on the server over the facets we have ALREADY read
            from local SQLite -- pure, synchronous, no fetch -- and only the resulting
            blocks are sent. Rendering AFTER the image rewrite means a pane reads the same
            same-origin URLs every other consumer does.

            An empty array is the ordinary case: no plugin in the tree declares a pane.
          */
        panes: renderPanes(plugins.panes(), cached, log),
        /*
            THIS FILM'S AWARD RECORD, and it is NOT a facet.

            A facet is a plugin's answer fetched from somebody else's server and cached with
            a freshness class; this is a dataset we imported wholesale on a yearly timer and
            hold in our own tables. It is therefore always ready at t=0 -- there is no
            provider to owe it an answer, no `pending` state and nothing for `paneView` to
            decide -- which is exactly the situation `LinksRow` is in, and it is drawn the
            same way.

            `null` for the overwhelming majority of titles, which the pane renders as
            nothing at all.
          */
        awards: titleAwards(store, row.tconst, OSCARS),
      },
      // Shorter than the 300s the local-only version used: this response now carries
      // facets that fill in behind it, and a stale cache would hide them.
      { headers: { "Cache-Control": "private, max-age=30" } },
    );
  },

  "/api/browse": (req: Request) => {
    const u = new URL(req.url);
    const num = (k: string) => {
      const v = u.searchParams.get(k);
      if (v === null) return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? undefined : n;
    };
    const res = live.current.browse({
      genre: u.searchParams.get("genre") ?? undefined,
      decade: num("decade"),
      year: num("year"),
      kind: u.searchParams.get("kind") ?? undefined,
      // An unknown `sort` falls back to the default rather than 400ing: it reaches SQL as
      // an ORDER BY, so it is validated against the closed union at the door, and a stale
      // bookmark asking for a sort we removed should still render the grid.
      sort: isBrowseSort(u.searchParams.get("sort")) ? (u.searchParams.get("sort") as BrowseSort) : undefined,
      minVotes: num("minVotes"),
      limit: Math.min(num("limit") ?? 60, 200),
      offset: num("offset") ?? 0,
    });
    return json(
      { ...res, rows: decorate(res.rows) },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  },

  /**
   * One collection, and every member we hold -- the node behind the title page's chip.
   *
   * The id is the FACET's id verbatim (`tmdb:2344`), namespace and all. Stripping it to
   * a bare number would put "collections are always TMDB" in the route, so a second
   * provider's id space could not arrive without a URL migration.
   *
   * Local SQLite only, like every other render-path handler: the members already
   * arrived with the cached facet, so this asks no provider and warms nothing. A
   * collection nobody has viewed a member of has no page yet, which is a 404 rather
   * than a fetch -- resolving one on demand is exactly the blocking call the governing
   * rule forbids.
   *
   * No vote floor. A collection is an explicit membership list, not the broad grid
   * `browseVoteFloor` exists to curate, so there is nothing to hide and no escape
   * hatch to offer -- what we cannot render is reported as `missing` instead.
   */
  "/api/collection/:id": (req: Bun.BunRequest<"/api/collection/:id">) => {
    // `live.current` is read INSIDE the callback, at the moment of use: a promote
    // during the daily refresh kills whatever engine we were already holding, so a
    // reference hoisted out of this arrow would start throwing disk I/O errors.
    const page = collectionPage(liveCollectionRows(req.params.id), (t) => live.current.byTconst(t));
    if (!page) return bad("unknown collection", 404);

    return json(
      { ...page, titles: decorate(page.titles) },
      // Shorter than browse's 300s: membership GROWS as more of the franchise is
      // viewed, since each member's own cached row names the others. A long cache
      // would hide a film that arrived a minute ago.
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  },

  /**
   * Collections whose name matches `?q=`, best match first.
   *
   * What turns `collection:"lord of the rings"` into an address. EVERY match comes
   * back, because names are neither unique nor stable and picking one here would be the
   * server quietly choosing a franchise on the reader's behalf; the client shows the
   * choice when there is one.
   */
  "/api/collections": (req: Request) => {
    const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    const matches = q.length === 0 ? [] : collectionsMatchingName(liveCollectionRows(), q);
    /*
        NEVER CACHED, and the 60s this carried is what proved why. A collection becomes
        addressable the moment any of its films is viewed, so an empty answer is the one
        thing here with a short shelf life -- and a cached one tells a reader for a whole
        minute that a franchise does not exist, seconds after they made it exist. It costs
        one indexed scan of the collection rows, which is not a thing worth caching.
      */
    return json({ matches }, { headers: { "Cache-Control": "no-store" } });
  },

  /**
   * A person and their filmography.
   *
   * Local SQLite only, like every other render-path handler -- the reverse index is
   * exactly what makes that possible, and a person page must not become the one view
   * that waits on a provider.
   *
   * 404 covers two different things on purpose: an id we have never held, and an index
   * built before the cast tables existed. Both mean "there is no page here", and the
   * second is temporary -- it resolves itself at the next nightly rebuild.
   */
  "/api/person/:nconst": (req: Bun.BunRequest<"/api/person/:nconst">) => {
    const u = new URL(req.url);
    const num = (k: string) => {
      const v = u.searchParams.get(k);
      if (v === null) return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? undefined : n;
    };
    const page = live.current.personPage(req.params.nconst, {
      // Comma-separated, because `actor` and `actress` are one job to a reader and
      // filtering on one of them would silently drop half an Acting filmography.
      categories: (u.searchParams.get("category") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      limit: Math.min(num("limit") ?? 60, 200),
      offset: num("offset") ?? 0,
    });
    if (!page) return bad("unknown person", 404);

    return json(
      {
        ...page,
        credits: decorate(page.credits),
        /*
            THEIR AWARD RECORD, from our own tables and joined on the nconst.

            Beside the credits rather than inside them, the same shape `people` follows on
            the title payload: a credit is our INDEX saying they worked on a film, and this
            is a mirrored dataset saying the Academy nominated them. Merging the two would
            make a credit row mean two different things.

            `null` when they have none, which is nearly everybody -- so the person page
            draws nothing at all rather than "0 nominations". One indexed lookup.
          */
        awards: personAwards(store, req.params.nconst, OSCARS),
      },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  },

  /**
   * Every Academy Award ceremony, newest first.
   *
   * Local SQLite the whole way down, like every other render-path handler: the nominations
   * were imported by a job on a yearly clock and this only reads them, joins the anchor
   * films against the live index and counts ownership against the library mirror.
   *
   * A checkout that has never run the import gets `ceremonies: []` and a null `source`,
   * which the page renders as "no awards imported yet" rather than as an error -- the
   * import is optional in exactly the way the cast tables are.
   */
  "/api/awards/oscars": () =>
    json(
      timelinePayload(awardsDeps()),
      // Long, because the underlying rows change once a year. The ownership counts ride on
      // the same response and move faster than that -- but they move on a library sync, and
      // a private 10-minute window on a page nobody watches for library changes is the
      // right trade. `private` because the counts are about THIS instance's library.
      { headers: { "Cache-Control": "private, max-age=600" } },
    ),

  /**
   * One ceremony, every category, winner first.
   *
   * The parameter is the CEREMONY NUMBER, never the year: `Year` is `1927/28` for the first
   * six and is a label rather than a key. A non-numeric or unknown ceremony is a 404, which
   * is the same answer `/api/collection/:id` gives for an id we hold nothing under.
   */
  "/api/awards/oscars/:ceremony": (req: Bun.BunRequest<"/api/awards/oscars/:ceremony">) => {
    const ceremony = Number.parseInt(req.params.ceremony, 10);
    if (!Number.isFinite(ceremony)) return bad("unknown ceremony", 404);
    const page = ceremonyPayload(awardsDeps(), ceremony);
    if (!page) return bad("unknown ceremony", 404);
    return json(page, { headers: { "Cache-Control": "private, max-age=600" } });
  },

  /**
   * The discovery shelves, decorated with local library and request state.
   *
   * `discoveryShelves()` owns which titles are on the front page; this handler only
   * turns index rows into cards. The warm loop reads the same function, which is what
   * makes "every shelf title is already warm" true by construction.
   */
  "/api/discover": () =>
    json(
      { shelves: shelvesOf().map(({ rows, ...shelf }) => ({ ...shelf, titles: decorate(rows) })) },
      { headers: { "Cache-Control": "private, max-age=600" } },
    ),

  "/api/requests": {
    /**
     * The request log, with WHO stripped out for everyone but an admin.
     *
     * > [!CAUTION] `visibleRequest` is not decoration, it is the privacy rule
     * > aannarr, 2026-08-31: only admins may see who requested what, and the fact must not
     * > leak to a normal user. Hiding the name in the component that draws the row would
     * > leave the id sitting in the JSON, one devtools tab away from every user on the
     * > system. It is stripped HERE, on the server, by the one function that owns the
     * > rule -- and a test in `auth.test.ts` pins it.
     */
    GET: (req: Request) => {
      const role = auth.principal(req)?.role ?? null;
      return json({
        requests: store.listRequests(undefined, 200).map((r) => visibleRequest(r, role)),
        queue: worker.stats(),
      });
    },

    /**
     * Enqueue and return IMMEDIATELY. The user carries on searching while the
     * add happens in the background; the client polls /api/requests for the
     * outcome and raises a toast.
     */
    POST: async (req: Request) => {
      let body: { tconst?: string; seasons?: unknown };
      try {
        body = (await req.json()) as { tconst?: string; seasons?: unknown };
      } catch {
        return bad("body must be JSON");
      }
      if (!body.tconst) return bad("tconst is required");

      const parsed = parseSeasonsInput(body.seasons);
      if ("error" in parsed) return bad(parsed.error);

      /*
        Per-request arr settings are ADMIN-ONLY -- aannarr, 2026-08-31.

        Quality profile and root folder decide what gets downloaded and onto which disk, so
        they are a library-management decision rather than a request. An ordinary user asks
        for a title; an admin decides how it arrives.

        A non-admin who sends them is REFUSED rather than ignored. Silently dropping the
        fields would leave a client believing a 4K profile had been honoured while the
        service default quietly downloaded something else, and "we did what you asked"
        being false is worse than "you may not ask that".
      */
      const overrides = parseRequestOverrides(body);
      if ("error" in overrides) return bad(overrides.error);
      if (hasOverrides(overrides.overrides) && auth.principal(req)?.role !== "admin") {
        return bad("only an admin may choose a quality profile or root folder", 403);
      }

      const row = live.current.byTconst(body.tconst);
      if (!row) return bad("unknown title", 404);

      const service = serviceFor(row.kind);
      if (service === "radarr" && !radarr) return bad("Radarr is not configured", 503);
      if (service === "sonarr" && !sonarr) return bad("Sonarr is not configured", 503);

      // Radarr has no seasons. Refusing rather than ignoring: a client sending seasons
      // for a film has misunderstood something, and silently dropping the field would
      // let it keep believing the selection was honoured.
      if (service === "radarr" && parsed.seasons) return bad("a film has no seasons to select");

      if (store.libraryMap().has(row.tconst)) return bad("already in your library", 409);

      const asker = auth.principal(req);
      const request = store.createRequest({
        tconst: row.tconst,
        title: row.title,
        year: row.year,
        kind: row.kind,
        service,
        seasons: parsed.seasons,
        // Null when the system key made the request: an agent is not a person and owns
        // nothing. Attribution is a fact about a human or it is absent.
        requestedBy: asker?.user?.id ?? null,
        overrides: overrides.overrides,
      });
      worker.enqueue(row.tconst);
      // Echoed back through the same strip: the asker sees their own request, but the
      // response shape must not depend on who is reading it in one place and not another.
      return json({ request: visibleRequest(request, asker?.role ?? null) }, { status: 202 });
    },
  },

  /**
   * Ask for ONE episode of a series Sonarr already holds.
   *
   * > [!IMPORTANT] ADDITIONAL to the series and season request, never a replacement
   * > aannarr, 2026-08-31, in as many words. `/api/requests` still adds a series and still
   * > takes a season selection; this is the third grain, and it is the only one that
   * > applies to a series ALREADY in the library -- which is precisely the case the other
   * > two refuse (`already in your library`, 409).
   *
   * It writes no `request` row. The record of "did we ask for this, and did it arrive" is
   * the episode mirror, which reports `monitored` and then `hasFile` from Sonarr itself; a
   * second record would give one fact two owners. See the `Job` type in
   * `./request-worker.ts` for the whole of that reasoning.
   *
   * Every refusal here is a fact about OUR mirror rather than about Sonarr, so none of them
   * costs a network call and none needs sanitising.
   */
  "/api/requests/episode": {
    POST: async (req: Request) => {
      if (!sonarr) return bad("Sonarr is not configured", 503);

      let body: { tconst?: string; season?: unknown; episode?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return bad("body must be JSON");
      }
      const { tconst, season, episode } = body;
      if (!tconst) return bad("tconst is required");
      if (!Number.isInteger(season) || !Number.isInteger(episode)) {
        return bad("season and episode must be integers");
      }

      const entry = store.libraryMap().get(tconst);
      // The series has to be in Sonarr before one of its episodes can be. Refusing rather
      // than adding it: adding a series is a different, heavier operation with a season
      // selection of its own, and the button for it is on the same page.
      if (entry?.service !== "sonarr") {
        return bad("request the series first -- Sonarr does not hold it yet", 409);
      }

      const known = store.getEpisode(tconst, season as number, episode as number);
      if (!known) return bad("Sonarr does not list that episode", 404);
      if (known.has_file === 1) return bad("you already have that episode", 409);

      worker.enqueueEpisodes(tconst, [known.arr_episode_id]);
      return json({ queued: { tconst, season, episode } }, { status: 202 });
    },
  },

  /**
   * The quality profiles and root folders each configured arr offers. ADMIN ONLY.
   *
   * > [!IMPORTANT] ONE route for all four lists, and it is the only network call on any
   * > route in this file
   * > The card asked for four endpoints. Four would mean four round trips to draw one small
   * > panel, and the client needs all of them at once or none of them -- a profile picker
   * > with no folder picker is half a form. So it is one call returning one object.
   * >
   * > It also breaks the governing rule of this file -- the render path touches nothing but
   * > local SQLite -- and that is why it lives HERE rather than being folded into
   * > `/api/title/:tconst`. Nothing renders on it: the title page draws in full without it,
   * > and only an admin opening the request panel pays for it. Putting these fields on the
   * > title payload would have made every reader wait on Radarr for a control they cannot
   * > see.
   *
   * A service that is not configured, or that will not answer, contributes `null` rather
   * than failing the whole call -- an admin with a dead Sonarr should still be able to
   * choose a Radarr profile.
   */
  "/api/arr/options": async (req: Request) => {
    const refused = auth.requireAdmin(req);
    if (refused) return refused;

    // `allSettled` rather than `all`: one arr being down must not take the other's lists
    // with it, and both are separately optional in config to begin with.
    const ask = async <T>(fn: (() => Promise<T | null>) | undefined): Promise<T | null> => {
      if (!fn) return null;
      try {
        return await fn();
      } catch (err) {
        log(`arr options: ${(err as Error).message}`);
        return null;
      }
    };

    const [radarrProfiles, radarrFolders, sonarrProfiles, sonarrFolders] = await Promise.all([
      ask(radarr && (() => radarr.qualityProfiles())),
      ask(radarr && (() => radarr.rootFolders())),
      ask(sonarr && (() => sonarr.qualityProfiles())),
      ask(sonarr && (() => sonarr.rootFolders())),
    ]);

    return json({
      radarr: radarr ? { qualityProfiles: radarrProfiles ?? [], rootFolders: radarrFolders ?? [] } : null,
      sonarr: sonarr ? { qualityProfiles: sonarrProfiles ?? [], rootFolders: sonarrFolders ?? [] } : null,
    });
  },

  "/api/requests/:tconst/retry": {
    // POST only, which the client already sends. A bare function answers GET too, and a
    // state-changing GET rides a `SameSite=Lax` cookie on any cross-site navigation --
    // an off-site link that re-enqueues arr work is CSRF wearing a retry button.
    POST: (req: Bun.BunRequest<"/api/requests/:tconst/retry">) => {
      const r = store.getRequest(req.params.tconst);
      if (!r) return bad("unknown request", 404);
      store.updateRequest(r.tconst, { status: "queued", error: null });
      worker.enqueue(r.tconst);
      return json({ ok: true });
    },
  },

  /**
   * Poster by IMDb id -- the route the UI actually uses.
   *
   * Resolves imdb -> poster URL via Radarr/Sonarr on first request, then serves
   * bytes from local disk forever. The browser never learns the upstream URL,
   * which matters because finderr will be internet-facing while the arrs are not.
   */
  "/img/t/:tconst": (req: Bun.BunRequest<"/img/t/:tconst">) => artwork.serve(req.params.tconst, sizeOf(req)),

  /**
   * A facet image -- a cast headshot, a season poster, an episode still.
   *
   * The key is opaque and content-addressed; `/api/title/:tconst` issued it when it
   * rewrote the facet. A key we never issued is a 404, so this route can never be
   * pointed at a host of the caller's choosing.
   */
  [`${FACET_IMAGE_PATH}/:key`]: (req: Bun.BunRequest<`${typeof FACET_IMAGE_PATH}/:key`>) =>
    facetImages.serve(req.params.key, sizeOf(req)),

  /** Legacy direct-TMDB-path proxy. Kept for anything addressing posters that way. */
  "/img/:size/:file": (req: Bun.BunRequest<"/img/:size/:file">) =>
    images.serve(req.params.size, req.params.file),

  /**
   * Force the library mirror to walk NOW instead of on its timer.
   *
   * ADMIN-ONLY and POST-ONLY. No client calls this -- it is an operator's lever, and it
   * is the one route where the caller's click directly costs Radarr, Sonarr and Plex a
   * full walk each. Before the guard, any signed-in user could fire that repeatedly, and
   * as a bare GET it was reachable by a cross-site navigation riding the Lax cookie.
   */
  "/api/library/sync": {
    POST: async (req: Request) => {
      const refused = auth.requireAdmin(req);
      if (refused) return refused;
      await refreshLibrary();
      return json({
        ok: true,
        library: store.libraryCount(),
        plex: { items: store.plexCount(), machineId: store.plexMachineIdentifier() },
      });
    },
  },
};

// Annotated, not inferred. `addressOf` and `/api/search` both read `server.requestIP`, so
// an inferred type here is a cycle: the server's type would depend on handlers that
// depend on the server.
const server: Bun.Server<undefined> = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  // A fuzzy search is CPU-bound; give it room but never hang a socket forever.
  idleTimeout: 30,
  // Bun's default is 128 MB, and the sign-in ceremonies parse JSON from ANONYMOUS
  // callers. The largest legitimate body this API ever sees is a WebAuthn attestation
  // response, a few KB -- so 256 KB is generous headroom, not a constraint anyone hits.
  maxRequestBodySize: 256 * 1024,

  // Two wrappers, and the ORDER is deliberate: the index gate is OUTSIDE the auth guard, so
  // a caller during a first build gets one 503 about the index rather than a 401 about
  // credentials for a server that has no data yet. See `withIndexGate`.
  routes: withIndexGate(
    withAuth(
      { ...appRoutes, ...auth.routes() },
      {
        authService: auth,
        publicPaths: auth.publicPaths(),
      },
    ),
    {
      ready: () => live.ready,
      state: () => indexBuild?.state ?? null,
      open: INDEX_GATE_PUBLIC_PATHS,
    },
  ) as never,

  /**
   * Static assets, and the two different shells.
   *
   * > [!IMPORTANT] An anonymous visitor is NEVER served the app shell
   * > aannarr, 2026-08-31: a stranger reaching this host should see a generic page that
   * > discloses as little as possible. So `login.html` is a SECOND vite entry with its own
   * > bundle, and `index.html` -- which names every route, every API shape and what this
   * > product is -- is served only to a request carrying a valid session.
   * >
   * > Hashed asset filenames are not a security boundary and nothing here pretends they
   * > are: somebody who has seen the app bundle's name can still fetch it. What this buys
   * > is that an anonymous visitor is never HANDED that name, so the app's structure is
   * > not one view-source away. Every piece of DATA stays behind the API guard regardless.
   */
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/img/")) {
      return new Response("not found", { status: 404 });
    }
    /*
      No index means neither shell can do anything, so BOTH are replaced by one
      self-contained progress page -- see `buildingPage`. It is served for every non-asset
      path rather than only for `/`, because a deep link followed during a first install
      should explain itself rather than 404.

      An asset request still falls through to the file, so a page cached from before a
      restart does not lose its stylesheet. There is no app shell to protect here: this
      state only exists before the first index, and the page names no route.
    */
    if (!live.ready && !/\.[a-z0-9]+$/i.test(u.pathname)) {
      return new Response(buildingPage(), {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "10",
          ...HTML_HEADERS,
        },
      });
    }
    if (!haveStatic)
      return new Response("web build missing -- run 'bun run build'", {
        status: 503,
      });

    const shell = auth.principal(req) ? "/index.html" : "/login.html";
    const rel = u.pathname === "/" ? shell : u.pathname;
    // Reject traversal before touching the filesystem.
    if (rel.includes("..")) return new Response("bad path", { status: 400 });

    const file = Bun.file(`${staticDir}${rel}`);
    return file.exists().then((ok) => {
      if (ok) {
        const hashed = /\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpg|svg)$/.test(rel);
        const html = rel.endsWith(".html");
        return new Response(file, {
          headers: {
            "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
            "X-Content-Type-Options": "nosniff",
            ...(html ? HTML_HEADERS : {}),
          },
        });
      }
      // SPA fallback -- client-side routes are not files. Which shell depends on who is
      // asking, so a deep link followed while signed out lands on the sign-in page rather
      // than on an app that immediately 401s every call it makes.
      return new Response(Bun.file(`${staticDir}${shell}`), {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-cache", ...HTML_HEADERS },
      });
    });
  },

  error(err) {
    console.error("[finderr] unhandled:", err);
    return json({ error: "internal error" }, { status: 500 });
  },
});

log(`listening on http://${cfg.host}:${server.port}`);

// --- adopt the boot-time build ---------------------------------------------
//
// Wired here rather than beside the spawn because it wants `warmShelves`, and because this
// reads in the order it happens: the server is already listening by the time any of it runs.
if (indexBuild) {
  void indexBuild.exited.then((code) => {
    // The build gates on volume and on the 42-case canary before `promote()`, so a non-zero
    // exit means nothing was promoted and there is still no file to open. The state stays
    // `failed` and the progress page says so; retrying a 235 MB download unasked is not
    // this process's call to make.
    if (code !== 0) return;

    const res = live.open();
    if (!res.ok) return;

    // Same follow-up as the daily refresh: the front page is a function of the index, so
    // it cannot have been warmed before one existed. Paced, in the background, never awaited.
    void warmShelves().catch((err) => log(`post-build warm failed -- ${(err as Error).message}`));
  });
}

// --- daily index refresh ---------------------------------------------------
//
// The zone is passed EXPLICITLY. `Bun.cron` defaults to the SYSTEM zone, not UTC -- this
// block used to claim "Bun.cron is UTC-only", which was wrong on both counts: 1.4.0 takes
// an IANA `tz`, and without one it follows whatever `TZ` the container has. That made the
// documented "09:00 UTC" true only by the accident of TZ being unset, and a `TZ` added to
// docker-compose for any other reason would have silently moved the refresh while this
// line went on logging UTC.
try {
  Bun.cron(
    cfg.index.refreshCron,
    async () => {
      log("scheduled index refresh starting");
      const proc = Bun.spawn(["bun", `${import.meta.dir}/../jobs/build-index.ts`], {
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });
      const code = await proc.exited;
      log(`scheduled index refresh exited ${code}`);

      // A non-zero exit means a gate refused the build and `promote()` never ran, so the
      // file on disk is still the one we already have open. Reloading would be a wasted
      // canary against our own index.
      if (code !== 0) return;

      // The swap. If the candidate does not open or does not answer, `reload()` puts the
      // previous file back and opens THAT -- it cannot keep the engine it already has,
      // because `promote()` has already renamed that file away. There is no half-swapped
      // state to recover from, which is the whole reason this is preferable to exiting
      // and being restarted.
      const res = live.reload();
      if (!res.swapped) return;

      // Shelf membership moves with the index -- new titles clear the vote floor, others
      // drop below it -- so the front page after a swap is not the one that was warmed.
      // Paced, in the background, and never awaited on this timer.
      void warmShelves().catch((err) => log(`post-reload warm failed -- ${(err as Error).message}`));
    },
    { tz: cfg.index.refreshTz },
  );
  log(`index refresh scheduled: ${cfg.index.refreshCron} (${cfg.index.refreshTz})`);
} catch (err) {
  log(`could not schedule refresh (${(err as Error).message}) -- run build-index.ts from cron instead`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} -- shutting down`);
    server.stop();
    // A build outlives its parent otherwise: it is a detached `bun` writing to the data
    // directory, and the next boot would start a SECOND one against the same files.
    indexBuild?.stop();
    live.close();
    store.close();
    process.exit(0);
  });
}
