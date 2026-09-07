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
import { AddonConfigStore, redactingLog } from "../lib/addon-config";
import { RadarrClient, SonarrClient } from "../lib/arr";
import { arrLink } from "../lib/arr-links";
import { attributedRequest, isoIn, type Principal, publicOrigin, visibleRequest } from "../lib/auth";
import { AuthStore } from "../lib/auth-store";
import { AwardMarkIndex } from "../lib/award-marks";
import { AWARDS, type AwardDef, awardById, OSCARS } from "../lib/award-registry";
import { personAwards, titleAwards } from "../lib/awards";
import { collectionPage, collectionsMatchingName } from "../lib/collections";
import { loadConfig, paths } from "../lib/config";
import { CostMeter } from "../lib/cost-meter";
import {
  type EpisodeState,
  episodeStateOf,
  missingEpisodeIdsIn,
  type SeasonProgress,
  seasonProgress,
  seasonsWithMissing,
  todayUtc,
} from "../lib/episodes";
import { FacetResolver, isLiveContribution, type ResolvedFacets } from "../lib/facet-resolver";
import { type EntityKind, entityKindFor, type FacetEntity, type PersonCredit } from "../lib/facets";
import { rollback } from "../lib/index-builder";
import { boundedHeader, boundedQuery, boundedText, LIMITS, refusalMessage } from "../lib/input-guards";
import { LIST_SIZE } from "../lib/lists";
import { loadLogoIndex } from "../lib/logos";
import type { RequestRemovalView } from "../lib/media-removal";
import { renderPanes } from "../lib/panes";
import type { PersonHit } from "../lib/people";
import { PlexClient, type PlexLinks, plexLinks, syncPlex } from "../lib/plex";
import { createPluginFetch, DEFAULT_OUTBOUND_POLICY, HostPacer, outboundTimings } from "../lib/plugin-fetch";
import { loadPlugins } from "../lib/plugins";
import { ProwlarrClient } from "../lib/prowlarr";
import { RateLimiter } from "../lib/rate-limit";
import { requestStateOf } from "../lib/request-diagnostics";
import { hasOverrides, parseRequestOverrides } from "../lib/request-overrides";
import { quotaLimitFor, quotaStateFor, quotaVerdict, utcDayReset, utcDayStart } from "../lib/request-quota";
import { PeakMemory, ResourceMonitor, snapshot as runtimeSnapshot } from "../lib/runtime-stats";
import { type BrowseSort, isBrowseSort, languageFilter, type TitleRow } from "../lib/search";
import {
  NO_SEARCH_LOG,
  parseClickBody,
  FLUSH_MS as SEARCH_LOG_FLUSH_MS,
  type SearchFilters,
  SearchLog,
  type SearchLogger,
} from "../lib/search-log";
import { decodeSeasons, parseSeasonsInput } from "../lib/seasons";
import {
  applyShelfPreference,
  parseShelfChoices,
  type ShelfChoice,
  type ShelfPreferencePayload,
  ShelfPreferenceStore,
  shelfCatalogue,
} from "../lib/shelf-preferences";
import { SiteSettingsStore, siteSettingsSeed } from "../lib/site-settings";
import { SlowLog } from "../lib/slow-log";
import { prepareSqlite } from "../lib/spellfix";
import { createsNewRequest, type MediaRemoval, Store, syncLibrary } from "../lib/store";
import {
  isTermDimension,
  TERM_DIMENSIONS,
  type Term,
  type TermDimension,
  type TermPair,
  termPage,
  termsForTitle,
} from "../lib/terms";
import { Timings } from "../lib/timings";
import { TMDB_HOST, TmdbApi } from "../lib/tmdb-api";
import { TmdbSettingsStore } from "../lib/tmdb-settings";
import { syncArrCalendars, syncTmdbTrending, syncTmdbUpcoming } from "../lib/upcoming";
import { WatchlistStore } from "../lib/watchlist";
import { addonConfigRoutes } from "./addon-config-routes";
import { AGENT_MANIFEST_PATH, agentManifestRoute, agentWaitMs, withAgentApi } from "./agent-api";
import { makeChatHandler, makeChatProbe } from "./agent-chat";
import { ARR_WEBHOOK_PATH, ArrWebhookService } from "./arr-webhook";
import { ArtworkService, DEFAULT_IMAGE_SIZE } from "./artwork";
import { AuthService, withAuth } from "./auth-routes";
import { type AwardsDeps, ceremonyPayload, peoplePayload, timelinePayload } from "./awards";
import {
  cacheHeaders,
  IMMUTABLE_PUBLIC,
  NO_STORE,
  PER_SESSION_REVALIDATED,
  perSession,
  REVALIDATED,
} from "./cache-policy";
import { episodeScoresFor } from "./episode-scores";
import { FACET_IMAGE_PATH, FacetImageProxy, facetImagePath, personFaces } from "./facet-images";
import { FrontPage } from "./front-page";
import { healthPayload, warmHealth } from "./health";
import { ImageCache } from "./images";
import { buildingPage, INDEX_GATE_PUBLIC_PATHS, IndexBuild, withIndexGate } from "./index-build";
import { IndexRefresher, staleIndexReason } from "./index-refresh";
import { json } from "./json-response";
import { completionPayload, type ListsDeps } from "./lists";
import { LiveIndex } from "./live-index";
import { withPayloadGuard } from "./payload-guard";
import { type PersonPreviewDeps, type PreviewDeps, personPreviewResponse, previewResponse } from "./preview";
import {
  PREVIEW_IMAGE_PATH,
  PREVIEW_IMAGE_SIZE,
  PREVIEW_PATH,
  PREVIEW_PERSON_PATH,
  PreviewResolver,
} from "./preview-resolver";
import { PushNotifier } from "./push";
import { relatedTconsts } from "./related-crosswalk";
import { type RemoveMediaDeps, removalPreview, removeMedia } from "./remove-media";
import { withTiming } from "./request-timing";
import { RequestWorker } from "./request-worker";
import {
  type DiscoveryShelf,
  discoveryShelves,
  facetCoverage,
  frontPageTitles,
  type ShelfTier,
} from "./shelves";
import { withdrawRequest } from "./withdraw-request";

const cfg = loadConfig();
const p = paths(cfg);
mkdirSync(p.root, { recursive: true });

const log = (...args: unknown[]) => console.log(`[finderr]`, ...args);

/**
 * A bare ISO 639-1 code, which is the whole validation `?lang=` admits of.
 *
 * The set of REAL codes is not checked here and deliberately: which languages the index
 * holds is a property of the file, and a code nothing matches is an empty page rather than
 * an error. This only keeps anything that is not shaped like a language code out of SQL.
 */
const LANG_CODE = /^[a-z]{2}$/;

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
/*
  Prowlarr, read-only and optional. It answers exactly one question -- did the searches the
  arrs already ran come back with anything -- and finderr never asks it to search. Unset is
  the ordinary case for a fresh checkout and costs a request diagnostic its sharpest
  verdict, nothing else. See `src/lib/prowlarr.ts`.
*/
const prowlarr = cfg.prowlarr ? new ProwlarrClient(cfg.prowlarr) : undefined;

/*
  Addon configuration, and the one TMDB key this instance uses.

  BEFORE the poster proxy and long before the plugin loader, because three things read it:
  the `tmdb` addon through `c.config`, `refreshTmdbLists` below, and `ImageCache`. One store,
  one `kv` row per setting, one precedence rule -- see `src/lib/tmdb-settings.ts` for why the
  key stopped being a `cfg` field.
*/
const addonConfig = new AddonConfigStore(store);
const tmdbSettings = new TmdbSettingsStore(addonConfig);

const images = new ImageCache(cfg, tmdbSettings);
const artwork = new ArtworkService(cfg, store, { radarr, sonarr }, log);
// Cast headshots, season posters and episode stills, served from our own origin. Reuses
// the artwork service for the bytes -- a face is not a different kind of JPEG.
const facetImages = new FacetImageProxy({ store, bytes: artwork });

/*
  The site defaults an operator sets on `/admin`, over the `kv` table this store already owns.

  BEFORE `authStore`, because identity reads one of them: `assistantAllowedByDefault` decides
  what a new account's assistant switch starts at, and it is handed over as a THUNK so a change
  saved on the admin page binds the next sign-up rather than the next restart.
*/
const siteSettings = new SiteSettingsStore(store, siteSettingsSeed(cfg));

// Identity. Shares the app database connection -- one file, one writer, one migration.
const authStore = new AuthStore(store.db, () => siteSettings.read().assistantAllowedByDefault);

/*
  The private list, on the same connection and for the same reason.

  It holds NOTHING an arr is ever told about: saving a title writes one row and the download
  path is not reachable from any route below that touches it. See `src/lib/watchlist.ts`.
*/
const watchlistStore = new WatchlistStore(store.db);

/*
  Each reader's own order for the front page, on the same connection and for the same reason.

  It stores an ORDER AND A FILTER and nothing else -- it cannot add a shelf or change what is
  on one -- which is what keeps `/api/discover` a held page plus one indexed read. See
  `src/lib/shelf-preferences.ts`.
*/
const shelfPrefs = new ShelfPreferenceStore(store.db);

/*
  Web push, and it is constructed BEFORE the request worker on purpose.

  The worker owns the one moment a request becomes available and reports it through an
  `onAvailable` callback, so it never learns that notifications exist -- which is what keeps
  it testable without a VAPID pair or a network. Wiring that callback here is the only place
  the two meet.

  `announceArrival` never throws and never awaits anything the reconcile pass depends on, so
  the call is deliberately not awaited: a push service having a bad minute must not slow the
  timer that is updating everybody else's requests.
*/
const pushNotifier = new PushNotifier({
  store,
  authStore,
  enabled: cfg.push.enabled,
  contact: cfg.push.contact,
  log: (m) => log(m),
});

const worker = new RequestWorker({
  store,
  radarr,
  sonarr,
  prowlarr,
  log,
  onAvailable: (request) => {
    void pushNotifier
      .announceArrival(request)
      .catch((err) => log(`push: announcing "${request.title}" failed -- ${(err as Error).message}`));
  },
});
const auth = new AuthService({
  auth: authStore,
  store,
  cfg,
  settings: siteSettings,
  log: (m) => log(m),
  // Read at call time, so the closure can name `server` before Bun.serve has returned it.
  addressOf: (req: Request) => server.requestIP(req)?.address ?? null,
});

/*
  The assistant handler, built once.

  `indexDb` and `live.current` are both read AT CALL TIME rather than captured here: the
  daily refresh swaps the engine underneath us, and a handle taken at construction would be
  the retired-connection bug LiveIndex exists to prevent -- it either throws or, under load,
  quietly serves yesterday's row with no error at all.
*/
const chatProbe = makeChatProbe({ cfg });
const chat = makeChatHandler({
  cfg,
  settings: siteSettings,
  store,
  live,
  indexDb: () => live.rawDb(),
  worker,
  has: { radarr: Boolean(radarr), sonarr: Boolean(sonarr) },
  log: (m) => log(m),
});

/*
  The Radarr and Sonarr callback.

  It shares `auth.trustProxy` rather than carrying a switch of its own, because there is one
  fact here -- whether something is in front of us rewriting the source address -- and two
  copies of it would let the rate limiter and the LAN check disagree about who is calling.
*/
const arrWebhooks = new ArrWebhookService({
  store,
  webhook: cfg.webhook,
  trustProxy: cfg.auth.trustProxy,
  addressOf: (req: Request) => server.requestIP(req)?.address ?? null,
  log: (m) => log(m),
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
  log("  #  AUTHENTICATION IS OFF -- FINDERR_NO_AUTH IS SET  #");
  log("  ##########################################################");
  log(
    `  every request is signed in as ${JSON.stringify(devUser.displayName)} (${devUser.role}) -- no login wall`,
  );
  log(`  anyone who can reach ${cfg.host}:${cfg.port} is an admin here`);
  log("  this process holds the Radarr, Sonarr and Plex credentials. Do not expose it.");
  log("");
}

/*
  The first-run claim, asked HERE rather than left to the first visitor.

  Asking is what arms the latch (see `FirstRun.open`), so a server that already has accounts
  shuts the door at boot instead of at whatever moment somebody first loads the sign-in page.
  It runs AFTER `ensureDevUser` for the same reason the bootstrap block does: that account
  exists by then, so `FINDERR_NO_AUTH` never has a claimable window at all.
*/
const claimable = auth.firstRun.open();

/*
  Bootstrap.

  An empty user table is a locked front door with nobody holding a key, so the FIRST boot
  mints an admin invite and prints it. It is printed rather than persisted anywhere a
  reader could find it later: the token exists in this log line and in the invitee's
  browser, and if the line scrolls away the fix is to mint another with the system key.

  It fires only when there are no users at all -- not on every boot, and not when the last
  admin has merely been disabled, because "the board is empty" and "the admins are locked
  out" want different answers and only the second one is a judgement call.

  It is NOT the same door as the claim above and does not replace it: an invite still works
  on a server whose claim window has closed, which is the whole recovery path for a deleted
  last admin.
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
  if (claimable) {
    log("  or just open the app: with no accounts yet, the first visitor becomes the admin.");
    log("  That door shuts for good the moment an account exists -- take it now or use the link.");
  }
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
// the plugins directory, and installed packages named in `pluginModules`. `addonConfig` is
// built up with the state clients, because the poster proxy reads it too.
/*
  The one log sink an addon's own words reach, and therefore the one that redacts.

  Two paths carry text an addon wrote: its `c.log` calls, and the `err.message` FacetResolver
  prints when a provider throws. Both are wrapped here, so a plugin that puts its own API key
  into an error message -- which nothing can stop it doing -- cannot put it in the container
  log. The rest of the server's log stays unwrapped deliberately: it never carries plugin
  text, and one narrow wrapper is easier to keep honest than a global one.
*/
const pluginLog = redactingLog(log, () => addonConfig.secrets());
const plugins = await loadPlugins({
  dir: cfg.pluginsDir || undefined,
  modules: cfg.pluginModules,
  kv: store,
  config: addonConfig,
  log: pluginLog,
});
const facets = new FacetResolver({ store, registry: plugins, log: pluginLog });
log(`plugins: ${plugins.list().length} loaded`);

/*
  What a SHARED LINK is allowed to cost, in two parts.

  `previewLimiter` is fairness -- per caller, on the preview page, which reads local SQLite
  and is close to free. `previewResolver` is survival -- process-wide, on the one expensive
  thing an anonymous caller can provoke, which is resolving a poster we have never seen.
  See `./preview-resolver.ts` for why those are two mechanisms rather than one number.
*/
const previewLimiter = new RateLimiter(cfg.preview.ratePerMinute);
const previewResolver = new PreviewResolver(cfg.preview.resolvePerMinute);

/*
  WHAT EACH CALLER ACTUALLY COST, over the last sixty seconds.

  The third mechanism on the search path and the only one that counts TIME. `searchLimiter`
  counts requests and `previewResolver` counts one expensive upstream operation; neither can
  see that two searches differ in cost by three orders of magnitude, so neither notices the
  caller who stays inside every count and owns the event loop anyway.

  Keyed on `auth.limitKey`, which is the ACCOUNT when we can name one and the address
  otherwise -- so an agent key is its own caller and its spend is never pooled with the
  household's. That matters because an agent is the realistic heavy caller: it is fast by
  nature rather than hostile, and pooling it with a person hides both.

  Every number is `src/lib/cost-meter.ts`'s to defend; nothing here restates one.
*/
const searchCost = new CostMeter({
  budgetMs: cfg.auth.searchBudgetMs,
  contendedMs: cfg.auth.searchContendedMs,
  soloBudgetMs: cfg.auth.searchSoloBudgetMs,
  refuseAtMs: cfg.auth.searchRefuseAtMs,
  maxDelayMs: cfg.auth.searchMaxDelayMs,
});

/*
  How long every request took, and which of them were slow enough to keep the arguments of.

  Two objects because they answer two questions -- see `src/lib/slow-log.ts`. Both are
  in-memory and bounded, so they cost nothing to keep and nothing to read; `/api/health`
  serves both to an admin under `timings`. `withTiming` wraps the whole route table below.
*/
const requestTimings = new Timings();
const slowRequests = new SlowLog();

/*
  What people actually searched for, buffered in memory and drained on a timer.

  The render path only ever pushes to an array -- `bun:sqlite` is synchronous, so an insert
  inside `/api/search` would hold the event loop for every other request on the page, which
  is the measurement that bought the search debounce. The flush also PRUNES, so the two
  tables have a ceiling rather than a growth rate.

  `NO_SEARCH_LOG` when the operator turned it off, so "is logging on" is decided once here
  instead of at each of the three call sites. See `../lib/search-log.ts` for what a row may
  hold, which is deliberately far less than what the server knows about the caller.
*/
const searchLog: SearchLogger = cfg.searchLog.enabled ? new SearchLog(store) : NO_SEARCH_LOG;
if (cfg.searchLog.enabled) {
  setInterval(() => {
    searchLog.flush();
    store.pruneSearchLog(cfg.searchLog.keepRows);
  }, SEARCH_LOG_FLUSH_MS);
} else {
  log("search log: off (FINDERR_SEARCH_LOG) -- nothing is buffered and nothing is written");
}

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
  // No index yet means we cannot draw a card for ANY title, which is the honest answer
  // rather than a throw. Both callers are boot-path timers -- the arr calendars fire
  // immediately and the TMDB sync eight seconds in -- so on a first install this is asked
  // while the index is still being built. `current` throws then, out of a timer with
  // nobody to catch it. See `LiveIndex.poolStats` for the same fault at two other sites.
  if (!live.ready) return false;
  return live.current.byTconst(tconst) !== null;
}

/*
  The high-water mark the mirror walks are measured against, reported as `runtime.peak`.

  These two walks are the largest transient allocation this process makes on a schedule, and
  they are the ones a thirty-second health probe structurally cannot see -- read `PeakMemory`
  for the sixteen days of green health checks that motivated it. Wrapped SEPARATELY rather
  than around `refreshLibrary` as a whole, so the field names which walk set the record; the
  two are bounded by different mechanisms and can regress independently.
*/
const mirrorPeak = new PeakMemory();

// Mirror the arr libraries on a timer so "do we have it?" is a local lookup.
async function refreshLibrary(): Promise<void> {
  // The episode half is SLICED rather than swept: it costs one Sonarr call per series, so
  // walking the whole library on this 60s timer would be hundreds of requests a minute.
  // `syncEpisodes` in `../lib/store` has the arithmetic.
  const res = await mirrorPeak.during("arr-library", () =>
    syncLibrary(
      store,
      { radarr, sonarr },
      { batch: cfg.episodeRefreshBatch, staleSeconds: cfg.episodeRefreshSeconds },
      log,
    ),
  );
  for (const e of res.errors) log(`library sync error -- ${e}`);
  // Same cadence, one function: "can I request it" and "can I play it" go stale together.
  // A failed walk leaves the previous mirror in place rather than emptying it -- a
  // ratingKey is stable, so stale beats absent for the one thing this feeds.
  const mirrored = await mirrorPeak.during("plex-mirror", () => syncPlex(store, plex, log));
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

  // The arr tier's shelves -- recently-added, the two arr calendars, and recently-requested
  // whose statuses the reconcile pass moves -- are built from exactly what the lines above
  // just wrote, so this is where they stop being stale.
  primeShelves("arr");
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
// `live.poolStats()`, never `live.current.poolStats()`: this runs on a timer that starts
// before the boot-time build has produced an index, and `current` throws until it has.
// That threw on the first tick and killed the process -- see the caution on `poolStats`.
const resources = new ResourceMonitor(log, () => live.poolStats() ?? "");
resources.start(cfg.resourceLogSeconds * 1000);

/** The front page, as `./shelves` defines it, against this process's index and mirror. */
const shelvesOf = () => discoveryShelves({ engine: live.current, store });

/**
 * The held front page. Inert unless `FINDERR_KEEP_SHELVES_FRESH` is set.
 *
 * The deps are a THUNK because `live.current` throws until an index exists and must never
 * be captured -- a holder that closed over one engine would go on reading a retired handle
 * after the next swap, which either errors or, worse, quietly serves yesterday.
 */
const frontPage = new FrontPage(() => ({ engine: live.current, store }));

/**
 * Rebuild one tier of the held page, from the timer that just wrote its source.
 *
 * Never throws, and never lets a prime failure reach the caller: every call site is a timer,
 * and a boot-path timer taking the process down is exactly the crash loop of 2026-09-01. A
 * tier that cannot be built is simply not built, and the page keeps being computed.
 */
function primeShelves(tier: ShelfTier): void {
  if (!cfg.shelves.keepFresh || !live.ready) return;
  try {
    frontPage.refresh(tier);
  } catch (err) {
    log(`shelf prime (${tier}) failed -- ${(err as Error).message}`);
  }
}

/**
 * THE front page, for every consumer: the render path, the warm loop and the health probe.
 *
 * One function so the held copy and the computed one can never be two different pages. It
 * falls back to computing whenever the holder is off, still filling, or missing a tier --
 * so turning the flag off is a restart and nothing else, with no state to unwind.
 */
function currentShelves(): DiscoveryShelf[] {
  if (cfg.shelves.keepFresh) {
    const held = frontPage.current(new Set(store.libraryMap().keys()));
    if (held) return held;
  }
  return shelvesOf();
}

/**
 * The arrangement this request's reader has saved, or none for anybody without an account.
 *
 * An anonymous caller costs ZERO reads here, which is the ordinary case for the sign-in page
 * and for the container's own probes.
 */
function preferenceOf(req: Request): ShelfChoice[] {
  const me = readerId(req);
  return me ? shelfPrefs.read(me) : [];
}

/**
 * The shelves the operator ships switched off, built ONCE.
 *
 * A `Set` per request over a config array nothing can change at runtime would be work bought
 * on the render path for nothing. It is the SINGLE owner of turning that config field into the
 * shape the two resolvers take, so the settings screen and the front page cannot be handed
 * different defaults -- which would draw a shelf the arranging list swore was hidden.
 */
const shelvesHiddenByDefault: ReadonlySet<string> = new Set(cfg.shelves.hiddenByDefault);

/**
 * What the preference routes all answer with: the whole catalogue, in this reader's order.
 *
 * ONE PAYLOAD FOR ALL THREE VERBS -- read it, save it, reset it -- so a client never has to
 * guess how the server resolved what it sent. It is built from `currentShelves()` rather than
 * from the stored rows, which is what makes a retired shelf disappear from the screen and a
 * newly shipped one appear on it without either being a special case.
 *
 * `customised` still means "has this reader stored anything", NOT "does their page differ from
 * the shipped one". An operator default is not the reader's arrangement, so a reader who has
 * touched nothing is offered no reset -- there is nothing of theirs to put back, and a button
 * that undid the operator's default would be a per-reader override wearing a reset's clothes.
 */
function preferencePayload(userId: string | null): ShelfPreferencePayload {
  const pref = userId ? shelfPrefs.read(userId) : [];
  return {
    customised: pref.length > 0,
    shelves: shelfCatalogue(currentShelves(), pref, shelvesHiddenByDefault),
  };
}

/**
 * Warm everything reachable in ONE CLICK from a cold front page, so nothing on screen
 * is ever fetched while somebody waits.
 *
 * IT WARMS THE SHIPPED PAGE, AND THAT COVERS EVERY READER'S. A preference can only reorder
 * and hide, never add -- `orderShelves` picks from the list it is handed -- so the union of
 * what readers actually see is a SUBSET of `currentShelves()`, and warming the superset warms
 * all of it. `shelf-preferences.test.ts` pins that property, because the day a preference can
 * SELECT a shelf rather than order one, somebody gets a cold shelf and nothing here says so.
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
  // There is no front page to warm until there is an index to derive one from. The six-hourly
  // timer that calls this starts at boot, so on a first install it fires while the build is
  // still running -- and `shelvesOf()` reads `live.current`, which throws until then.
  // Nothing is lost by returning: the boot-build handler warms explicitly once the index is
  // adopted, and so does every later swap.
  if (!live.ready) return;

  const titles = frontPageTitles(currentShelves());

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

  // Faces LAST, because it reads what the warm above just cached. Local SQLite only, so
  // it costs nobody a call -- see `backfillPersonImages`.
  backfillPersonImages();
}

/**
 * File a face for every person in the cast and crew answers we already hold.
 *
 * WHY A BACKFILL EXISTS AT ALL. `person_image` is written by the title route, which only
 * runs when somebody opens a page. Without this, an install would ship the fix and still
 * draw initials for everybody until each person's titles had been visited one at a time --
 * and every face already in the facet cache, bought and paid for, would stay unreachable.
 *
 * ENTIRELY LOCAL. It re-reads cached contributions, re-runs the same rewrite the route
 * runs, and asks the index who each credit is. No provider is contacted, so it cannot
 * become the sweep the one-click-deep rule forbids however many titles accumulate.
 *
 * IDEMPOTENT AND CHEAP TO REPEAT, which is why it rides `warmShelves` rather than owning a
 * timer: the upsert only writes when a key actually moved, so the six-hourly re-run is a
 * read of rows that mostly agree with themselves. It also picks up faces the warm loop
 * fetched moments earlier, which is the run that matters on a first install.
 */
function backfillPersonImages(): void {
  // `live.current` throws until an index exists, and `personLinks` needs one. Same guard,
  // and same reason, as the `live.ready` check at the top of `warmShelves`.
  if (!live.ready) return;

  const t0 = Bun.nanoseconds();
  let filed = 0;
  let titles = 0;
  for (const tconst of store.tconstsWithCredits()) {
    const row = live.current.byTconst(tconst);
    // A title the current index does not carry. The contribution is still valid -- the
    // index is rebuilt nightly and this one may return -- so the row is left alone.
    if (!row) continue;
    const credits = creditsIn(facetImages.rewrite(facets.read(entityFor(row))));
    if (credits.length === 0) continue;
    const faces = personFaces(credits, live.current.personLinks(tconst, credits));
    store.rememberPersonImages(faces);
    titles++;
    filed += faces.length;
  }
  log(
    `faces: ${filed} filed from ${titles} cached titles in ` +
      `${((Bun.nanoseconds() - t0) / 1e6).toFixed(0)}ms -- ${store.personImageCount()} people have one`,
  );
}

/*
  TMDB's upcoming lists AND its trending list, on a SLOW timer and deliberately not the
  library one.

  Six-hourly rather than every libraryRefreshSeconds because the answers barely move -- a
  film's release date changes a handful of times in its life, and a WEEKLY trending list
  turns over about as often as its name says -- and because unlike the arr calendars these
  cost a third party. They run BEFORE `warmShelves` in the same tick so the titles they add
  are warmed on this pass rather than waiting six hours for the next, which is what
  "a shelf is not published until its titles are warm" needs in order to hold.

  No key means no shelves, quietly, the same way the `tmdb` plugin goes dark: three rows
  fewer and nothing else changes. LITERALLY the same key -- both read the one setting
  `src/lib/tmdb-settings.ts` owns, read fresh here so a key saved on the admin page reaches
  the next six-hourly run rather than the next restart.

  THE TWO SYNCS FAIL INDEPENDENTLY, in their own try blocks, for the reason
  `replaceUpcoming` is scoped per source: trending being unreachable must not also stop
  the upcoming rows that were one await away from landing.
*/
async function refreshTmdbLists(): Promise<void> {
  const { apiKey } = tmdbSettings.read();
  if (!apiKey) return;
  const api = new TmdbApi(
    createPluginFetch({
      pluginId: "upcoming-sync",
      hosts: [TMDB_HOST],
      pacer: new HostPacer(DEFAULT_OUTBOUND_POLICY.minIntervalMsPerHost),
    }),
    apiKey,
  );
  const deps = { store, hasRow: indexHasRow, log };
  try {
    const res = await syncTmdbUpcoming(deps, api, cfg.regions);
    for (const r of res) log(`upcoming: ${r.rows} from ${r.source}`);
  } catch (err) {
    // safeUrl already stripped the key from anything getJson reports; nothing here adds a URL.
    log(`upcoming sync error -- ${(err as Error).message}`);
  }
  try {
    const res = await syncTmdbTrending(deps, api);
    log(`trending: ${res.rows} from ${res.source}`);
  } catch (err) {
    log(`trending sync error -- ${(err as Error).message}`);
  }

  // Both mirrors this tier's three shelves read from have just been written. Outside the
  // try blocks on purpose: a failed sync leaves the previous rows standing, and re-priming
  // from them is right -- stale beats absent, the same rule `syncPlex` follows.
  primeShelves("tmdb");
}

// Give the library mirror a moment to land first: "recently added" is read straight
// out of it, and owned titles are excluded from every other shelf -- so warming
// before it lands both misses a shelf and pays for posters we then filter out.
setTimeout(() => void refreshTmdbLists().then(warmShelves), 8_000);
setInterval(() => void refreshTmdbLists().then(warmShelves), 6 * 60 * 60 * 1000);

/**
 * Import the award rows, in-process and never on a request path.
 *
 * ONCE at boot for any award with nothing stored, then daily for all of them. It is not on
 * the six-hourly loop above because the data genuinely changes once a year: the Academy
 * announces in March and `oscar_data` catches up within weeks, and Cannes is a week in May.
 * A daily check costs one 2.2 MB read of somebody's public repo and one small SPARQL query
 * per Wikidata award, run one after another rather than at once, which is polite; six-hourly
 * would be four times that for no new fact.
 *
 * Failures are logged per award and swallowed. A finderr with no nominations is a finderr
 * whose awards page is empty, which is the same shape as a keyless `tmdb` plugin going dark
 * -- it must never be the reason the server does not come up, and one source being down must
 * never cost another its refresh.
 */
async function refreshAwards(defs: readonly AwardDef[] = AWARDS): Promise<void> {
  for (const r of await importAwards(store, {}, defs)) {
    if (r.meta) log(`awards: ${r.def.id} -- ${r.meta.rows.toLocaleString()} rows`);
    else log(`awards: ${r.def.id} import failed -- ${r.error?.message}`);
  }
  // The rows the marks were built from have just been swapped. Unconditional, even when
  // every award failed: a failed import leaves the previous rows standing, so re-reading
  // them is free and cheaper than deciding whether it was worth it.
  log(`awards: ${awardMarks.refresh().toLocaleString()} titles carry a mark`);
}

/**
 * The anchor winners, in memory, so a title card costs no query to mark. See `AwardMarkIndex`.
 *
 * Built HERE rather than lazily on first use, beside the import that is the only thing that
 * can invalidate it -- `refreshAwards` above owns the refresh and is the sole caller. A
 * `bun run awards:import` in its own process writes rows this one will not see until the
 * daily refresh, which is the honest cost of holding the set in memory and is a day at worst.
 */
const awardMarks = new AwardMarkIndex(store);

// Only the awards with a COLD table. A redeploy keeps its data directory, so re-importing
// everything on every boot would re-download 2.2 MB to write rows that are already there --
// and a container that restarts in a loop would do it every time.
const coldAwards = AWARDS.filter((def) => store.awardCount(def.id) === 0);
if (coldAwards.length > 0) {
  log(`awards: nothing stored for ${coldAwards.map((a) => a.id).join(", ")} -- importing`);
  setTimeout(() => void refreshAwards(coldAwards), 12_000);
}
setInterval(() => void refreshAwards(), 24 * 60 * 60 * 1000);

// --- helpers ---------------------------------------------------------------

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

/**
 * Whose request this is, or null for a caller with no account behind them.
 *
 * A PRINCIPAL IS NOT ALWAYS A PERSON: the admin API key is one, and it has no `user`. Every
 * per-reader route wants the person and not the principal, so the two optional hops are
 * spelled once here rather than at each of them -- seven copies of the same chain is seven
 * chances to drop a `?.` and hand one reader another's list.
 */
function readerId(req: Request): string | null {
  return auth.principal(req)?.user?.id ?? null;
}

/** The width an image route was asked for. One reader, so both routes accept the same thing. */
function sizeOf(req: Request): string {
  return new URL(req.url).searchParams.get("size") ?? DEFAULT_IMAGE_SIZE;
}

/**
 * The 429 for somebody who has spent their day's allowance, or null to let them through.
 *
 * The RULE is in `../lib/request-quota.ts` and the COUNT is in the request log; this
 * function is only the join between them and the HTTP shape. It is deliberately not folded
 * into the route body: "may this person ask for another title" is one question with one
 * answer, and a route that spelled the limit, the day boundary and the admin exemption
 * inline would be a second place each of them lives.
 *
 * A caller with no user id -- the system API key -- is not a person and has no daily
 * allowance, so it is never counted and never refused. It is `admin` anyway; both readings
 * agree, and the guard is here because `requested_by` is null for it and a quota keyed on
 * null would pool every keyless request into one bucket.
 */
function quotaRefusal(asker: Principal | null): Response | null {
  const user = asker?.user;
  if (!user) return null;
  const userId = user.id;

  const verdict = quotaVerdict({
    role: asker.role,
    limit: quotaLimitFor(user.quotaPerDay, siteSettings.read().requestQuotaPerDay),
    usedToday: () => store.countRequestsSince(userId, utcDayStart()),
  });
  if (verdict.allowed) return null;

  log(`quota: ${userId} refused, ${verdict.used}/${verdict.limit} titles today`);
  return json(
    { error: verdict.message },
    { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
  );
}

/**
 * The self-describing manifest, wired to the things that own its facts.
 *
 * Nothing but wiring: `agentManifestRoute` gathers through these callbacks and renders, so
 * the document cannot drift from the server -- there is no second copy of anything in it to
 * drift from. The callbacks are what let the route be tested without a database, a limiter
 * or a running server.
 */
const agentManifest = agentManifestRoute({
  principal: (req) => auth.principal(req),
  keyFor: (keyId) => authStore.agentKeyById(keyId),
  limiter: (bucket) => auth.agentLimiter(bucket),
  origin: (req) => publicOrigin(req.url, cfg.auth.origins),
  // Their own allowance where they have one -- a manifest that quoted the site's would
  // promise an agent a budget its owner does not have.
  quota: (userId) => ({
    limitPerDay: quotaLimitFor(
      authStore.getUser(userId)?.quotaPerDay ?? null,
      siteSettings.read().requestQuotaPerDay,
    ),
    usedToday: store.countRequestsSince(userId, utcDayStart()),
    resetsAt: utcDayReset(),
  }),
  routes: () => liveRouteTable(),
});

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
 * The Open Graph preview for a shared `/title/:tconst` link, or `null` to fall through to
 * the ordinary sign-in shell.
 *
 * > [!CAUTION] This runs for ANONYMOUS callers. Every line is a disclosure decision
 * > It is the only HTML in the product that describes anything to somebody with no
 * > session. What it may say is stated in `src/lib/og-preview.ts` and pinned by a test:
 * > facts about the FILM, never facts about this deployment holding it. Do not reach for
 * > `store.libraryMap()`, `episodeStateFor` or `arrLink` here, however convenient.
 *
 * **Three reads and no network, in the common case.** The index row, the cached synopsis,
 * the cached poster URL -- all local SQLite. `facets.warm()` is NEVER called: it starts
 * every provider that owes this title an answer, which would turn one shared link into
 * thirteen upstream calls bought by a stranger. The title page does call it, correctly,
 * because a signed-in reader is looking at the result.
 *
 * **Resolving an unseen poster is the one exception and it is bounded.** It goes through
 * `previewResolver`, which refuses instantly rather than queueing; a refusal renders the
 * card without an image. Reaching `artwork.serve()` from here instead would hand an
 * anonymous caller a Radarr AND Sonarr lookup per tconst, 1.27M of them.
 */
const previewDeps: PreviewDeps = {
  rowFor: (tconst) => live.current.byTconst(tconst),
  cachedSynopsis: (tconst) => {
    const row = live.current.byTconst(tconst);
    if (!row) return null;
    // `read`, never `warm`. See `PreviewDeps.cachedSynopsis`.
    const cached = facets.read(entityFor(row));
    return cached.synopsis?.status === "ready" ? (cached.synopsis.data?.text ?? null) : null;
  },
  cachedPoster: (tconst) => store.getArtwork(tconst),
  resolvePoster: (tconst, kind) => previewResolver.tryResolve(() => artwork.resolveUrl(tconst, kind)),
  allow: (req) => previewLimiter.take(auth.limitKey(req)),
  origin: (req) => publicOrigin(req.url, cfg.auth.origins),
  siteName: cfg.auth.rpName,
  headers: HTML_HEADERS,
};

/**
 * The same contract for a PERSON card, and it is even narrower than the title one.
 *
 * Two local reads and no network AT ALL -- there is no `resolvePoster` counterpart, because
 * a headshot only ever enters `person_image` as a side effect of a signed-in reader opening
 * a title page. Nothing to buy means nothing to bound, so `previewResolver` is not wired
 * here and must not be: a bound that guards no call is a bound somebody later feeds one to.
 *
 * `KNOWN_FOR` is capped at three because the description reads as a sentence -- `Known for
 * A, B and C.` -- and a fourth title pushes the useful half past where clients truncate.
 * `personPage` orders by votes by default, which is what makes the head of the list the
 * titles a reader would actually recognise.
 */
const KNOWN_FOR = 3;

const personPreviewDeps: PersonPreviewDeps = {
  pageFor: (nconst) => {
    const page = live.current.personPage(nconst, { limit: KNOWN_FOR, sort: "votes" });
    if (!page) return null;
    return {
      person: page.person,
      knownFor: page.credits.map((c) => c.title),
      credits: page.total,
    };
  },
  faceKey: (nconst) => faceKeyOf(nconst),
  // ONE bucket with the title card, deliberately: they are one anonymous surface, and a
  // second limiter would let a crawler spend the whole allowance twice.
  allow: (req) => previewLimiter.take(auth.limitKey(req)),
  origin: (req) => publicOrigin(req.url, cfg.auth.origins),
  siteName: cfg.auth.rpName,
  headers: HTML_HEADERS,
};

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
  const diagnostics = store.requestDiagnosticMap();
  const playLink = plexLinker();
  return rows.map((r) => {
    const l = lib.get(r.tconst);
    const q = reqs.get(r.tconst);
    const d = diagnostics.get(r.tconst) ?? null;
    const art = store.getArtwork(r.tconst);
    return {
      ...r,
      inLibrary: !!l,
      hasFile: l ? l.has_file === 1 : false,
      progress: l?.progress ?? null,
      requestStatus: q?.status ?? null,
      /*
        Why this request is taking as long as it is -- see `RequestStateView`.

        The VERDICT goes over as a code and its sentence does not: the words live in
        `VERDICT_COPY`, which the browser imports, so a grid of forty cards carries forty
        short strings rather than forty copies of a paragraph.
      */
      ...requestStateOf(q, d),
      /*
        Why a FAILED request failed, in more detail than the generic verdict sentence.

        Already through `safeArrMessage` before it was ever written to the row -- the
        request worker sanitises on the way in, precisely so this column can be served.
        Null for every request that has not failed. Not part of `RequestStateView`, which
        says why: a request-log row already carries this string under its own name.
      */
      requestError: q?.error ?? null,
      service: serviceFor(r.kind),
      posterUrl: posterPath(r.tconst, art),
      studio: art?.studio ?? null,
      studioLogo: logos.urlForTitle(r.kind, art?.studio),
      plex: playLink(r.tconst),
      /*
        Did this win Best Picture, the Palme d'Or, Outstanding Drama Series -- a Map read
        and no query, which is the only reason a mark can be afforded on every card in the
        product. The award tables are in the app database and these rows come from the title
        index, so a per-card join is not even available across the two connections; the whole
        winner set is ~200 rows and lives in memory. See `AwardMarkIndex`.
      */
      award: awardMarks.get(r.tconst),
    };
  });
}

/**
 * Where the browser fetches a title's poster, or null when there is genuinely none.
 *
 * ALWAYS our own proxy path and never the upstream URL, for the reason `decorate` states at
 * length. What is worth having one owner for is the THREE-WAY distinction the ternary hides:
 * an artwork row we have never written (`undefined`) still gets a path, because the route
 * resolves it through the arrs on first fetch; a row we HAVE written whose `url` is null is a
 * title somebody looked up and found no art for, and pointing at the proxy there is a request
 * guaranteed to 404. Getting that backwards costs one doomed round trip per card.
 *
 * A second surface wanted it -- the request list, which draws a poster per row since R4 -- and
 * a retyped ternary is exactly the shape that drifts: the wrong half of it still renders.
 *
 * > [!IMPORTANT] The ARTWORK LOOKUP that feeds it is PER ROW, and it is the second-dearest
 * > thing on `/api/requests`
 * > This function is free -- it is a ternary. What is not free is the `store.getArtwork()` its
 * > callers pass it, which `decorate` resolves per row and the request route does too. Measured
 * > on studio (M-series, macOS arm64, bun 1.4.0), 2026-09-06, with `src/jobs/bench-requests.ts`:
 * > **0.592 ms for 200 rows**, about 3 us each, on an indexed single-row `select` against
 * > `artwork`. That is about a quarter of everything `5ae3f8e` added to a route polled every
 * > eight seconds -- second only to the episode read `seasonProgressLinker` owns.
 * >
 * > A per-response `Map` would collapse it the way `plexLinker` and `requestDiagnosticMap`
 * > already collapse theirs, and at 200 rows that is the shape this route would take if the
 * > number ever mattered. It does not yet: 0.592 ms of a 4.6 ms response, on the worst list the
 * > route can be asked for. Do not pre-emptively collapse it -- re-measure first.
 */
function posterPath(tconst: string, art: { url: string | null } | undefined): string | null {
  return art !== undefined && art.url === null ? null : `/img/t/${tconst}`;
}

/**
 * Where to PLAY each title, from the Plex mirror -- as a lookup resolved once per response.
 *
 * A CLOSURE over the two store reads rather than a per-row query: `plexMap()` walks the whole
 * mirror and the machine identifier is a second read, so doing either inside the row loop
 * would turn one pair of queries into two per card.
 *
 * It exists because a SECOND surface now answers "has this arrived": the request list on
 * `/requests`, beside the decorated title cards. The `ratingKey ? links : null` rule is the
 * part worth having one owner for -- a half-addressed deeplink does not fail, it opens the
 * server's home screen and looks like it worked (see `plexLinks`).
 */
function plexLinker(): (tconst: string) => PlexLinks | null {
  const mirror = store.plexMap();
  const machineId = store.plexMachineIdentifier() ?? "";
  return (tconst) => {
    const ratingKey = mirror.get(tconst);
    return ratingKey ? plexLinks(machineId, ratingKey) : null;
  };
}

/**
 * One stored removal as the log renders it, with the actor's name resolved.
 *
 * Takes the SAME name table `attributedRequest` is given, so a person is worded identically
 * wherever the log names them -- "(removed)" for a deleted account, and never a bare id.
 * Undefined in, undefined out: a `removed` row with no audit record predates the record or was
 * moved by hand, and inventing an actor for it would be the one lie an audit may not tell.
 */
function removalView(
  removal: MediaRemoval | undefined,
  names: ReadonlyMap<string, string> | null,
): RequestRemovalView | undefined {
  if (!removal) return undefined;
  return {
    by: removal.removed_by,
    byName: removal.removed_by ? (names?.get(removal.removed_by) ?? "(removed)") : null,
    at: removal.removed_at,
    deletedFiles: removal.deleted_files === 1,
    bytes: removal.bytes,
  };
}

/**
 * Everything `./remove-media.ts` needs, assembled per call rather than held.
 *
 * Per call because it closes over nothing that outlives one: `plexHolds` reads the Plex
 * mirror, which the sync rewrites, and a captured map would answer a question about a moment
 * that has passed. It costs one query and is only ever built when an admin presses a button.
 */
function removalDeps(): RemoveMediaDeps {
  const inPlex = store.plexMap();
  return { store, radarr, sonarr, plexHolds: (tconst) => inPlex.has(tconst), log };
}

/**
 * Per-season progress for each request in one response -- a lookup resolved once, like
 * `plexLinker`.
 *
 * ONE query for the whole page, and that bound is the reason this is a closure rather than a
 * call per row: `RootLayout` polls `/api/requests` every eight seconds for the queue badge,
 * so a `store.episodeMap` per series row would be two hundred statements every eight seconds
 * for as long as any tab is open. `store.episodesForSeries` says the same thing about its own
 * `in` clause.
 *
 * FILMS COST NOTHING. They are filtered out before the query, by the same `serviceFor` that
 * decides which arr a request goes to -- so a library of films asks the episode table nothing
 * at all, and the answer for one is the empty list rather than a null every caller must guard.
 *
 * `todayUtc()` is read ONCE per response rather than per row: every season on the page is then
 * described as of the same instant, and a list rendered across a UTC midnight cannot report
 * two different days.
 *
 * > [!IMPORTANT] COST, MEASURED -- this is the DEAREST thing `5ae3f8e` put on this route
 * > Measured on studio (M-series, macOS arm64, bun 1.4.0), 2026-09-06, with
 * > `src/jobs/bench-requests.ts` at 200 requests of which 80 are series carrying 6 seasons of 12
 * > episodes -- 5,760 mirrored episode rows: the one `episodesForSeries` query is **1.751 ms**
 * > and the `episodeStateOf` + `seasonProgress` pass over its result is **0.160 ms**. Together
 * > that is roughly two thirds of everything `5ae3f8e` added to this response, and it is why
 * > the per-row form the paragraph above rejects was worth rejecting: the query is already the
 * > expensive half at ONE statement.
 * >
 * > It scales with EPISODES rather than with rows -- 20 series cost 0.451 ms and 80 cost 1.751,
 * > which is linear in the mirror rather than in the page -- so a household with long-running
 * > shows pays more than one with the same number of films. If this route ever needs to get
 * > cheaper this is the read to attack, and `episodesForSeries` is `select *` over a row with
 * > more columns than `seasonProgress` reads. Whether narrowing it helps is NOT measured; the
 * > harness above takes the depth as arguments, so measure it before believing it.
 */
function seasonProgressLinker(
  requests: readonly { tconst: string; kind: string; seasons: string | null }[],
): (request: { tconst: string; kind: string; seasons: string | null }) => SeasonProgress[] {
  const series = requests.filter((r) => serviceFor(r.kind) === "sonarr").map((r) => r.tconst);
  const episodes = store.episodesForSeries(series);
  const today = todayUtc();

  return (request) => {
    const rows = episodes.get(request.tconst);
    if (!rows) return [];
    // `decodeSeasons` and not a second `split(",")`: the stored spelling has one owner, and
    // it already answers null for "the reader never chose", which is exactly the narrowing
    // `seasonProgress` wants to skip.
    return seasonProgress(rows.map(episodeStateOf), today, decodeSeasons(request.seasons));
  };
}

/**
 * Our Sonarr's per-episode state for one series.
 *
 * Read straight out of the mirror, so this is local SQLite like every other render-path
 * read. The shape and the reason it is a list rather than a keyed object are stated once,
 * in `src/lib/episodes.ts`.
 */
function episodeStateFor(tconst: string): EpisodeState[] {
  return [...store.episodeMap(tconst).values()].map(episodeStateOf);
}

/**
 * The refusal both episode-grain requests make before they look at anything else, or null
 * when the caller may proceed.
 *
 * ONE owner, because the two routes are the same precondition at two grains and a second
 * copy would be free to drift into offering an episode of a series we do not hold. Refusing
 * rather than adding the series: adding one is a different, heavier operation with a season
 * selection of its own, and the button for it is on the same page.
 */
function refuseUnlessSonarrHolds(tconst: string): Response | null {
  if (!sonarr) return bad("Sonarr is not configured", 503);
  if (store.libraryMap().get(tconst)?.service !== "sonarr") {
    return bad("request the series first -- Sonarr does not hold it yet", 409);
  }
  return null;
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
 * Every credit a provider named on this title, cast and crew together.
 *
 * BOTH, because a crew name links exactly as a cast name does and the map that resolves
 * them is one map -- asking for the cast alone would leave the director unlinked on a title
 * whose director is not in IMDb's curated top ten. A facet that is still pending yields
 * nothing, which is correct: the client re-asks when it lands.
 */
function creditsIn(resolvedFacets: ResolvedFacets): PersonCredit[] {
  const cast = resolvedFacets.cast;
  const crew = resolvedFacets.crew;
  return [
    ...(cast?.status === "ready" ? (cast.data ?? []) : []),
    ...(crew?.status === "ready" ? (crew.data ?? []) : []),
  ];
}

/*
  THE READ SIDE of the `person_image` edge, in the three shapes its four callers want.

  The title route files a face under an nconst (see `personFaces`); everything below is what
  reads one back, and all of it is a local SQLite lookup on the render path.

  `null` is the ORDINARY answer rather than a gap, at every one of them: coverage grows with
  the titles people actually open, so a person whose filmography nobody has visited has no
  face on file and their tile draws initials. `PersonPortrait` was written with that fallback
  from the start.
*/

/** The stored proxy key, for the two preview surfaces that want the key itself. */
function faceKeyOf(nconst: string): string | null {
  return store.personImageKeys([nconst]).get(nconst) ?? null;
}

/**
 * The same face as a PATH, for the JSON payloads that hand it to a browser.
 *
 * Separate from `faceKeyOf` rather than folded into it because the preview surfaces
 * genuinely want the key: one serves the bytes itself and the other builds an absolute URL
 * for a crawler. `facetImagePath` stays the single owner of what a path looks like.
 */
function faceOf(nconst: string): string | null {
  const key = faceKeyOf(nconst);
  return key ? facetImagePath(key) : null;
}

/**
 * A row of people, each carrying the face we hold for them, or null.
 *
 * The BATCH form of `faceOf`, and the batching is the whole reason it is its own function:
 * a search row is eight people, and eight prepared-statement round trips to answer one
 * question is the shape that turns a sub-millisecond lookup into a visible one. Same
 * reasoning as `tconstCandidatesByTmdbId` in `relatedRows`.
 *
 * `undefined` in, `undefined` out -- the key must stay ABSENT on an index that cannot
 * search people at all, so a client can still tell "nobody by that name" from "this index
 * has no people in it yet".
 */
function withFaces(hits: PersonHit[] | null): (PersonHit & { image: string | null })[] | null {
  if (!hits) return null;
  if (hits.length === 0) return [];
  const keys = store.personImageKeys(hits.map((h) => h.nconst));
  return hits.map((h) => {
    const key = keys.get(h.nconst);
    return { ...h, image: key ? facetImagePath(key) : null };
  });
}

/**
 * The same, for `related` -- "more like this".
 *
 * A recommendation whose tconst never resolved, or which we simply do not index, yields
 * nothing. That is what keeps the row honest: every card in it is a real destination.
 *
 * The crosswalk from a recommendation's TMDB id to ours is done HERE, against `externalIds`
 * rows we already hold, precisely so it costs no upstream call: asking the proxy per
 * recommendation is eleven calls for one film view, which is the sweep the one-click-deep
 * rule forbids. Coverage grows as titles are opened. `kind` is what tells it WHICH TMDB id
 * space the recommendations are in -- see `./related-crosswalk`.
 */
function relatedRows(resolvedFacets: ResolvedFacets, kind: EntityKind): TitleRow[] {
  const resolved = resolvedFacets.related;
  if (resolved?.status !== "ready" || !resolved.data) return [];

  const tconsts = relatedTconsts(resolved.data, kind, {
    candidatesFor: (ids) => store.tconstCandidatesByTmdbId(ids),
    titleTypeOf: (tconst) => live.current.byTconst(tconst)?.kind ?? null,
  });
  return rowsFor(tconsts.map((tconst) => ({ tconst })));
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
 * Every (title, term) pair we hold in one dimension, out of local SQLite.
 *
 * THE ONE PLACE the three reverse reads are chosen between, so both term handlers apply
 * the same liveness rule -- a page built on rows from an uninstalled addon would outlive
 * the plugin that produced them, which is what `liveCollectionRows` guards for collections.
 *
 * `country` is only meaningful for `service`, and defaulting it is not an option: the facet
 * carries ~112 of them and the reader is in exactly one. A service read with no country
 * asked for is empty rather than "whatever country we happen to hold" -- the same refusal
 * `pickWatchProviders` makes for the pane.
 *
 * `tconst` narrows to one title, which is what the chip gate asks; omitted it is the whole
 * corpus, which is what a term page needs. That unnarrowed read is one indexed scan and no
 * JSON parsing in JS, the same shape `/api/collections` already runs on every keystroke.
 */
function termPairs(dimension: TermDimension, opts: { country?: string; tconst?: string } = {}): TermPair[] {
  const pluginIds = plugins.list().map((p) => p.meta.id);
  switch (dimension) {
    case "keyword":
      return store.keywordPairs(pluginIds, opts.tconst);
    case "service":
      return opts.country ? store.watchServicePairs(opts.country, pluginIds, opts.tconst) : [];
    case "studio":
      return store.studioPairs(opts.tconst);
  }
}

/**
 * Every dimension's terms for one title, each with how many titles its page would hold.
 *
 * What turns a chip into a link, and the count is measured HERE rather than guessed in the
 * browser: only the server can see how much of the corpus has been cached. The two reads
 * per dimension are the cost of the endpoint, and `termsForTitle` states why both are
 * needed -- this function is only the wiring.
 */
function titleTerms(tconst: string, country: string | undefined): Term[] {
  return TERM_DIMENSIONS.flatMap((dimension) =>
    termsForTitle(dimension, termPairs(dimension, { country, tconst }), termPairs(dimension, { country })),
  );
}

/**
 * Facet coverage per shelf -- the card's acceptance, one `curl` away.
 *
 * `isWarm` reads the facet cache and asks no provider: a health check that warmed the
 * cache would only ever be reporting on itself. It costs one indexed SQLite lookup per
 * shelf title on top of the shelf queries, which is why it lives on `/api/health` and
 * on no path a user is waiting on.
 *
 * IT REPORTS THE SHIPPED PAGE, not any one reader's, and that is the whole page rather than a
 * sample of it: a preference can only reorder and hide, so every reader's page is a subset of
 * this one. Reporting per reader would also be a coverage figure that named who had arranged
 * what, which is not a thing to publish about a private choice. See `warmShelves`.
 */
const shelfCoverage = () => facetCoverage(currentShelves(), (row) => facets.isWarm(entityFor(row)));

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
const awardsDeps = (def: AwardDef): AwardsDeps => ({
  store,
  engine: live.current,
  decorate,
  def,
  source: awardSourceMeta(store, def.id),
});

/**
 * What the list-completion handler reads, resolved at the moment of use.
 *
 * `live.current` inside the closure for the same reason `awardsDeps` does it -- an engine
 * captured across a daily promote serves yesterday's file or throws.
 *
 * The YEAR is the server's, and the browser generates the same catalogue from its own
 * clock. They can disagree for a few hours either side of New Year, in which case a decade
 * list the browser drew has no completion in this payload and simply renders without one.
 * That is the same missing-id path an unranked index already takes, so it needs no second
 * mechanism -- and pinning the year in the URL would make it cacheable state somebody has
 * to keep meaningful instead.
 */
const listsDeps = (): ListsDeps => ({
  year: new Date().getFullYear(),
  members: (list) => live.current.rankedMembers(list.filters, LIST_SIZE),
  ownedCount: (tconsts) => store.ownedCount(tconsts),
  winners: (award) => awardMarks.winnersFor(award),
  // `undefined` is a title we have never looked up and `{url: null}` is one we looked up and
  // found nothing for. Both mean "do not put it in a strip", and only the second is a fact:
  // see `Store.getArtwork` for why the two must not be collapsed anywhere else.
  hasPoster: (tconst) => (store.getArtwork(tconst)?.url ?? null) !== null,
  credits: (tconsts) => live.current.creditTally(tconsts),
});

const staticDir = `${import.meta.dir}/../../web/dist`;

/**
 * Is there a built web UI to serve?
 *
 * > [!IMPORTANT] Latched TRUE, re-checked while false. It must not be a boot-time snapshot.
 * > It was `const haveStatic = existsSync(staticDir)` evaluated once at module load, and in
 * > development that is a trap with no recovery: `vite build` sets `emptyOutDir`, so it
 * > DELETES `web/dist` before writing the new one. A server that happens to start inside
 * > that window -- and `bun --watch` restarts on any source edit, so the window is hit
 * > often -- latches `false` forever and answers 503 "web build missing" to every request
 * > from then on, with a fully built `web/dist` sitting on disk beside it. The only cure
 * > was a restart nobody knew they needed, because the page says the build is missing and
 * > the build is right there.
 *
 * Latching on success is what keeps this free in production: the container always has the
 * directory, so the `existsSync` runs once and never again. The syscall is only paid on the
 * path that is already answering an error.
 */
let haveStatic = existsSync(staticDir);
const webBuildPresent = (): boolean => {
  if (haveStatic) return true;
  haveStatic = existsSync(staticDir);
  return haveStatic;
};

/**
 * One of the two HTML shells, with the headers that say WHICH one this was.
 *
 * Three call sites want this -- a preview that fell through, `/` itself, and the SPA
 * fallback -- and until they were one function the `/` one was the odd one out: it fell
 * through to the ordinary static-file branch, which keys a cache on the URL alone. So the
 * URL that most reliably serves two different documents was the one URL that did not say
 * so. `PER_SESSION_REVALIDATED` carries the `Vary: Cookie` that fixes it.
 */
const shellResponse = (name: string): Response =>
  new Response(Bun.file(`${staticDir}${name}`), {
    headers: {
      "Content-Type": "text/html",
      ...cacheHeaders(PER_SESSION_REVALIDATED),
      ...HTML_HEADERS,
    },
  });
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
  /*
    Rebuild the index and adopt it, without a shell on the host.

    THE POINT IS THAT IT DOES BOTH HALVES. `bun src/jobs/build-index.ts` run by hand
    against a live server PROMOTES: it renames the file this process holds open, after
    which that connection throws on most reads and quietly serves yesterday on the rest,
    until somebody restarts the container. Nothing in the job's output says so. This route
    is the same build followed by the swap, which is the only combination that is safe
    while the server is up.

    Returns as soon as the refresh is UNDERWAY rather than awaiting it: a build is minutes
    and an HTTP client that waits that long has usually been killed by a proxy first. The
    outcome lands in `index.reload` on `/api/health`, which is where the daily refresh
    already reports.
  */
  "/api/admin/index/refresh": {
    POST: (req: Request) =>
      auth.asAdmin(req, () => {
        const already = refresher.refreshing();
        void refresher.run("admin request").catch((err) => log(`admin refresh failed -- ${err}`));
        return json({ started: !already, alreadyRunning: already });
      }),
  },

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
            warm: warmHealth(live.warmStatus()),
            // Read off the OPEN engine rather than from the stage stamp: the stamp says
            // what the build intended, this says what the file being served can do.
            origin: { available: live.current.hasOrigin, configured: [...cfg.languages] },
          },
          library: store.libraryCount(),
          plex: { items: store.plexCount(), machineId: store.plexMachineIdentifier() },
          upcoming: {
            radarr: store.upcomingCount("radarr"),
            sonarr: store.upcomingCount("sonarr"),
            tmdbMovie: store.upcomingCount("tmdb-movie"),
            tmdbSeries: store.upcomingCount("tmdb-series"),
          },
          trending: store.trendingCount(),
          // One entry per award rather than one number: "awards: 12,137 rows" stopped being
          // a fact about the subsystem the moment there were three of them, and a second
          // source that silently imported nothing would hide behind the first one's total.
          awards: AWARDS.map((def) => {
            const meta = awardSourceMeta(store, def.id);
            return {
              award: def.id,
              rows: store.awardCount(def.id),
              sha: meta?.sha ?? null,
              importedAt: meta?.importedAt ?? null,
            };
          }),
          services: { radarr: !!radarr, sonarr: !!sonarr, prowlarr: !!prowlarr },
          auth: {
            users: authStore.userCount(),
            admins: authStore.adminCount(),
            sessions: authStore.sessionCount(),
            apiKey: !!cfg.auth.adminApiKey,
            // The NAME, not a boolean: "auth is off" and "auth is off and everyone is one account"
            // are different facts, and the second is the one that explains what a reader is
            // looking at. Null is the ordinary case and every deployment. This block is
            // admin-only, so it discloses the account name to nobody who could not already
            // list every user.
            noAuth: cfg.auth.noAuth,
          },
          // Two integers over the whole table. No title, no name -- see `WatchlistStats`.
          watchlist: watchlistStore.stats(),
          push: { enabled: pushNotifier.enabled, devices: authStore.pushSubscriptionCount() },
          // Counters held in memory, so this asks nobody anything -- the rule this endpoint
          // runs on. `received: 0` is how an operator finds out the Webhook connection they
          // configured on the arr side never saved; nothing else would say so.
          webhook: arrWebhooks.stats(),
          queue: worker.stats(),
          artwork: artwork.stats(),
          /*
            Whether the front page is HELD, and when each tier last rebuilt.

            The per-tier timestamps are the field worth reading: they are the only way to
            tell "held and current" from "held and one timer has quietly stopped writing".
            `enabled: true` with `ready: false` means every request is falling back to
            computing the page -- correct, and otherwise completely invisible.
          */
          shelves: frontPage.status(cfg.shelves.keepFresh),
          // Id AND declared hosts, both off `meta` in memory. See `HealthDeps.plugins` for
          // why the per-plugin facet row count is not here.
          plugins: plugins.list().map((p) => ({ id: p.meta.id, hosts: [...(p.meta.hosts ?? [])] })),
          facetRows: store.facetCacheCount(),
          facetImages: store.facetImageCount(),
          facetRowsPruned,
          /*
            How much evidence the retune has, and whether anything is being lost.

            `stored` is what a report would read; `pending` is what has not been flushed yet.
            `dropped` is the field worth watching -- non-zero means a client is looping on
            the click endpoint faster than the 30s flush drains it. It counts NO queries and
            NO people: the whole payload is four integers.
          */
          searchLog: {
            enabled: cfg.searchLog.enabled,
            ...searchLog.report(),
            stored: store.searchLogCounts(),
          },
          timings: {
            providers: facets.timingReport(),
            outbound: outboundTimings().report(),
            requests: requestTimings.report(),
            slow: slowRequests.recent(),
          },
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
            peak: mirrorPeak.highest,
            // Through the holder, because this payload is built for EVERY health request
            // including the anonymous one, and the container probes it while the boot-time
            // build is still running. `current` throws then -- see `LiveIndex.poolStats`.
            fuzzy: live.poolStats(),
          },
          // Passed as a thunk, never a value -- see health.ts.
          coverage: shelfCoverage,
          load: () => searchCost.report(),
        },
        { coverage: new URL(req.url).searchParams.get("coverage") === "1", detailed },
      ),
    );
  },

  /**
   * What an agent can do here, generated from this very table. See `./agent-api.ts`.
   *
   * The entry point is a fixed, publicly known path and the KEY is what is secret --
   * discoverability never required putting the token in the URL.
   */
  [AGENT_MANIFEST_PATH]: (req: Request) => agentManifest(req),

  "/api/search": async (req: Request) => {
    /*
        The one route with its own limiter on top of the login wall.

        A fuzzy query is real CPU work over a 1.27M-row index -- roughly 400x a cached read
        -- so a loop of typos pins a core. That is true of a SIGNED-IN caller too, which is
        why the check is here rather than in the guard: authentication says who somebody
        is, not how much of the machine they may have.
      */
    // The ACCOUNT when there is one, the address otherwise -- `auth.limitKey` owns that
    // rule and says why an address is the wrong bucket for a caller we can name. A second
    // derivation here would go on counting the whole internet against the proxy's socket
    // address the day proxy trust is turned on for the auth routes.
    const key = auth.limitKey(req);
    if (!auth.searchLimiter.take(key)) {
      return json(
        { error: "too many searches" },
        { status: 429, headers: { "Retry-After": String(auth.searchLimiter.retryAfter(key)) } },
      );
    }

    /*
      THE SECOND LIMITER, AND IT COUNTS MILLISECONDS RATHER THAN REQUESTS.

      The one above is a request budget, which is the right defence against a retry loop and
      the WRONG one against expense: every request it counts is worth the same to it, while
      two searches on this index differ in cost by three orders of magnitude. So a caller
      running 25 deliberately expensive queries a minute is inside their request budget and
      owns the event loop. `searchCost` is what notices -- and it only refuses once somebody
      else is actually being denied, so a lone reader on a quiet evening is never throttled
      for using a server that was doing nothing else. See `src/lib/cost-meter.ts`.
    */
    const admission = await searchCost.admit(key);
    if (!admission.allowed) {
      return json(
        { error: "too much search work in the last minute" },
        { status: 429, headers: { "Retry-After": String(searchCost.retryAfter()) } },
      );
    }

    const u = new URL(req.url);
    /*
      MEASURED 2026-09-07 against the real index: an unbounded `q` reached 26,631 ms of
      single-threaded CPU on one 22 KB request, because `matchExpr` unions one FTS5 prefix
      term per token and the cost is quadratic in the token count. `boundedQuery` owns both
      caps and the numbers behind them; nothing here re-decides them.

      A refusal, never a truncation: a shortened query answers a question the reader did not
      ask and looks exactly like a working search.
    */
    const guarded = boundedQuery(u.searchParams.get("q"));
    if (!guarded.ok) return bad(refusalMessage("q", guarded));
    const q = guarded.value;
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

    /*
      The four facet scalars, read once and spent twice -- narrowing the search, and stored
      on its log row. One derivation rather than two, so the row can never claim a chip the
      engine did not actually apply.
    */
    const filters: SearchFilters = {
      genre: u.searchParams.get("genre") ?? undefined,
      decade: num("decade"),
      year: num("year"),
      kind: u.searchParams.get("kind") ?? undefined,
    };

    /*
      BOTH INDEX READS ARE INSIDE ONE `measure`, and that is the honest boundary.

      What the meter is for is "how much of the event loop did this caller take", so it has
      to charge for everything a caller's query makes this process do -- the title search
      and the people search are one request's worth of work whatever the internal split.
      Timing them separately would also charge the caller twice for one `Bun.nanoseconds`
      pair's worth of overhead.

      The TARPIT WAIT IS DELIBERATELY OUTSIDE IT. A caller must never be charged for time we
      chose to make them sit still, or a tarpitted caller accrues spend for waiting, which
      lengthens the next delay, which accrues more spend -- a feedback loop that turns a
      one-off overspend into a permanent penalty.
    */
    const [res, people] = searchCost.measure(key, () => {
      const hits = live.current.search(q, { limit: Math.min(num("limit") ?? 25, 100), ...filters });
      /*
        PEOPLE, beside the titles rather than among them.

        Its own key because a person and a title are different nouns: merging them would put
        `Hit`'s title-shaped fields on somebody's name, and the facet chips below the box
        narrow titles and mean nothing to a person.

        NOT filtered by the facet scalars, for the same reason: "Christopher Nolan" is not a
        1990s Comedy. A chip narrows the grid and leaves the people row alone.

        One more local SQLite read on a request that already does several. Measured on the
        real 353,117-person index: 0.06ms for "christopher nolan", 0.13ms for "nolan", 1.5ms
        for "tom" and 4.3ms for the worst shape the length floor admits -- beside a 7.8ms
        mean for the title search it rides with. Cheap enough to stay on this request rather
        than becoming the separate endpoint the card offered as the escape hatch.
      */
      return [hits, withFaces(live.current.searchPeople(q))] as const;
    });

    // Resolve artwork for whatever the user is about to look at, in the
    // background. Never blocks the response.
    artwork.prewarm(res.hits.map((h) => ({ tconst: h.tconst, kind: h.kind })));

    /*
      The evidence the scorer is retuned against, and it costs one array push.

      `hits.length` rather than `candidates`: the question worth answering later is "did
      this query work for the person who typed it", and `0` is the failure to go looking
      for. `candidates` counts what the index offered before the facet filters ran, which is
      never zero for a query that returned nothing after a chip was applied.

      The filters ride along because a chip click leaves the query text identical: without
      them, narrowing by chip and running the same search twice are the same row.
    */
    searchLog.searched(q, res.hits.length, filters);

    return json(
      // The key is ABSENT, not empty, on an index that cannot search people -- so a client
      // can tell "nobody by that name" from "this index has no people in it yet".
      { ...res, hits: decorate(res.hits), ...(people ? { people } : {}) },
      // Identical queries are extremely common while typing. A short private cache
      // means the back button and repeated keystrokes cost nothing at all.
      { cache: perSession(60) },
    );
  },

  /**
   * Which result somebody opened, and where it was sitting.
   *
   * THE HALF THAT MAKES THE QUERY LOG WORTH KEEPING. A log of queries can say a search
   * returned something; only this can say the thing the reader wanted was at rank 4, which
   * is a ranking failure the search itself reports as a success.
   *
   * Fire-and-forget by contract -- `204`, no body, and the browser sends it with `keepalive`
   * on the way to another page (`reportSearchClick` in `web/src/lib/api.ts`). It carries no
   * identity and it is not a state change anybody can observe, so the only thing that can go
   * wrong here is junk in the tuning data: `parseClickBody` refuses anything it does not
   * recognise rather than storing a coerced version of it.
   *
   * No limiter of its own. It is behind the login wall, it costs one array push into a
   * bounded buffer, and a signed-in client looping on it spends its own agent budget and
   * gets `dropped` counted in `/api/health` rather than unbounded memory.
   */
  "/api/search/click": {
    POST: async (req: Request) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return bad("body must be JSON");
      }
      const row = parseClickBody(body, Date.now());
      if (!row) return bad("query, tconst, rank and tier are required");
      searchLog.clicked(row);
      return new Response(null, { status: 204 });
    },
  },

  /**
   * A title, plus whatever facets are already cached.
   *
   * For a BROWSER the handler never awaits a provider: it reads the facet cache and kicks
   * the resolver in the background. A facet nobody has answered yet comes back `pending`,
   * which the page renders as a skeleton, and it is there on the next view.
   *
   * > [!CAUTION] FOR AN AGENT KEY IT BLOCKS, and that suspends this file's governing rule
   * > The rule at the top of this file says a handler that can block on a network call
   * > while a user waits is a bug. The line below awaits providers, so anybody meeting it
   * > cold is right to be suspicious -- this comment is what tells them it was decided
   * > rather than missed.
   * >
   * > The rule exists because a human staring at a skeleton is the failure this product was
   * > built to end. **An agent has no skeleton to stare at.** No page is blank, nothing
   * > re-renders, and asking again costs strictly more than waiting once. So the exception
   * > is the rule being read for what it protects, and it holds ONLY for a caller
   * > authenticated by an agent key: a browser session takes exactly the path it always did.
   * >
   * > It costs nothing extra upstream. `resolve` awaits the same promises `warm` would have
   * > started, and `ask` joins a call already in flight -- so an agent arriving while a
   * > browser is rendering the same title shares one fetch rather than buying a second.
   * >
   * > The wait is bounded well under the 15s provider deadline (see `AGENT_WAIT_MS`), and a
   * > provider still running at the deadline is NOT abandoned: its answer still lands in the
   * > cache, which is what makes asking again later cheap rather than a repeat of the wait.
   */
  "/api/title/:tconst": async (req: Bun.BunRequest<"/api/title/:tconst">) => {
    const row = live.current.byTconst(req.params.tconst);
    if (!row) return bad("unknown title", 404);

    const entity = entityFor(row);
    // Read ONCE, and BEFORE the await: `principal` touches the session row on every call, so
    // asking it twice for one GET is two writes and two chances to disagree -- and asking
    // after the wait would resolve it against a session that may have been revoked while we
    // were blocked, which is a different question from the one this handler asked.
    const asker = auth.principal(req);
    if (asker?.kind === "agent") {
      await facets.resolve(entity, { deadlineMs: agentWaitMs(new URL(req.url)) });
    }
    // Rewritten before it leaves: every image a provider sent points at this origin, so
    // no upstream hostname appears in the JSON and `localImageUrl()` in the browser
    // passes it. Reads and writes local SQLite only.
    const cached = facetImages.rewrite(facets.read(entity));
    // Read the work state BEFORE warming: `workState` asks nobody, and taking it after
    // `warm()` would report the providers this very request just started as outstanding
    // even when they answer instantly from a coalesced in-flight call. After a blocking
    // resolve it is therefore exactly the honest answer an agent needs -- whoever STILL
    // owes this title a facet, by name, so a timed-out partial cannot be read as complete.
    const work = facets.workState(entity);
    facets.warm(entity);

    /*
      OUR ids for the people this title credits -- and, from the same pair of facts, the
      one place in the product where a face and an nconst are ever in hand together.

      The provider named the credits and `facetImages.rewrite` just turned their headshots
      into keys; the index says which of those people are ours. Filing the pair here is
      what lets /search draw a face for somebody instead of their initials, and it costs
      one guarded write on a path that has already read both halves. `person_image` in
      `store.ts` argues why the edge cannot be built anywhere else.
    */
    const titlePeople = live.current.personLinks(row.tconst, creditsIn(cached));
    store.rememberPersonImages(personFaces(creditsIn(cached), titlePeople));

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
        arrLink: arrLink(cfg, store.libraryMap().get(row.tconst), asker?.role ?? null),
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
            Our own ids for the people credited on this title, under BOTH keys a credit can
            carry: the provider's own person id, and the folded name.

            Sent alongside the facets rather than merged into them: the cast facet is a
            PROVIDER's data and identifies people by TMDB id, while this is OUR index
            answering a different question. Writing nconsts into the facet would make the
            cached provider payload depend on which index built it.

            The credits are read back OUT of the resolved facets to build it, which is why
            this sits after `cached`: the id half can only answer for people the providers
            actually named. `nconstForCredit` in the browser is the single owner of the
            precedence between the two halves.
          */
        people: titlePeople,
        /*
            WHAT THE WORLD SCORED EACH EPISODE, from our own index.

            Beside the facets for the same reason `people` and `episodeState` are: the
            `episodes` facet is skyhook's answer to "what exists", and this is OUR index
            answering "what did anyone think of it". They join in the browser on the
            (season, number) pair.

            Sent on the title payload rather than fetched separately on purpose. It is a
            local SQLite read of a few dozen rows, and a second round trip would put a
            waterfall in front of the one view a reader opens this page for.

            An EMPTY array is a real answer and the pane still draws: an unaired episode
            has no IMDb row and never will until it airs, so the grid renders its skeleton
            from the facet with those cells blank. See `./episode-scores.ts`.
          */
        episodeScores: episodeScoresFor(live.current, row.tconst, entity.kind === "series"),
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
        relatedTitles: decorate(relatedRows(cached, entity.kind)),
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
      /*
        Shorter than the 300s the local-only version used: this response now carries
        facets that fill in behind it, and a stale cache would hide them.

        `perSession` and not a plain `private`, because `arrLink` above is an ADMIN's
        answer and `null` for everybody else. Same URL, two bodies -- so the cache needs
        the session in its key or it will hand an ordinary reader a Radarr address.
      */
      { cache: perSession(30) },
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
      /*
        The LIST's own language, which is the one language thing that does belong in a URL.

        It names a page -- "Best films in Korean" -- the way `genre` does, so it is a FILTER
        and travels with the address, while `languages` below stays a deployment preference
        the client may only switch off. `browseSql` gives this one precedence: a reader who
        named a language has already overridden the default.

        Validated to a bare ISO 639-1 code rather than passed through, on the same terms as
        `sort`: a stale or hand-typed value is dropped, exactly as `decade=banana` is. A
        well-formed code we hold nothing for is a legitimately empty page, not an error.
      */
      lang: LANG_CODE.test(u.searchParams.get("lang") ?? "")
        ? (u.searchParams.get("lang") as string)
        : undefined,
      // An unknown `sort` falls back to the default rather than 400ing: it reaches SQL as
      // an ORDER BY, so it is validated against the closed union at the door, and a stale
      // bookmark asking for a sort we removed should still render the grid.
      sort: isBrowseSort(u.searchParams.get("sort")) ? (u.searchParams.get("sort") as BrowseSort) : undefined,
      minVotes: num("minVotes"),
      /*
        The deployment's preference, liftable by `anyLanguage=1` and by nothing else.

        A FETCH OPTION, exactly like `minVotes`, and never `?languages=en,sv`. The client
        may only turn the preference OFF -- it can neither name a language nor add one, so
        no bookmark can carry a filter the operator did not configure, and the escape hatch
        is one boolean rather than a list to validate. Same shape as "Show all 1,132".
      */
      languages: u.searchParams.get("anyLanguage") === "1" ? [] : languageFilter(cfg.languages),
      limit: Math.min(num("limit") ?? 60, 200),
      offset: num("offset") ?? 0,
    });
    return json({ ...res, rows: decorate(res.rows) }, { cache: perSession(300) });
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
      { cache: perSession(60) },
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

        Spelled as the DEFAULT rather than as an explicit policy: `json` sends `no-store`
        unless a route asks for something else, so this is now the shape of not asking.
      */
    return json({ matches });
  },

  /**
   * One term -- a keyword, a streaming service, a studio -- and every title we hold for it.
   *
   * The sibling of `/api/collection/:id`, and the same reasoning end to end: the membership
   * already arrived with a cached facet (or, for a studio, with the artwork lookup), so
   * this reads local SQLite, asks no provider and warms nothing. A term nobody has cached a
   * title for has no page yet, which is a 404 rather than a fetch.
   *
   * NOT a `/browse` filter, and it could not be one: the terms live in `finderr.db` while
   * the title index is `titles.db`, two separate SQLite files, so `?keyword=heist` has no
   * WHERE clause to become. Same split `collectionTokenOf` already states.
   *
   * NO VOTE FLOOR. `browseVoteFloor` curates the broad grid; a term page is an explicit
   * membership list of what we have actually cached, so there is nothing to hide and no
   * escape hatch to offer -- exactly the ruling `/api/collection/:id` already carries, and
   * the same one for all three dimensions rather than one per chip.
   *
   * `?country=` is REQUIRED for `service` and ignored by the other two: availability is
   * per country and the reader's is chosen in the browser. Without it the page is honestly
   * empty rather than quietly showing somebody else's country's catalogue.
   */
  "/api/term/:dimension/:value": (req: Bun.BunRequest<"/api/term/:dimension/:value">) => {
    const { dimension, value } = req.params;
    if (!isTermDimension(dimension)) return bad("unknown term dimension", 404);

    const country = new URL(req.url).searchParams.get("country") ?? undefined;
    /*
      `value` is used RAW, and decoding it here was a bug caught before it shipped. Bun's
      router percent-decodes a path parameter for you -- measured, including `%2F` in a
      studio name -- so a second `decodeURIComponent` throws `URIError` on any term with a
      literal `%` in it ("100% pure" is a real TMDB keyword) and 500s the route. Same
      reading `/api/collection/:id` already relies on for `tmdb:2344`.
    */
    const page = termPage(dimension, value, termPairs(dimension, { country }));
    if (!page) return bad("unknown term", 404);

    // `live.current` is read INSIDE the callback for the reason stated in `live-index.ts`:
    // a promote during the daily refresh kills whatever engine we were already holding.
    const rows = page.tconsts.flatMap((t) => live.current.byTconst(t) ?? []);
    return json(
      {
        term: page.term,
        titles: decorate(rows.sort((a, b) => b.votes - a.votes)),
        /*
          Members we know about and cannot draw -- a title type we do not index. A count
          rather than a row of stubs, the same judgement `collectionPage` makes: a tile with
          no poster, no library state and no request button is a dead end wearing a poster
          frame, and an unexplained gap is worse than a number.
        */
        missing: page.tconsts.length - rows.length,
      },
      // Shorter than browse's 300s, for the reason a collection is: membership GROWS as
      // more titles are viewed and pre-warmed, and a long cache would hide one that
      // arrived a minute ago.
      { cache: perSession(60) },
    );
  },

  /**
   * The terms one title carries, and whether each of them goes anywhere.
   *
   * A route of its own rather than a block on `/api/title/:tconst`, because the answer
   * depends on the READER'S COUNTRY and the title payload does not: one cached title body
   * serves everybody, and folding a per-country field into it would either need the session
   * in the cache key or quietly serve Bangkok Germany's streaming services.
   *
   * The browser already holds the keywords, the offers and the studio -- the only thing it
   * cannot know is how populated each term's page would be, which is what this measures.
   */
  "/api/terms/:tconst": (req: Bun.BunRequest<"/api/terms/:tconst">) => {
    const country = new URL(req.url).searchParams.get("country") ?? undefined;
    return json(
      { terms: titleTerms(req.params.tconst, country) },
      // Same 60s as a term page and for the same reason: a chip becomes a link the moment
      // a second title carrying it is cached, and that can be a minute after this render.
      { cache: perSession(60) },
    );
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
      // Anything but the one word we understand falls through to the default ordering.
      // A filmography in the wrong order is a worse answer than a 400 is a useful one.
      sort: u.searchParams.get("sort") === "year" ? "year" : "votes",
    });
    if (!page) return bad("unknown person", 404);

    return json(
      {
        ...page,
        credits: decorate(page.credits),
        /*
            THEIR FACE, or null -- the same `person_image` edge a search row reads, on the
            page every one of those rows links to.

            BESIDE `person` rather than inside it, which is the same rule `awards` and
            `collaborators` below follow: `page.person` is our INDEX describing a human, and
            this is an app-DB mirror of what a metadata provider once sent for them. The
            index is rebuilt nightly from the dumps and no dump carries a headshot, so
            merging the two would put a field on `Person` that the thing producing `Person`
            can never fill.

            Null for most people and that is the ordinary case: coverage grows with the
            titles somebody has opened, and the header draws initials meanwhile.
          */
        image: faceOf(req.params.nconst),
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
        /*
            WHO THEY KEEP WORKING WITH -- one more local query over the same credits
            tables the filmography comes from.

            Beside the credits and NOT filtered by `category` or reordered by `sort`, for
            the same reason the category counts are not: this describes the person, while
            the grid below is a page of one view of them. Recomputed on every page of the
            filmography rather than only on the first, because the client merges the next
            page over this payload -- omitting it past offset 0 would make the pane vanish
            when a reader pressed "show more".
          */
        collaborators: live.current.frequentCollaborators(req.params.nconst),
      },
      { cache: perSession(300) },
    );
  },

  /**
   * Every edition of one award, newest first.
   *
   * The award is a PARAMETER now that there are three of them, and `/api/awards/oscars` is
   * one of the values it takes -- so every link that already existed keeps working. An award
   * not in the registry is a 404 rather than an empty timeline: "we do not have that award"
   * and "that award has no rows yet" are different facts and the page draws them differently.
   *
   * Local SQLite the whole way down, like every other render-path handler: the rows were
   * imported by a job on a yearly clock and this only reads them, joins the anchor titles
   * against the live index and counts ownership against the library mirror.
   *
   * A checkout that has never run the import gets `ceremonies: []` and a null `source`,
   * which the page renders as "no awards imported yet" rather than as an error -- the
   * import is optional in exactly the way the cast tables are.
   */
  "/api/awards/:award": (req: Bun.BunRequest<"/api/awards/:award">) => {
    const def = awardById(req.params.award);
    if (!def) return bad("unknown award", 404);
    return json(
      timelinePayload(awardsDeps(def)),
      // Long, because the underlying rows change once a year. The ownership counts ride on
      // the same response and move faster than that -- but they move on a library sync, and
      // a private 10-minute window on a page nobody watches for library changes is the
      // right trade. Per-session because the counts are about THIS instance's library.
      { cache: perSession(600) },
    );
  },

  /**
   * Which PEOPLE one award's nominations describe, ranked three ways.
   *
   * A STATIC segment sitting beside `/:ceremony`, which the router resolves first -- so
   * `people` can never be read as an edition key. That ordering is asserted in
   * `award-route-params.test.ts` rather than assumed, because the failure would be a 404 on a
   * page that exists.
   *
   * `?class=Acting` narrows every board to one of the source's own coarse classes. A class
   * the award does not use is a 404 rather than three empty boards: "we do not group people
   * that way" and "nobody in that group" are different answers, and only the first is a URL
   * somebody should be able to bookmark.
   */
  "/api/awards/:award/people": (req: Bun.BunRequest<"/api/awards/:award/people">) => {
    const def = awardById(req.params.award);
    if (!def) return bad("unknown award", 404);
    const page = peoplePayload(awardsDeps(def), new URL(req.url).searchParams.get("class"));
    if (!page) return bad("unknown class", 404);
    // Same window and the same reasoning as the timeline: the rows move once a year, and
    // nothing on this page is about the library, so there is not even an ownership count to
    // go stale. Per-session because every award payload is.
    return json(page, { cache: perSession(600) });
  },

  /**
   * One edition, every category, winner first.
   *
   * The parameter is the EDITION KEY, never a display label: the Academy numbers its
   * ceremonies (and `Year` is `1927/28` for the first six, so it could never be a key), while
   * Wikidata dates its awards and the year is all there is. Both are integers and both are
   * what `CeremonySummary.ceremony` carries, so one route serves both -- see `AwardEdition`.
   * A non-numeric or unknown edition is a 404, which is the same answer `/api/collection/:id`
   * gives for an id we hold nothing under.
   */
  "/api/awards/:award/:ceremony": (req: Bun.BunRequest<"/api/awards/:award/:ceremony">) => {
    const def = awardById(req.params.award);
    if (!def) return bad("unknown award", 404);
    const ceremony = Number.parseInt(req.params.ceremony, 10);
    if (!Number.isFinite(ceremony)) return bad("unknown ceremony", 404);
    const page = ceremonyPayload(awardsDeps(def), ceremony);
    if (!page) return bad("unknown ceremony", 404);
    return json(page, { cache: perSession(600) });
  },

  /**
   * Everything `/lists` cannot derive for itself: completion, posters, people boards.
   *
   * NOT the catalogue. That is static data both sides import from `src/lib/lists.ts`, so
   * sending it back over the wire would be a second copy of a table the browser already
   * has, arriving later than the page that draws it. What travels here is the three answers
   * that need the index or the library -- see `completionPayload`.
   *
   * Per-session and short, on the same reasoning as the awards timeline: the membership
   * moves once per index rebuild and the ownership moves on a library sync, which is the
   * faster of the two and is what the 60 seconds is for.
   */
  "/api/lists/completion": () => json(completionPayload(listsDeps()), { cache: perSession(60) }),

  /*
    ---------------------------------------------------------------------------
    The watchlist: a list you keep, that downloads nothing.

    > [!CAUTION] NOTHING HERE MAY EVER REACH AN ARR
    > A saved title is a note to yourself. It spends no daily quota, starts no search and
    > adds nothing to Radarr or Sonarr -- pressing Request is still the only thing in this
    > product that downloads, and that separation is the entire reason this feature was
    > safe to build. A timer that turned saves into requests is the ARCHIVED card
    > `finderr-watchlist-auto-request-from-plex-or-trakt`, archived because exactly that
    > shape had already auto-added unattended once through a dead OAuth token.
    ---------------------------------------------------------------------------
  */

  "/api/watchlist": {
    /**
     * The caller's own list, as decorated title cards, newest save first.
     *
     * FULL CARDS RATHER THAN IDS, and one endpoint rather than two, because the client needs
     * both answers and they are the same rows: `/watchlist` draws the cards, and every other
     * screen's save button reads the ids out of the same response. A second `?ids=1` shape
     * would be a second thing to keep in step for one fetch per session.
     *
     * A save whose title the INDEX no longer carries is dropped rather than sent as a hole.
     * The index is rebuilt nightly from the IMDb dumps and a tconst can leave it, so this is
     * the ordinary way a row goes stale -- the same rule `/api/collection/:id` applies to a
     * member it cannot draw. The row stays in the table: an index that gets the title back
     * tomorrow should give the reader their save back with it.
     *
     * NO CACHE POLICY, unlike every list route around it, and that is the default rather
     * than an omission -- `json` sends `no-store` unless a handler argues for something
     * else. There is no argument here: the answer is per-reader and changes the instant they
     * press Save, so any window at all would show somebody their own list without the thing
     * they just put on it.
     */
    GET: (req: Request) => {
      const me = readerId(req);
      // Nobody signed in keeps nothing. Not an error -- an empty list is the true answer.
      if (!me) return json({ titles: [] });
      const rows = watchlistStore.list(me).flatMap((e) => live.current.byTconst(e.tconst) ?? []);
      return json({ titles: decorate(rows) });
    },

    /**
     * Save one title for later.
     *
     * POST and not PUT: the id is in the body rather than the path because that is the shape
     * every other write in this table already takes, and there is nothing to be gained by a
     * second convention. Saving twice is a 200 with `saved: false`, not a conflict -- two
     * tabs pressing the same button is not an error anybody can act on.
     *
     * The tconst must be one the index can draw. Refusing an unknown id here is what stops a
     * list filling up with rows that can never render and can only ever be removed by an id
     * nothing on screen shows -- the same check `POST /api/requests` makes, for the same
     * reason.
     */
    POST: async (req: Request) => {
      const me = readerId(req);
      if (!me) return bad("sign in to keep a watchlist", 401);

      let body: { tconst?: unknown };
      try {
        body = (await req.json()) as { tconst?: unknown };
      } catch {
        return bad("body must be JSON");
      }
      if (typeof body.tconst !== "string" || !body.tconst) return bad("tconst is required");
      if (!live.current.byTconst(body.tconst)) return bad("unknown title", 404);

      return json({ saved: watchlistStore.add(me, body.tconst) });
    },
  },

  /**
   * Take one title off your list. Removing something that was never on it is `removed: false`
   * rather than a 404: the desired state is already true, which is the same answer
   * `/api/requests/seen` gives an anonymous caller.
   *
   * DELETE with the id in the PATH, unlike the POST above, because that is what
   * `/api/requests/:tconst` already does for the withdraw it is the sibling of -- and a
   * DELETE carrying a body is the shape half the HTTP stack in the world drops.
   */
  "/api/watchlist/:tconst": {
    DELETE: (req: Bun.BunRequest<"/api/watchlist/:tconst">) => {
      const me = readerId(req);
      if (!me) return bad("sign in to keep a watchlist", 401);
      return json({ removed: watchlistStore.remove(me, req.params.tconst) });
    },
  },

  /**
   * The assistant. One turn in, one answer out.
   *
   * Private by omission from `publicPaths()`, which is the design `withAuth` exists for --
   * a new route is behind the login wall by having been added. Everything else it enforces
   * (the audience rule, the daily spend cap, the ledger) lives in `./agent-chat.ts` and
   * `../lib/ai-spend.ts`, so this line is a mount and not a second owner of any of it.
   */
  "/api/agent/chat": {
    GET: (req: Request) => chatProbe(req, auth.principal(req)),
    POST: (req: Request) => chat(req, auth.principal(req)),
  },

  /*
    ---------------------------------------------------------------------------
    Your own front page: the order you arranged, and the shelves you hid.

    An ORDER AND A FILTER over the page finderr already assembled -- never a per-reader
    assembly. `src/lib/shelf-preferences.ts` owns what a preference means and why it is
    shaped that way; these three routes are storage plus the one read the render path makes.
    ---------------------------------------------------------------------------
  */

  "/api/shelves/preference": {
    /**
     * Every shelf this reader could arrange, in their order, hidden ones marked.
     *
     * THE FULL CATALOGUE AND NOT JUST THE VISIBLE ONES: `/api/discover` has already dropped
     * what they hid, so a settings screen built on that answer could hide a shelf and never
     * offer it back. It is the same one-endpoint-rather-than-two call `/api/watchlist` makes.
     *
     * It reads the SHELVES THAT DREW TODAY, so a shelf that came back empty is not on it --
     * which is honest rather than lossy: you cannot arrange a row that does not render, and
     * a preference that no longer names it degrades by the same rule as a retired one.
     *
     * Nobody signed in has arranged nothing. Not an error -- the shipped page is the true
     * answer, and it is what an anonymous caller is about to be served anyway.
     */
    GET: (req: Request) => json(preferencePayload(readerId(req))),

    /**
     * Save an arrangement: the shelves in the order you want them, each marked hidden or not.
     *
     * PUT rather than POST because the body IS the whole preference -- sending it twice
     * leaves the same page, and there is no partial edit to merge. Answers with the same
     * payload as the GET, so a client never has to guess how the server resolved what it
     * sent (a retired id is dropped, a shelf the reader never mentioned reappears).
     *
     * UNKNOWN SHELF IDS ARE ACCEPTED, deliberately, unlike the tconst check on
     * `POST /api/watchlist`. The genre shelves rotate with the nightly index build, so an id
     * that is real when the browser reads it can be gone by the time it saves -- refusing
     * here would turn a routine rotation into a failed save. They are ignored on the way out
     * instead, which is the rule the whole feature already follows.
     */
    PUT: async (req: Request) => {
      const me = readerId(req);
      if (!me) return bad("sign in to arrange your front page", 401);

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return bad("body must be JSON");
      }
      const parsed = parseShelfChoices(body);
      if ("error" in parsed) return bad(parsed.error);

      shelfPrefs.replace(me, parsed.choices);
      return json(preferencePayload(me));
    },

    /**
     * Put the front page back to the shipped default.
     *
     * The way out, and the reason the feature is safe to experiment with. Resetting something
     * you never arranged answers the default page rather than a 404: the state asked for is
     * already true, which is the same answer `DELETE /api/watchlist/:tconst` gives.
     */
    DELETE: (req: Request) => {
      const me = readerId(req);
      if (!me) return bad("sign in to arrange your front page", 401);
      shelfPrefs.clear(me);
      return json(preferencePayload(me));
    },
  },

  /**
   * The discovery shelves, decorated with local library and request state.
   *
   * `discoveryShelves()` owns which titles are on the front page; this handler only
   * turns index rows into cards. The warm loop reads the same function, which is what
   * makes "every shelf title is already warm" true by construction.
   *
   * WHAT PERSONALISATION COSTS HERE: one indexed read of `shelf_pref` for a signed-in
   * reader, zero for anybody else, and a reorder of an array that is already in memory. A
   * reader who has never arranged their page is handed `currentShelves()` unchanged --
   * `applyShelfPreference` returns the same shelves in the same order for an empty
   * preference, which `shelf-preferences.test.ts` pins.
   *
   * > [!IMPORTANT] NOT storable by the browser, and it used to be `private, max-age=600`
   * > A ten-minute window here outlives every reason the page is rebuilt: the arr tier
   * > refreshes every 60 seconds and `POST /api/requests` primes it immediately, so the
   * > browser could answer the asker's own refetch out of its cache with a body assembled
   * > before they clicked. The window was buying nothing either -- the client holds this
   * > page in memory for the session and persists it to IndexedDB for the next one (see
   * > `web/src/lib/api.ts`), so a repeat visit was already free, and a RELOAD is exactly
   * > the moment the reader is asking to be told again.
   * >
   * > It is also PER-READER now, which the missing store directive already covered: a
   * > shared cache must never hand one reader the page another arranged.
   * >
   * > What it costs to answer is the held page plus `decorate()`, measured at 2.2ms.
   */
  "/api/discover": (req: Request) =>
    json({
      shelves: applyShelfPreference(currentShelves(), preferenceOf(req), shelvesHiddenByDefault).map(
        ({ rows, ...shelf }) => ({ ...shelf, titles: decorate(rows) }),
      ),
    }),

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
     *
     * ## WHAT THIS COSTS, MEASURED
     *
     * `RootLayout` polls this every eight seconds for every open tab, twice over: as the
     * `?mine=1` list somebody is reading, and as the badge poll. `src/jobs/bench-requests.ts`
     * drives both against two live servers -- this tree and `58fe658`, the commit before
     * `5ae3f8e` added the poster, quota and per-season reads. studio (M-series, macOS arm64,
     * bun 1.4.0), 2026-09-06, 200 samples per cell, p50 of what a browser waits for:
     *
     * ```
     *   rows  shape   before   after    delta
     *      5  mine      0.13    0.22     0.09
     *     50  mine      0.25    1.30     1.05
     *    200  mine      0.64    4.70     4.06     <- the cap; the worst list this can serve
     *    200  badge     0.60    4.59     3.99
     * ```
     *
     * Depth is 40% series at 6 seasons of 12 episodes, so 200 rows is 5,760 mirrored episode
     * rows. **The route got about 7x dearer and it is still 4.6 ms**, which is 0.06% of the
     * eight-second interval -- the cost is real, was never measured before, and does not
     * warrant changing anything.
     *
     * The added work, dearest first, **each figure owned by the function it describes and
     * deliberately not restated here**: `seasonProgressLinker` (the episode read and the pass
     * over its result, together about two thirds of it), `posterPath` (the per-row artwork
     * lookup its callers feed it), `quotaStateFor` in `../lib/request-quota.ts` (the day's
     * count). They do not sum to the whole delta and the harness prints the remainder rather
     * than hiding it: the same statements cost more interleaved with building 200 response
     * rows than they do in a loop that does nothing else.
     */
    GET: (req: Request) => {
      const principal = auth.principal(req);
      const role = principal?.role ?? null;
      const reader = principal?.user ?? null;
      const me = reader?.id ?? null;
      const diagnostics = store.requestDiagnosticMap();
      /*
        `?mine=1` NARROWS THE SAME ROUTE, rather than adding a second one.

        The rows, the strip and the decoration are identical either way -- only WHICH rows
        differ -- so this is a filter on one endpoint rather than a fork of it. It also has
        to be a server-side filter and cannot be done in the client: `visibleRequest` strips
        `requested_by` for everybody but an admin, so an ordinary reader has nothing to
        filter on by the time the rows reach them.

        Anonymous (`me === null`) asking for `mine` gets an empty list, which is the true
        answer: nobody has asked for anything.
      */
      const mine = new URL(req.url).searchParams.get("mine") === "1";
      const rows = mine ? (me ? store.listRequestsFor(me) : []) : store.listRequests(undefined, 200);
      /*
        The name table is built ONCE per response, and only for an admin.

        `attributedRequest` takes a lookup rather than a name because the alternative is a
        store read per row, and the log is 200 rows. Building it behind the role check keeps
        an ordinary reader's request off the user table entirely -- there is nothing for them
        in it, and a query nobody can see the result of is a query worth not making.
      */
      const names =
        role === "admin" ? new Map(authStore.listUsers().map((u) => [u.id, u.displayName])) : null;
      /*
        WHO TOOK IT BACK OUT -- admin-only, on the same terms as `names` above and for the
        same reason. "Who removed what" is the same class of fact as "who requested what",
        which aannarr ruled stays with the admins, so an ordinary reader's JSON must not
        carry it at all rather than a component declining to draw it.

        One map for the whole page, like `requestDiagnosticMap`: this route serves up to 200
        rows and the shell polls it.
      */
      const removals = role === "admin" ? store.removalMap() : null;
      const playLink = plexLinker();
      const seasonsOf = seasonProgressLinker(rows);
      return json({
        /*
          The verdict and the bar ride along, in the same `RequestStateView` shape
          `decorate()` puts on a title -- so the component drawing a request row and the one
          drawing a card are the same component.

          Nothing from `request_diagnostic` is privileged: it is an observation of the arrs'
          own queues, not of who asked. `visibleRequest` still owns the fields that ARE
          privileged, and it is applied to the row before anything is added to it.
        */
        requests: rows.map((r) => ({
          ...attributedRequest(r, role, (id) => names?.get(id) ?? null),
          ...requestStateOf(r, diagnostics.get(r.tconst) ?? null),
          /*
            IS THIS NEWS TO THE PERSON READING IT?

            Derived here rather than sent as `available_seen_at`, because the raw stamp is
            about the ROW and this is about the READER: it is only ever true for your own
            request, and it is what the badge counts and what the list marks. Sending the
            column instead would leave every client re-deriving the same rule, and a
            second reader of one fact is a second chance to get it wrong.
          */
          isNew: r.status === "available" && r.available_seen_at === null && r.requested_by === me,
          /*
            WHERE TO WATCH THE THING YOU ASKED FOR, on the page you came to to find out.

            The same field a decorated title card carries, from the same mirror and the same
            resolver -- a request row that says "Available" and offers nothing to click is the
            dead end this product refuses everywhere else.

            NOT implied by the `imported` verdict: that is the arr saying it filed the file,
            while this is Plex saying it has scanned one. Only the second of those is a link
            that will play something, which is exactly why the mirror is separate from the
            library table. Null until Plex has seen it, whatever the verdict says.
          */
          plex: playLink(r.tconst),
          /*
            THE POSTER, so a list of requests is a list of THINGS rather than a list of rows.

            This route's own decoration and NOT `decorate()`: that function attaches library
            state, studio logos, award marks and a facet-ready shape to an index row, and a
            request row is not an index row -- it has no `kind`-derived vocabulary, no votes
            and no rank. What the two genuinely share is the poster rule, and that is
            `posterPath`, which they both call.
          */
          posterUrl: posterPath(r.tconst, store.getArtwork(r.tconst)),
          /*
            WHICH SEASON IS MOVING, for a series asked for by season.

            Empty for a film, and empty for a series Sonarr does not mirror yet -- see
            `seasonProgress`, which reports no row rather than a zero for a season with
            nothing aired. The bar above this row is the whole ask; this is the same ask
            broken down, and it is the one thing `request_diagnostic` cannot carry because it
            is keyed on `tconst` alone.

            Named apart from the row's own `seasons`, which is the comma-joined list of what
            was ASKED for. One is the question and one is the answer, and collapsing them into
            a single key would have silently overwritten the request's own selection.
          */
          seasonProgress: seasonsOf(r),
          /*
            WHO REMOVED THIS AND WHEN, on the row that says it was removed.

            Attached ONLY to a `removed` row, deliberately. The audit record is keyed on the
            title and survives a later re-request -- it is the record of a decision, not of a
            row -- so a re-requested title would otherwise carry a removal note above a
            "Requested" verdict and read as if it had just been deleted.

            The name is resolved the same way `attributedRequest` resolves a requester's, and
            through the same `names` table: an admin whose account has since been deleted
            shows as "(removed)" rather than as a dangling id.
          */
          removal:
            removals && r.status === "removed" ? removalView(removals.get(r.tconst), names) : undefined,
        })),
        queue: worker.stats(),
        /*
          The unread count, on the endpoint the header ALREADY polls.

          `RootLayout` reads this route every 8 seconds for the queue badge, so the ready
          badge costs no second timer and no second request -- one poll, both answers, and
          they can never disagree about a moment.
        */
        unseen: me ? store.countUnseenAvailable(me) : 0,
        /*
          WHERE THE READER STANDS AGAINST THE DAILY LIMIT -- "3 of 5 today, resets at 00:00 UTC".

          The setting existed and no screen had ever rendered it, so the only way to discover a
          quota was to hit it. It rides HERE and on no route of its own for the reason `unseen`
          above does: this is the endpoint `/requests` already polls, so the header cannot show
          a count and an allowance that describe two different moments.

          `null` for an anonymous caller, who has no standing rather than a standing of zero.
          The EFFECTIVE limit is resolved by `quotaStateFor` from this person's override and
          the site default -- a header printing the site's number at somebody who has been
          given their own would be confidently wrong, which is worse than printing none.
        */
        quota:
          reader && role
            ? quotaStateFor({
                role,
                override: reader.quotaPerDay,
                siteDefault: siteSettings.read().requestQuotaPerDay,
                usedToday: () => store.countRequestsSince(reader.id, utcDayStart()),
              })
            : null,
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
      // Read ONCE and reused for the override check, the quota and the attribution below.
      // `principal` touches the session row on every call, so asking it three times for one
      // POST is three writes and three chances for the three answers to disagree.
      const asker = auth.principal(req);

      const overrides = parseRequestOverrides(body);
      if ("error" in overrides) return bad(overrides.error);
      if (hasOverrides(overrides.overrides) && asker?.role !== "admin") {
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

      /*
        The daily quota, checked LAST -- immediately before the write it guards.

        Two things follow from where this sits. An invalid or impossible request never gets
        a quota-shaped error, so "you asked for a title that does not exist" is never
        reported as "you have asked for too many"; and a title that ALREADY has a live request
        row is exempt, because `createRequest` upserts onto it and this POST will not write a
        new one. The quota is spent by rows, so only a POST that creates one is charged --
        which is what lets somebody at their limit still change the season selection on a
        series they asked for this morning.

        `createsNewRequest` and not a null check of our own: a `removed` row is dropped and
        re-inserted by `createRequest`, so asking again for a title an admin took back out
        DOES write a new row and DOES cost a request. Two spellings of that rule would have
        made an admin's removal a permanent free request on that title for everybody.

        A `failed` or `no_release` row is the other way round -- FREE, because `createRequest`
        revives it in place rather than writing a row, and because "Try again" on `/requests`
        has always been free for exactly the same title. The reasoning is on
        `revivesHeldRequest`, which is where a decision to start charging for it would go.
      */
      if (createsNewRequest(store.getRequest(row.tconst))) {
        const refused = quotaRefusal(asker);
        if (refused) return refused;
      }

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
        // HOW it arrived, beside WHO asked and never instead of it. An agent key carries one
        // person's authority, so the person above is still the requester.
        viaAgentKey: asker?.kind === "agent",
        overrides: overrides.overrides,
      });
      worker.enqueue(row.tconst);
      // "Recently requested" reads the row that was just written, and it is the one arr-tier
      // shelf a PERSON can change, so the held page is rebuilt now rather than up to 60
      // seconds from now: whoever fetches `/api/discover` next sees the ask on the shelf
      // named after having asked, instead of a page assembled before it existed.
      //
      // That is what this buys and no more. It does NOT put the row in front of the asker's
      // own browser, which does not refetch `/api/discover` for the rest of the session --
      // see `the-front-page-never-refetches-within-a-session-so-no-server` on the board.
      primeShelves("arr");
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
      const refused = refuseUnlessSonarrHolds(tconst);
      if (refused) return refused;

      const known = store.getEpisode(tconst, season as number, episode as number);
      if (!known) return bad("Sonarr does not list that episode", 404);
      if (known.has_file === 1) return bad("you already have that episode", 409);

      worker.enqueueEpisodes(tconst, [known.arr_episode_id]);
      return json({ queued: { tconst, season, episode } }, { status: 202 });
    },
  },

  /**
   * Ask for the REST of one season -- or of SEVERAL seasons -- of a series Sonarr already
   * holds.
   *
   * The fourth grain, and the one the series pane's "Downloaded: ... Season 3 missing 4
   * episodes" line needs to be actionable: without it a reader who can SEE the hole has to
   * hover four rows and press four buttons, and the browser has to fire four POSTs to say
   * one thing.
   *
   * > [!IMPORTANT] `seasons: number[]` and `season: number` are ONE route, not two
   * > "Get me seasons 3-7" is the same operation as "get me season 3" with a longer list,
   * > and splitting it would give one rule -- which episodes of a season are owed -- two
   * > handlers to drift apart in. The scalar form is kept because the per-season button in
   * > the season header still sends it and there is no reason to make that button say a
   * > list of one. `parseSeasonsInput` validates the list, so the wire spelling has the
   * > same owner as the one `/api/requests` already uses for the ADD path.
   *
   * A season in the list with nothing outstanding is dropped rather than refused: ticking a
   * complete season next to two empty ones is a reader saying "these three", and the answer
   * is to fetch what is missing from them. The 409 fires only when the WHOLE selection is
   * already held, which is the case where the page is looking at a stale mirror.
   *
   * > [!IMPORTANT] THE SERVER PICKS THE EPISODES, and it picks the ones the summary counted
   * > The client sends a season, never a list of ids -- a client-supplied list is a claim
   * > this route would have to re-check against the mirror anyway, and the mirror is the
   * > authority on what aired and what we hold. `missingEpisodeIdsIn` is the same rule the
   * > browser drew the sentence with (`src/lib/episodes.ts`), so the count in the button and
   * > the episodes actually enqueued come from one owner.
   *
   * That rule INCLUDES the episodes Sonarr is already searching for, which is where this
   * differs from the per-row button above -- see `missingEpisodeIdsIn` for why.
   *
   * Like the per-episode grain it writes no `request` row, and every refusal is a fact about
   * our own mirror, so none of them costs a network call. No `request` row also means no
   * daily quota, by the rule stated on `/api/requests`: the quota is spent by ROWS, so only
   * a POST that creates one is charged. This route asks for more at once than the per-row
   * button does, but it asks for nothing a reader could not already get by pressing that
   * button once per row.
   */
  "/api/requests/season": {
    POST: async (req: Request) => {
      let body: { tconst?: string; season?: unknown; seasons?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return bad("body must be JSON");
      }
      const { tconst, season } = body;
      if (!tconst) return bad("tconst is required");

      // The scalar is folded into the list form immediately, so everything below this line
      // deals in one shape. Sending both is a client that has not decided what it means.
      if (season !== undefined && body.seasons !== undefined) {
        return bad("send either season or seasons, not both");
      }
      let wanted: number[];
      if (season !== undefined) {
        if (!Number.isInteger(season)) return bad("season must be an integer");
        wanted = [season as number];
      } else {
        const parsed = parseSeasonsInput(body.seasons);
        if ("error" in parsed) return bad(parsed.error);
        if (!parsed.seasons) return bad("seasons must name at least one season");
        wanted = parsed.seasons;
      }

      const refused = refuseUnlessSonarrHolds(tconst);
      if (refused) return refused;

      const states = episodeStateFor(tconst);
      const today = todayUtc();
      const episodes = missingEpisodeIdsIn(states, wanted, today);
      // Nothing to do is a refusal rather than an empty 202: the button that sent this was
      // drawn from a count, so an empty answer means the page is looking at a mirror that
      // has moved on, and saying so is more use than a silent success.
      if (episodes.length === 0) {
        return bad("nothing to fetch -- no aired episode of those seasons is missing", 409);
      }

      // One job for the whole selection. Enqueuing per season would breathe 400ms between
      // seasons for no reason and report five toasts for one decision.
      worker.enqueueEpisodes(tconst, episodes);
      const filled = seasonsWithMissing(states, wanted, today);
      return json(
        // `season` echoes the first season actually queued so a caller that sent the scalar
        // reads its own grain back; `seasons` is the whole answer.
        { queued: { tconst, season: filled[0], seasons: filled, episodes: episodes.length } },
        { status: 202 },
      );
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

  /**
   * "I have seen everything of mine that arrived."
   *
   * POST rather than GET for the same reason `retry` is: it writes, and a state-changing
   * GET rides a `SameSite=Lax` cookie on any cross-site navigation. The damage a forged
   * call could do here is small -- somebody else clears your badge -- but "small" is not a
   * reason to leave the door open on the one route whose whole job is to write.
   *
   * It takes no body and names no request. The caller is the session, and the set is
   * everything of theirs that is unread: the reader is looking at the list, so the list has
   * been seen. Letting a client name rows would be trusting a claim the server cannot check.
   */
  "/api/requests/seen": {
    POST: (req: Request) => {
      const me = readerId(req);
      // Nobody signed in owns nothing, so there is nothing to mark. Not an error: the
      // desired state -- "no unread arrivals for you" -- is already true.
      if (!me) return json({ seen: 0 });
      return json({ seen: store.markAvailableSeen(me) });
    },
  },

  /*
    ---------------------------------------------------------------------------
    Web push. Three routes: what to subscribe with, subscribe, unsubscribe.

    > [!IMPORTANT] On iOS this is reachable ONLY from an installed app
    > Safari serves the Push API to a web app the reader has added to their home screen,
    > over HTTPS, and to nothing else -- no configuration changes that. So "add to home
    > screen" is not a nicety here, it is the subscription ceremony, and the client says so
    > rather than offering a control that cannot work.
    ---------------------------------------------------------------------------
  */

  /**
   * The instance's VAPID public key, which is what a browser subscribes against.
   *
   * PUBLIC BY DESIGN -- it is an identity, not a secret: it lets a push service verify that
   * a message came from this server, and every subscriber has to be handed a copy. The
   * private half never leaves the process.
   *
   * It also reports whether push is switched on at all, so the client asks one question
   * instead of trying to subscribe and interpreting the failure.
   */
  "/api/push/key": async () =>
    json(
      { enabled: pushNotifier.enabled, publicKey: await pushNotifier.publicKey() },
      // The key is stable for the life of the database, but a client caching it across a
      // regeneration would subscribe against a key this server cannot sign with -- and the
      // failure is silent. An hour is short enough to heal that and long enough to matter.
      { cache: perSession(3600) },
    ),

  "/api/push/subscribe": {
    POST: async (req: Request) => {
      const me = readerId(req);
      // A subscription belongs to a PERSON, because what it delivers is news about their
      // own requests. There is nothing an anonymous caller could be told.
      if (!me) return bad("sign in to enable notifications", 401);
      if (!pushNotifier.enabled) return bad("notifications are switched off on this server", 503);

      let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return bad("body must be JSON");
      }

      /*
        All three are BOUNDED before anything is parsed or stored. They are somebody else's
        format -- a push service's URL and two base64url keys -- so the caps are generous
        and their only job is that no unbounded string reaches the database; the `https`
        check below is the one that decides whether the endpoint is acceptable.
      */
      const endpointG = boundedText(body.endpoint, LIMITS.url);
      const p256dhG = boundedText(body.keys?.p256dh, LIMITS.pushKey);
      const authG = boundedText(body.keys?.auth, LIMITS.pushKey);
      if (!endpointG.ok || !p256dhG.ok || !authG.ok) return bad("endpoint and both keys are required");
      const endpoint = endpointG.value;
      const p256dh = p256dhG.value;
      const authSecret = authG.value;
      /*
        THE ENDPOINT IS A URL THIS SERVER WILL LATER POST TO, so it is validated before it
        is stored rather than at send time. A row that only fails when a film arrives is a
        row nobody finds out about until the one moment it was supposed to work -- and
        `https` alone is what stops a subscription pointing this server at a plain-http
        address of somebody's choosing.
      */
      let parsed: URL;
      try {
        parsed = new URL(endpoint);
      } catch {
        return bad("endpoint is not a URL");
      }
      if (parsed.protocol !== "https:") return bad("endpoint must be https");

      authStore.putPushSubscription({
        endpoint,
        userId: me,
        p256dh,
        auth: authSecret,
        // Which device this is, for the account page. It is the same string the session
        // row already records, so this discloses nothing new about the reader -- and it is
        // guarded for the same reason that row's is: a header is user input, and this one
        // is DRAWN, in the list a reader uses to decide what to revoke.
        userAgent: boundedHeader(req.headers.get("user-agent"), LIMITS.userAgent),
      });
      /*
        Subscribing IS an answer, so it closes the offer here rather than relying on the
        client to post `/api/push/offer` afterwards. Not merely belt and braces: a reader who
        says yes on their phone must not be asked again on their laptop, where the local
        `subscribed` flag is false and would otherwise let the offer through.
      */
      authStore.markPushOffered(me);
      return json({ ok: true });
    },
  },

  "/api/push/unsubscribe": {
    POST: async (req: Request) => {
      const me = readerId(req);
      // Already true for an anonymous caller: they have no subscriptions to remove.
      if (!me) return json({ removed: false });

      let body: { endpoint?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return bad("body must be JSON");
      }
      if (typeof body.endpoint !== "string") return bad("endpoint is required");
      // Scoped to the caller in the STORE, not here: an endpoint URL is not a secret, and a
      // delete keyed on it alone would be a stranger's off switch for your notifications.
      return json({ removed: authStore.deletePushSubscription(me, body.endpoint) });
    },
  },

  /**
   * Turn notifications off on EVERY device this person has, including ones they are not
   * holding.
   *
   * > [!IMPORTANT] This is the only off switch that can reach a device you no longer own
   * > `/api/push/unsubscribe` needs the endpoint, and the endpoint lives in the browser that
   * > owns it -- so a phone that was sold, reset or simply left in a drawer can never
   * > unsubscribe itself. Its row sits in the table being delivered to until a send happens
   * > to come back 404 or 410, which for somebody who requests nothing is never. The person
   * > whose news it is has to be able to say "stop, everywhere", from whatever device they
   * > do have.
   *
   * It takes NO BODY, deliberately: there is nothing to name. The caller's session decides
   * whose devices these are, exactly as `listPushSubscriptions` does on the way out.
   *
   * The browser this was pressed from still holds a live `PushSubscription` afterwards, and
   * the CLIENT unsubscribes that one locally -- see `disablePushEverywhere`. Nothing here
   * can reach into the other browsers, and nothing pretends to: deleting the row is what
   * stops this server sending, which is the whole of what it controls.
   */
  "/api/push/unsubscribe-all": {
    POST: (req: Request) => {
      const me = readerId(req);
      if (!me) return json({ removed: 0 });
      return json({ removed: authStore.deletePushSubscriptionsFor(me) });
    },
  },

  /*
    HAVE WE ASKED THIS PERSON YET, and a way to say that we now have.

    > [!IMPORTANT] ONCE PER USER, NOT ONCE PER BROWSER -- aannarr, 2026-09-07
    > *"USER TO OPT IN ... not automatically be asked ... make sure we NEVER repeat, so once
    > only"*. The contextual offer on `/requests` is made exactly once to a person and then
    > never again on any device, whatever they answered. `PushToggle` on the account page is
    > how a decision gets changed afterwards, and it is always there.

    > [!CAUTION] This must NOT ride on `/api/push/key`, and the reason is that route's cache
    > `/api/push/key` is `perSession(3600)`, which is right for a VAPID key that changes
    > about never -- and fatal for a field the reader can flip. A dismissal would sit behind
    > an hour-old cached `false` and the offer would come back on the next page load, which
    > is the exact failure this whole field exists to prevent. A mutable per-user fact needs
    > its own uncached route; that is the whole reason there are two.
  */

  /**
   * The per-user push facts the VAPID key's response cannot carry: have we asked, and how
   * many devices are subscribed.
   *
   * `devices` is what makes "turn it off everywhere" an honest control rather than a button
   * whose effect nobody can see. It counts ROWS, which is the only thing this server can
   * know -- a browser that cleared its storage still has a row here until a send finds out
   * otherwise, and that row is exactly what the reader wants removed.
   */
  "/api/push/state": (req: Request) => {
    const me = readerId(req);
    const user = me ? authStore.getUser(me) : null;
    return json(
      {
        // No user is "already offered": there is nobody to make an offer to.
        offered: user ? user.pushOfferedAt !== null : true,
        devices: me ? authStore.listPushSubscriptions(me).length : 0,
      },
      { cache: NO_STORE },
    );
  },

  "/api/push/offer": {
    /**
     * They answered. Which way is deliberately not recorded here.
     *
     * Subscribing, declining the browser's prompt and dismissing the offer are three
     * different answers and produce one identical consequence -- do not ask again -- so
     * storing which would be a fact with no reader. The subscription table already knows
     * who said yes.
     */
    POST: (req: Request) => {
      const me = readerId(req);
      if (me) authStore.markPushOffered(me);
      return json({ ok: true }, { cache: NO_STORE });
    },
  },

  /**
   * Radarr and Sonarr, pushing what they already know.
   *
   * PUBLIC, and the one public route that changes state -- it is listed in
   * `AuthService.publicPaths()` and authenticated by its own basic-auth password instead.
   * The whole policy lives in `./arr-webhook.ts`; this is only the wiring.
   *
   * POST and PUT, because a Webhook connection's `method` field offers both and an operator
   * who picked the second would otherwise get a 404 from a route that is plainly there. GET
   * is deliberately absent: this writes, and a state-changing GET is one off-site link away
   * from being CSRF -- the same reason `/api/requests/:tconst/retry` below is POST-only.
   *
   * NOT exempt from the index gate, unlike `/api/health`. While a first install is building
   * there are no requests for an event to be about, and the poller catches up on anything
   * missed the moment there are -- so exempting it would mean carrying a path in two
   * allow-lists to reach a state in which it has nothing to do.
   */
  [ARR_WEBHOOK_PATH]: {
    POST: (req: Request) => arrWebhooks.handle(req),
    PUT: (req: Request) => arrWebhooks.handle(req),
  },

  /**
   * Withdraw a request: stop the arr searching for it, and forget we ever asked.
   *
   * **DELETE rather than `POST .../withdraw`, and the reason is the same one that made
   * `retry` POST-only.** A state-changing GET rides a `SameSite=Lax` cookie on any
   * cross-site navigation, and the two verbs a foreign page can reach without script are
   * exactly GET and POST -- a form posts, a link navigates, neither can issue a DELETE. So
   * the verb that names the operation is also the one a cross-site page cannot forge, and
   * declaring only `DELETE` here means nothing else is answered on this path.
   *
   * The whole rule -- who may, which statuses, and the unmonitor -- is
   * `./withdraw-request.ts`. This is the mount: a principal in, a status code out.
   *
   * > [!NOTE] `/api/requests/seen`, `/episode` and `/season` are NOT shadowed by this
   * > Measured against this Bun: a static path beats a parameter one, so their POSTs still
   * > reach them. A `DELETE /api/requests/seen` does land here with `tconst: "seen"`, which
   * > is a title nobody has requested and therefore an ordinary 404.
   */
  "/api/requests/:tconst": {
    DELETE: async (req: Bun.BunRequest<"/api/requests/:tconst">) => {
      const asker = auth.principal(req);
      const outcome = await withdrawRequest({ store, radarr, sonarr, log }, req.params.tconst, {
        userId: asker?.user?.id ?? null,
        role: asker?.role ?? null,
      });
      if (!outcome.ok) return bad(outcome.error, outcome.status);
      // The row is gone and "Recently requested" is built from those rows, so the held page
      // is rebuilt now rather than up to 60 seconds from now -- the same reason, and the
      // same call, as the POST above.
      primeShelves("arr");
      return json({ withdrawn: req.params.tconst, unmonitored: outcome.unmonitored });
    },
  },

  /**
   * Take the media back out: what would go (GET), and then take it (DELETE).
   *
   * ONE PATH FOR BOTH, because they are one operation seen twice -- the question and the
   * answer -- and they must agree about every refusal. `resolveTarget` in `./remove-media.ts`
   * is what makes them agree; two paths would have been two chances for a confirmation to
   * open on something the delete then declines.
   *
   * Under `/api/admin/` and therefore ADMIN-ONLY, which is the whole shape of this feature:
   * a reader browsing the library is never offered a delete button, an operator reviewing what
   * has landed is. The rule is `auth.requireAdmin` -- anonymous gets 401, a signed-in
   * non-admin gets the same 404 the rest of the admin surface gives, and an agent key is
   * refused by the `/api/admin/` prefix in `./agent-api.ts` before it reaches here.
   *
   * Declared HERE rather than in `./auth-routes.ts` for the reason `/api/admin/index/refresh`
   * is: the thing it drives -- the arr clients, the store, the shelves -- lives in this file,
   * and wiring them back through the identity module as callbacks would make it import the
   * arr vocabulary. The AUTHORISATION stays owned there.
   *
   * `deleteFiles` rides in the QUERY and not in a body, because a DELETE carrying a body is
   * the shape half the HTTP stack in the world drops. It is REQUIRED and has no default: it is
   * the difference between forgetting a title and deleting a household's file, and a default
   * would be this endpoint choosing for whoever forgot to say.
   */
  "/api/admin/requests/:tconst/media": {
    GET: async (req: Bun.BunRequest<"/api/admin/requests/:tconst/media">) => {
      const refused = auth.requireAdmin(req);
      if (refused) return refused;
      const outcome = await removalPreview(removalDeps(), req.params.tconst);
      return outcome.ok ? json({ preview: outcome.value }) : bad(outcome.error, outcome.status);
    },
    DELETE: async (req: Bun.BunRequest<"/api/admin/requests/:tconst/media">) => {
      const refused = auth.requireAdmin(req);
      if (refused) return refused;
      const deleteFiles = new URL(req.url).searchParams.get("deleteFiles");
      if (deleteFiles !== "true" && deleteFiles !== "false") {
        return bad("deleteFiles must be true or false");
      }
      const admin = auth.principal(req);
      const outcome = await removeMedia(
        removalDeps(),
        req.params.tconst,
        { deleteFiles: deleteFiles === "true" },
        { userId: admin?.user?.id ?? null },
      );
      if (!outcome.ok) return bad(outcome.error, outcome.status);
      // The library mirror and the request row both moved, and "Recently added" and "Recently
      // requested" are built from them -- so the held page is rebuilt now rather than up to 60
      // seconds from now, the same reason and the same call the request routes make.
      primeShelves("arr");
      return json({ removed: outcome.value });
    },
  },

  "/api/requests/:tconst/retry": {
    // POST only, which the client already sends. A bare function answers GET too, and a
    // state-changing GET rides a `SameSite=Lax` cookie on any cross-site navigation --
    // an off-site link that re-enqueues arr work is CSRF wearing a retry button.
    POST: (req: Bun.BunRequest<"/api/requests/:tconst/retry">) => {
      const r = store.getRequest(req.params.tconst);
      if (!r) return bad("unknown request", 404);
      // The same store method a fresh ask on a dead-end row goes through, so this button and
      // the Request button cannot drift about what a second attempt resets.
      store.requeueRequest(r.tconst);
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

  /**
   * The image an Open Graph card points at -- a POSTER for a `tt`, a HEADSHOT for an `nm`.
   * ANONYMOUS-REACHABLE, and the only image route that is.
   *
   * > [!CAUTION] This is `/img/t/:tconst` with the amplifier taken out, not a duplicate of it
   * > The two look alike and differ in the one way that matters. `/img/t` calls
   * > `artwork.serve()`, which resolves an unknown tconst through Radarr and Sonarr -- fine
   * > behind the login wall, catastrophic in front of it, where 1.27M ids are 1.27M
   * > lookups a stranger can name. This route serves what the cache ALREADY holds and 404s
   * > otherwise. The resolve happens, bounded, when the PAGE is rendered
   * > (`previewPage`), which is also the only place it can be rate limited as one act.
   *
   * **One route for two id spaces, and that is the point rather than a shortcut.** It is
   * the single edit that makes an image anonymous-reachable, so it is the single line in
   * `publicPaths()` -- a second route would be a second thing to remember to list, and the
   * failure of forgetting is a card whose image 401s, which no test of the page would
   * catch. Both halves obey the same rule: serve a cached URL or 404, never resolve one.
   *
   * **The size is `PREVIEW_IMAGE_SIZE`, never `DEFAULT_IMAGE_SIZE`** -- see that constant
   * for the measurement. The app's grid draws these 171px wide and keeps the smaller one.
   *
   * A 404 here is a normal outcome, not an error: the crawler already has the page, and a
   * card without a picture is the intended degraded form.
   */
  [`${PREVIEW_IMAGE_PATH}/:id`]: (req: Bun.BunRequest<`${typeof PREVIEW_IMAGE_PATH}/:id`>) => {
    const id = req.params.id;
    if (id.startsWith("nm")) {
      // A face is already in `facet_image` under a key the title route issued, so this
      // goes through the facet proxy rather than the artwork cache. `personImageKeys`
      // returns nothing for a person nobody has drawn yet, which is the ordinary 404.
      const key = faceKeyOf(id);
      if (!key) return new Response("no artwork", { status: 404 });
      return facetImages.serve(key, PREVIEW_IMAGE_SIZE);
    }
    const known = store.getArtwork(id);
    if (!known?.url) return new Response("no artwork", { status: 404 });
    return artwork.serveUrl(known.url, PREVIEW_IMAGE_SIZE);
  },

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

/**
 * Every route this server answers: the app's, plus identity's.
 *
 * A named const rather than a spread inlined into `Bun.serve`, because the agent manifest
 * DESCRIBES this table. "A route added later appears in the manifest by having been added"
 * is only true while there is exactly one table and one place that owns it.
 */
const allRoutes = {
  ...appRoutes,
  ...auth.routes(),
  ...addonConfigRoutes({
    registry: plugins,
    config: addonConfig,
    asAdmin: (req, fn) => auth.asAdmin(req, fn),
    log: pluginLog,
  }),
};

/**
 * The table, read at CALL time rather than closed over.
 *
 * `/api/agent/manifest` is itself in the table and has to read it, so its handler -- defined
 * above this line -- cannot name `allRoutes` directly: at module evaluation the binding does
 * not exist yet. By the time a request arrives it does, and a hoisted function is the
 * cheapest honest way to say "later".
 */
function liveRouteTable(): Record<string, unknown> {
  return allRoutes;
}

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

  // Five wrappers, and the ORDER is deliberate. The index gate is OUTSIDE the auth guard,
  // so a caller during a first build gets one 503 about the index rather than a 401 about
  // credentials for a server that has no data yet (see `withIndexGate`) -- and the TIMER is
  // outside everything, so what it records is the whole request as the client experienced
  // it, including a refusal. A 401 that takes two seconds is a fact worth having.
  //
  // The PAYLOAD GUARD sits directly inside the timer and outside everything else, because
  // it is the only check that costs nothing and needs to know nothing: a URL past
  // `LIMITS.url` is refused before the index gate opens a file, before the auth guard reads
  // a cookie and before any handler parses it. It is still INSIDE the timer, so a refusal
  // shows up in the timings like any other answer rather than vanishing from the record.
  //
  // The agent guard is INNERMOST, inside `withAuth`: it decides what a caller we have
  // already NAMED may do, so it must never be the thing that answers an anonymous request.
  // An unauthenticated call gets one 401 about credentials, never a 429 about a budget.
  routes: withTiming(
    withPayloadGuard(
      withIndexGate(
        withAuth(
          withAgentApi(allRoutes, {
            principal: (req) => auth.principal(req),
            limiter: (bucket) => auth.agentLimiter(bucket),
            log,
          }),
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
      ),
    ),
    {
      timings: requestTimings,
      slow: slowRequests,
      thresholdMs: cfg.slowRequestMs > 0 ? cfg.slowRequestMs : Number.POSITIVE_INFINITY,
      log,
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
          ...cacheHeaders(NO_STORE),
          "Retry-After": "10",
          ...HTML_HEADERS,
        },
      });
    }
    if (!webBuildPresent())
      return new Response("web build missing -- run 'bun run build'", {
        status: 503,
      });

    const principal = auth.principal(req);

    /*
      A SHARED LINK, followed by somebody with no session -- usually a crawler unfurling it.

      Signed in short-circuits before any of this and is served the app shell exactly as it
      was before previews existed: the reader is going to the real page, so building a card
      for them would be work nobody sees. That short-circuit is also what keeps this branch
      honestly cheap, because the expensive caller is the one we can identify.

      `previewPage` returns null for an unknown tconst or a rate-limited caller, and the
      fall-through is the ordinary sign-in shell -- never an error. A crawler shown a 429
      caches the 429.
    */
    const shell = principal ? "/index.html" : "/login.html";

    const shared = principal ? null : PREVIEW_PATH.exec(u.pathname);
    if (shared?.[1]) {
      return previewResponse(req, shared[1], previewDeps).then((res) => res ?? shellResponse(shell));
    }

    // A shared PERSON link, same rule and same fall-through. Synchronous, because unlike a
    // title it can never resolve an image and so never awaits anything.
    const sharedPerson = principal ? null : PREVIEW_PERSON_PATH.exec(u.pathname);
    if (sharedPerson?.[1]) {
      return personPreviewResponse(req, sharedPerson[1], personPreviewDeps) ?? shellResponse(shell);
    }

    // `/` serves a DIFFERENT document to a session than to a stranger, so it is answered
    // by the shell helper rather than resolved to a filename and handed to the static
    // branch below -- which keys its cache on the URL and would let one answer stand for
    // both. Everything else is a path, and a path is the same file for everybody.
    if (u.pathname === "/") return shellResponse(shell);

    const rel = u.pathname;
    // Reject traversal before touching the filesystem.
    if (rel.includes("..")) return new Response("bad path", { status: 400 });

    const file = Bun.file(`${staticDir}${rel}`);
    return file.exists().then((ok) => {
      if (ok) {
        const hashed = /\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpg|svg)$/.test(rel);
        const html = rel.endsWith(".html");
        return new Response(file, {
          headers: {
            ...cacheHeaders(hashed ? IMMUTABLE_PUBLIC : REVALIDATED),
            "X-Content-Type-Options": "nosniff",
            ...(html ? HTML_HEADERS : {}),
          },
        });
      }
      // SPA fallback -- client-side routes are not files. Which shell depends on who is
      // asking, so a deep link followed while signed out lands on the sign-in page rather
      // than on an app that immediately 401s every call it makes.
      return shellResponse(shell);
    });
  },

  error(err) {
    console.error("[finderr] unhandled:", err);
    return json({ error: "internal error" }, { status: 500 });
  },
});

log(`listening on http://${cfg.host}:${server.port}`);

// --- build, then adopt: one owner ------------------------------------------
//
// The daily refresh and the boot-time stale check both go through this. It serialises them
// -- a container restarted a minute before the cron fires would otherwise run two builds
// against one `titles.new.db` -- and it is the path an operator should reach for instead of
// running the job by hand, because a hand-run build promotes the file this process holds
// open and leaves it serving errors until somebody restarts it. See `./index-refresh.ts`.
const refresher = new IndexRefresher({
  cfg,
  live,
  log: (m) => log(m),
  script: `${import.meta.dir}/../jobs/build-index.ts`,
  // Shelf membership moves with the index -- new titles clear the vote floor, others drop
  // below it -- so the front page after a swap is not the one that was warmed. Paced, in
  // the background, and never awaited on a timer.
  onSwapped: () => {
    // Before the warm, and synchronously: the warm reads the front page, so priming second
    // would warm the OLD membership and then immediately replace it.
    primeShelves("index");
    void warmShelves().catch((err) => log(`post-reload warm failed -- ${(err as Error).message}`));
  },
});

// --- adopt the boot-time build ---------------------------------------------
//
// Wired here rather than beside the spawn because it wants `warmShelves`, and because this
// reads in the order it happens: the server is already listening by the time any of it runs.
//
// NOT routed through `refresher`: that owns build-AND-adopt, and this build was already
// started before the port opened so that the progress page could report on it. Only the
// adoption half is left, and it is `open()` rather than `reload()` because there is no
// outgoing engine.
if (indexBuild) {
  void indexBuild.exited.then((code) => {
    // The build gates on volume and on the 42-case canary before `promote()`, so a non-zero
    // exit means nothing was promoted and there is still no file to open. The state stays
    // `failed` and the progress page says so; retrying a 235 MB download unasked is not
    // this process's call to make.
    if (code !== 0) return;

    const res = live.open();
    if (!res.ok) return;

    /*
      EVERYTHING THAT NEEDS AN INDEX WAS SKIPPED WHILE THERE WAS NONE, so this is where it
      runs -- not just the warm.

      The mirrors filter what they store through `indexHasRow`, which answers `false` for
      every title while the index is being built. So on a first install the arr calendars
      and the TMDB upcoming lists both ran against an index that could not confirm a single
      row, and stored nothing. Their own timers are six-hourly and daily, which would have
      left a brand new install with empty shelves for most of a day for no reason other
      than the order two timers happened to fire in.

      Sequential and never awaited: each is paced, and the warm wants the rows the two
      syncs above it produce.
    */
    // The index tier is buildable the moment `open()` succeeds; the other two prime
    // themselves at the end of the two syncs below.
    primeShelves("index");

    void (async () => {
      await refreshLibrary();
      await refreshTmdbLists();
      await warmShelves();
    })().catch((err) => log(`post-build warm failed -- ${(err as Error).message}`));
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
  Bun.cron(cfg.index.refreshCron, () => void refresher.run("scheduled"), { tz: cfg.index.refreshTz });
  log(`index refresh scheduled: ${cfg.index.refreshCron} (${cfg.index.refreshTz})`);
} catch (err) {
  log(`could not schedule refresh (${(err as Error).message}) -- run build-index.ts from cron instead`);
}

// --- the upgrade path ------------------------------------------------------
/*
  A NEW RELEASE THAT NEEDS A NEW INDEX STAGE REBUILDS ITSELF, WITHOUT A MAINTENANCE PAGE.

  This is the half `refreshOnBoot` never covered. That flag answers "there is NO index";
  this answers "there is an index and it predates something this build knows how to
  produce" -- which is what every `docker compose pull && up -d` onto a release that added
  a stage looks like. Measured on the live deployment when the id crosswalk shipped: the
  container came up, `hasIds` was false, and it stayed false while every render went on
  buying the calls the crosswalk existed to remove.

  DELIBERATELY NOT A MAINTENANCE PAGE, and that is the whole design. There IS an index
  here, and it answers every query correctly -- it merely lacks one optimisation. So the
  old index keeps serving at full speed for the several minutes the build takes, and the
  live swap adopts the new one when it passes its gates. Showing a progress page instead
  would turn a zero-downtime upgrade into an outage in order to report on itself. The
  progress page is correct only where it already fires: when there is nothing to serve.

  Deferred rather than awaited, so a rebuild never delays the port opening.
*/
if (live.ready) {
  const reason = staleIndexReason(cfg);
  if (reason) {
    log(`${reason} -- rebuilding in the background. The current index keeps serving until it is ready.`);
    setTimeout(() => void refresher.run("stale index at boot"), cfg.index.staleRebuildDelayMs);
  }
}

/*
  The ORDINARY boot: an index was already on disk, so no swap and no post-build hook will
  ever fire and the index tier would otherwise never be built -- leaving `frontPage.ready`
  false forever and every request quietly falling back to computing the page. Which is
  correct, and completely invisible, which is what makes it worth a line here.

  The other two tiers prime themselves: `refreshLibrary()` ran at boot and `refreshTmdbLists()`
  fires 8 seconds in.
*/
if (cfg.shelves.keepFresh) {
  primeShelves("index");
  log(`shelves: held in memory, rebuilt per tier (index/tmdb/arr) -- FINDERR_KEEP_SHELVES_FRESH is on`);
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
