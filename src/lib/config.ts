/**
 * Configuration.
 *
 * Precedence, highest first:
 *   1. Environment variables (FINDERR_*)   <- the Docker-native surface
 *   2. YAML at $FINDERR_CONFIG_FILE        <- optional, for humans editing by hand
 *   3. Built-in defaults
 *
 * ENV always wins so a compose file can override a baked-in config without a rebuild.
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Any servarr: a base URL and an API key.
 *
 * Radarr, Sonarr and Prowlarr are configured identically at this level and differ only in
 * what they can be ASKED -- which is why the client hierarchy splits the same way (see
 * `ServarrHttp` in `./arr.ts`). Keeping the shared half named means a fourth service is a
 * type alias rather than a fourth copy of these three fields.
 */
export interface ServarrService {
  url: string;
  apiKey: string;
  /**
   * The address an ADMIN'S BROWSER should use to reach this arr, if it differs from `url`.
   *
   * `url` is how the SERVER reaches it, which is routinely a private address on the same
   * network as the container. finderr itself is internet-facing, so handing that string to
   * a browser is both unreachable from outside and a description of the network behind us
   * -- the rule stated in `decorate()` (`src/server/index.ts`). This is the one deliberate
   * exception, and it is an exception because the operator has to WRITE IT DOWN: nothing is
   * derived, nothing is guessed, and leaving it unset means the admin link is simply the
   * server's own `url`, which is correct for a LAN-only instance and wrong for a public one.
   *
   * Only ever sent to an admin -- see `arrLink()` in `src/lib/arr-links.ts`.
   */
  publicUrl?: string;
}

/** A servarr that holds a library: the two finderr adds titles to. */
export interface ArrService extends ServarrService {
  /** Radarr: root folder for movies. Sonarr: root folder for series. */
  rootFolder?: string;
  qualityProfileId?: number;
}

export interface Config {
  port: number;
  host: string;
  /** Everything mutable lives here: index DB, poster cache, dump downloads. */
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";

  index: {
    /** Titles below this vote count stay searchable via FTS but leave the fuzzy pool. */
    fuzzyMinVotes: number;
    /**
     * The Bayesian prior's strength, in votes, for the computed `rank` column.
     *
     * A title with exactly this many votes is ranked half on its own rating and half on
     * the corpus mean. Below it the mean dominates, which is what stops a 10.0 from six
     * voters outranking Shawshank -- and it is why a rank-sorted list needs no vote floor
     * at all (see `browseVoteFloor`). Raise it to demand more evidence before a title can
     * climb; lower it to let smaller titles move.
     *
     * The prior MEAN is not configurable and must not become so: it is measured from the
     * corpus at build time, because a literal stops describing the data the first time
     * IMDb's ratings drift. Both values are written to `meta` so a list can say how it
     * was ranked.
     */
    rankPriorVotes: number;
    /** IMDb title types to ingest. */
    titleTypes: string[];
    includeAdult: boolean;
    /**
     * Cast and crew are only indexed for titles clearing this vote count.
     *
     * `title.principals` is 101,571,406 rows -- 80x the whole title index -- and the
     * floor is what makes a reverse index affordable at all: at 1000 it keeps 1,169,846
     * rows across 353,242 people over the 65,105 titles that clear it (measured
     * 2026-09-03), which merely doubles the product rather than multiplying it. Set to 0
     * to index everybody, and expect a build measured in tens of minutes rather than
     * seconds.
     *
     * This line read "1,414,391 rows across 297,233 people, measured 2026-08-31" until
     * 2026-09-03, and that was wrong on its own date: the index the NAS built that day
     * holds 1,169,456 / 353,127 under this exact recipe. A fresh scan and a three-day-old
     * production index agree to within 0.03%, so the earlier pair was mis-recorded rather
     * than describing a corpus that has since shrunk.
     *
     * It matches `browseVoteFloor`'s default deliberately: one threshold across the
     * product is one fewer number that has to stay meaningful.
     */
    castMinVotes: number;
    /**
     * Which `title.principals.category` values earn a row.
     *
     * The list is what decides whether a name on screen is a LINK, because
     * `nconstsByNameForTitle` can only resolve a person we hold a credit for. It started
     * as the four a filmography is obviously for and that made the crew pane half-linked:
     * a director navigated, the producer, composer and cinematographer standing beside
     * him on the same line did not, which reads as breakage rather than as the dead-end
     * rule doing its job.
     *
     * So: the dump's thirteen, minus `self`, `archive_footage` and `archive_sound`. Those
     * three are the only ones that are not a job somebody is credited FOR -- they are an
     * appearance, and none of them can ever show up in a crew list needing a link.
     */
    castCategories: string[];
    /**
     * How often the cast stage actually RE-SCANS `title.principals`, in days.
     *
     * The scan is about 60% of a refresh build on the NAS, and almost all of that is
     * streaming and parsing the dump rather than inserting -- so an incremental build
     * saves nothing, and NOT reading the dump is the only thing that helps. The numbers
     * are in the BUILD COST block of `./index-builder.ts`, which owns them.
     *
     * Which is fine, because cast for a released title cannot change. A nightly pass
     * would only ever discover credits for titles that just crossed the vote floor. In
     * between, the tables are carried forward from the previous index in seconds.
     *
     * **7, and that is a measured floor rather than a round number.** 3,958 titles sit in
     * the 900-1000 vote band against 65,105 already clearing the floor (measured
     * 2026-09-03) -- so the entire population that could cross without gaining more than
     * 100 votes is 6.1% of the eligible set, and it is dominated by decades-old titles
     * that gain a handful of votes a year. The worst case a week-long window can produce
     * is therefore a marginal title missing its cast for a few days, self-healing at the
     * next refresh. Move it on two consecutive builds' worth of crossings, never on a
     * guess.
     *
     * 0 means "every build", which is what a machine fast enough not to care should use.
     */
    castRefreshDays: number;
    /**
     * Episodes are indexed for series clearing this vote count -- **the SERIES, never the
     * episode**, and that distinction is the whole design of the stage.
     *
     * An episode-level floor would delete exactly the episodes a reader asks about first.
     * IMDb ratings accumulate over weeks, so the episode that aired on Tuesday has almost
     * no votes on Wednesday and would be censored on the one day anybody wants it; the
     * series it belongs to has had years to earn its own. Floored on the parent, a show
     * anybody has heard of carries its complete run from the day each episode airs.
     *
     * **THIS COMMENT IS THE ONE OWNER OF THE EPISODE CENSUS**, the same way `castMinVotes`
     * above owns the cast one -- the `episode` table's comment and `episodeStage` in
     * `./index-builder.ts` cite it and state no figure of their own. What this does NOT own
     * is what the stage COSTS to build, or what a different floor would save: both of those
     * are build cost and live in the BUILD COST block of `./index-builder.ts`.
     *
     * Measured against the 2026-09-04 dumps:
     *
     * | | |
     * |---|---|
     * | rows in `title.episode` | 9,866,824 |
     * | under a series clearing 1,000 votes | 1,265,492 |
     * | of those, with no season or episode number | 137,808 (dropped -- see `episodeStage`) |
     * | of those, whose series the adult filter kept out of `title` | 4 (pruned) |
     * | kept | 1,127,680 |
     * | of the kept, carrying a ratings row of their own | 517,002 (45.8%) |
     *
     * That last line is why `episode.rating` is nullable rather than defaulted: the common
     * case is an episode nobody has rated.
     *
     * > [!IMPORTANT] THE DEFAULT IS 0 -- EVERY EPISODE OF EVERY SERIES -- AND THE FLOOR THAT
     * > SHIPPED HERE FIRST WAS THE WRONG TRADE
     * > It was 1000, matching `castMinVotes` and `browseVoteFloor` on the reasoning that one
     * > threshold across the product is one fewer number to keep meaningful. That symmetry is
     * > real but it was answering the wrong question, because those two floors and this one
     * > exist for DIFFERENT reasons: `browseVoteFloor` keeps an unfiltered grid INTERESTING
     * > and is a product judgement, while this one only ever bounded SCAN COST.
     * >
     * > aannarr's standing rule of 2026-09-04 closes that argument: *"I will rather give up
     * > BUILD TIME/INDEX TIME, for faster/more efficient/less ram usage RUN TIME."* Build
     * > cost is the cheap axis, so a floor whose only justification was build cost has no
     * > justification left.
     * >
     * > What it buys is that **"that series has no episode data" stops being an answer**. At
     * > 1000 the index covered 12,797 series out of 240,909 -- about one in nineteen -- so
     * > every question about a smaller show got a shrug from a product whose stated goal is
     * > that every aspect of the system is indexed and navigable.
     * >
     * > **Query speed does not change.** Both episode reads are covering-index lookups keyed
     * > on `parent` (see `ix_ep_parent` / `ix_ep_rating` in `./index-builder.ts`), so they
     * > are O(log n) in the table's size and touch the same handful of pages either way. The
     * > cost is paid in build seconds and file bytes, which is exactly what the rule trades.
     *
     * Raising it is still supported and is a PRODUCT decision -- what each step costs in
     * coverage is measured in the `BUILD COST` block of `./index-builder.ts`, which owns
     * those figures. Do not restate them here.
     */
    episodeSeriesMinVotes: number;
    /** When the daily refresh runs, read in `refreshTz`. */
    refreshCron: string;
    /**
     * IANA zone the refresh cron is interpreted in. Defaults to UTC.
     *
     * Passed to `Bun.cron` EXPLICITLY, because its own default is the system zone --
     * so without this a `TZ` on the container would silently move the refresh. UTC is
     * the right default here regardless: the IMDb dumps publish on a UTC schedule, so
     * the job should not drift with the operator's location or with DST.
     */
    refreshTz: string;
    refreshOnBoot: boolean;
    /**
     * How long to wait before rebuilding an index that is missing a stage this build knows.
     *
     * Not zero, and the delay is the point. A container that comes up needing a rebuild is
     * also mirroring Radarr, mirroring Sonarr, walking Plex and warming shelves; starting a
     * six-minute index build into that has the new release's first impression be its
     * slowest minute. The rebuild is never urgent -- the index it replaces answers every
     * query correctly and merely lacks an optimisation -- so it waits for boot to finish.
     *
     * Set to 0 in a test to make the check synchronous-ish. There is no ENV mapping: this
     * is a tuning constant with no operator decision behind it, and the moment it has one
     * it earns a `FINDERR_` name.
     */
    staleRebuildDelayMs: number;

    /*
      THE FOUR READ-SIDE OVERRIDES. All `null` by default, and that is the design.

      Every one of these is DERIVED at boot by `./memory-budget.ts` from the container's real
      memory ceiling and the index's real size -- so the shipped configuration is "measure it",
      not a constant somebody has to keep true. They exist for the case the derivation cannot
      see: a host that caps memory outside a cgroup, an operator who knows the box is shared,
      or somebody reproducing a benchmark cell.

      Setting one is a claim that you know better than the measurement, so each is echoed in
      the boot log beside the value it replaced, and an incoherent one is refused loudly rather
      than silently clamped. `null` means "derive it" everywhere; there is no sentinel number.
    */

    /**
     * Pretend the memory ceiling is this many MB, instead of reading the cgroup.
     *
     * `FINDERR_MEMORY_BUDGET_MB`. The one case this is genuinely for: a deployment whose real
     * ceiling is not a cgroup limit -- a VM sized for several services, a box where something
     * else is expected to want most of the RAM. Left unset the budget comes from
     * `/sys/fs/cgroup`, and falls back to host RAM only when there is no limit to read.
     */
    memoryBudgetMb: number | null;
    /** `pragma mmap_size`, in MB. `FINDERR_SQLITE_MMAP_MB`. 0 disables mmap, which measured
     * 2.6x SLOWER cold on a spinning array and 33% slower warm on NVMe -- so it is available
     * and it is not advice. */
    sqliteMmapMb: number | null;
    /** `pragma cache_size`, in MB. `FINDERR_SQLITE_CACHE_MB`. */
    sqliteCacheMb: number | null;
    /**
     * Force the boot-time page-cache prefault on or off. `FINDERR_INDEX_PREFAULT`.
     *
     * The derived answer is ON, always, and the ladder in `TUNING.md` is why: prefaulting an
     * index that does not fit the budget still fills the budget, and never measured worse than
     * not prefaulting on any rung. Turn it off only to make a container's first seconds cheaper
     * in I/O at the cost of its first queries -- for instance on a machine building an index
     * while serving nothing.
     */
    prefault: boolean | null;
  };

  radarr?: ArrService;
  sonarr?: ArrService;

  /**
   * Prowlarr, read-only and OPTIONAL. Unset means request diagnostics say less.
   *
   * finderr never asks Prowlarr to search -- it reads `/api/v1/history` to find out
   * whether the searches Radarr and Sonarr already ran came back with anything. Without
   * it a request that has found nothing can only be reported as still looking, which is
   * a narrower answer rather than a wrong one. See `src/lib/request-diagnostics.ts`.
   */
  prowlarr?: ServarrService;

  /**
   * Which countries this instance is FOR, most important first.
   *
   * A UNION and never an intersection: a title released in any listed region is upcoming
   * here. TMDB's discover endpoint scopes release dates by one country per call, so the
   * upcoming sync asks once per region and merges, and a title both regions return is
   * one row rather than two.
   *
   * A list from the start even though the default is a single country, so adding a second
   * one is an env edit rather than a type change. Measured 2026-08-31: US and SE together
   * returned 41 distinct upcoming films and differed by two of them, so the second region
   * earns far more on "Where to watch" than it does here.
   */
  regions: string[];

  tmdb: {
    apiKey?: string;
    imageBase: string;
    /** Poster cache lives under dataDir/images. */
    cacheImages: boolean;
    /**
     * Ceiling for the on-disk poster cache. Least-recently-written files are
     * evicted above this, except pinned discovery-shelf artwork. A w342 poster is
     * ~30 KB, so the default holds tens of thousands.
     */
    cacheMaxBytes: number;
    /**
     * Trim the `watchProviders` facet to these countries. UNSET KEEPS EVERY COUNTRY.
     *
     * A well-distributed film carries ~112 of them at roughly 25 KB, and a reader ever
     * sees exactly one: `pickWatchProviders` chooses in the BROWSER, because one cached
     * answer serves every reader. So all but one country is dead weight in the cache --
     * but only an operator knows which countries their readers are actually in.
     *
     * DELIBERATELY NOT `regions`, and that is the whole reason this key exists. `regions`
     * answers a different question ("which countries is this instance FOR", for the
     * upcoming sync) and DEFAULTS TO `["US"]`, so reusing it would have trimmed every
     * existing deployment to US-only availability without anybody asking for it -- and a
     * reader outside those countries would silently lose the "Where to watch" pane
     * entirely, since `pickWatchProviders` has no fallback to "whatever country we do
     * have". Unset here means today's behaviour exactly, which is what makes this safe to
     * ship to a running instance.
     *
     * Trimming is not free either way: the cached rows are a faithful copy of one upstream
     * document, so narrowing this and then wanting a country back costs a call per title.
     */
    watchProviderRegions?: string[];
  };

  plex: {
    enabled: boolean;
    /** Shown on the Plex auth screen. */
    productName: string;
    /**
     * Only accounts with access to this server may sign in. Empty = any Plex account.
     *
     * AUTH ONLY. The deeplink does NOT read this -- `syncPlex` asks the server for its own
     * `/identity` and parks the answer in `kv`, because a hand-copied identifier is a fact
     * that can silently be wrong, and a wrong one produces a link that opens Plex's home
     * screen rather than failing.
     */
    machineIdentifier?: string;
    /**
     * The server itself, e.g. `http://plex:32400`. Unset means no Plex mirror and
     * therefore no play links -- everything else works exactly as before.
     */
    url?: string;
    /**
     * `X-Plex-Token` for a read-only walk of the libraries.
     *
     * Sent as a HEADER, never a query parameter, for the reason the TMDB key taught us: an
     * error that quotes a URL then quotes the credential. Find it in `.env`; it is never
     * written into a tracked file.
     */
    token?: string;
  };

  auth: {
    /**
     * The WebAuthn relying-party id. THE BARE DOMAIN -- no scheme, no port.
     *
     * > [!CAUTION] RP_ID IS PERMANENT
     * > Change it and every credential ever registered stops verifying, for everyone, with
     * > no migration path short of re-inviting every user. It is the credential's identity,
     * > so unlike `origins` it may not be a list. A bare apex covers its subdomains; a
     * > subdomain does not cover its parent.
     *
     * The default is `localhost`, because a checkout of this repo is somebody else's
     * deployment. Set it to the name finderr will actually live at BEFORE the first passkey
     * is registered -- see the caution above for why it cannot be changed afterwards.
     */
    rpId: string;
    /** What the OS prompt shows when a passkey is created or used. */
    rpName: string;
    /**
     * Every origin allowed to complete a ceremony, comma-separated in ENV.
     *
     * A LIST, unlike `rpId`: staging and production can share credentials.
     *
     * > [!IMPORTANT] A passkey cannot be registered or used over plain http
     * > WebAuthn requires a secure context. A plain-http LAN address -- where finderr
     * > typically runs -- is not one, and no configuration changes that; the BROWSER
     * > refuses. Only `http://localhost` is exempt, which is why the DEFAULT is localhost
     * > alone: it is the one origin on which a passkey can be registered out of the box.
     * > Add your LAN origin in `.env` for the Plex login path, which is plain HTTP and
     * > works fine.
     * >
     * > For dev against a production-shaped rpId, `FINDERR_AUTH_RP_ID=localhost` plus a
     * > localhost origin is the only combination a browser accepts, and credentials made
     * > that way are useless in production. Expect two separate accounts, as with every
     * > WebAuthn project.
     */
    origins: string[];
    /** How long a session cookie lives. 30 days: a household tool, not a bank. */
    sessionDays: number;
    /** How long a minted invite stays redeemable. */
    inviteHours: number;
    /**
     * Whether the session cookie carries `Secure`.
     *
     * Empty means DERIVE it: on if every configured origin is https, off otherwise. The
     * derivation exists because a hard-coded `true` makes the app unusable over the LAN --
     * a browser silently discards a `Secure` cookie sent over http, so the user logs in,
     * gets a cookie, and is anonymous again on the next request with nothing to see in any
     * error message. Set it explicitly only to force the issue behind a TLS-terminating
     * proxy that we cannot see from here.
     */
    cookieSecure?: boolean;
    /**
     * The system API key: how an AGENT does administration without being a person.
     *
     * It grants everything an admin session grants -- mint an invite, list users, revoke a
     * credential, reset an account -- and it is checked with a constant-time compare
     * because it is a bearer token an attacker can retry. Unset means the admin API is
     * reachable only by an admin's own session, which is a legitimate way to run.
     *
     * It travels in the `Authorization: Bearer` header, never a query parameter: the TMDB
     * `?api_key=` lesson is that a credential in a URL ends up in a log line.
     */
    adminApiKey?: string;
    /**
     * Whether to believe `X-Forwarded-For` when identifying a caller for rate limiting.
     *
     * > [!CAUTION] Wrong in EITHER direction, and both failures are silent
     * > OFF behind a reverse proxy: every request carries the proxy's address, so the whole
     * > internet shares ONE rate-limit bucket. The limiter still fires -- it just cannot
     * > tell an attacker from everybody else, so the first abuser locks out every user.
     * >
     * > ON without a proxy: the header is client-controlled, so an attacker writes a fresh
     * > value per request and has an unlimited supply of identities. That is strictly worse
     * > than no limiter, because it looks like one.
     *
     * Default OFF, which is right for a direct LAN bind. Turn it on in the deployment that
     * puts Caddy or CloudFlare in front -- `clientKey` then trusts the LAST hop, because
     * everything left of it was written by whoever was upstream, including the client.
     *
     * The port is still published directly on the LAN in the shipped compose, so anyone on
     * the LAN can reach finderr without traversing the proxy and forge this header. That is
     * accepted: the header only chooses a rate-limit bucket, never a principal.
     */
    trustProxy: boolean;
    /**
     * Requests per minute per IP on the auth routes.
     *
     * The thing being defended is the invite token: 32 random bytes are not guessable, but
     * a limiter is what makes that a mathematical statement rather than a hope. It also
     * caps the login ceremony, which is CPU work an anonymous caller can otherwise ask for
     * without limit.
     */
    authRatePerMinute: number;
    /** Requests per minute per IP on /api/search, which is genuinely CPU-bound. */
    searchRatePerMinute: number;
    /**
     * Calls per minute per AGENT KEY on everything that costs a local SQLite seek.
     *
     * > [!IMPORTANT] Per KEY, and IN ADDITION to the per-IP limits rather than instead of them
     * > An agent on a shared address still consumes the address's bucket; this one exists
     * > because a key is a thing we can name, and an unattended client that decides to poll
     * > every second is the ordinary failure rather than the malicious one.
     *
     * Generous on purpose. The render path touches nothing but local SQLite and local disk
     * (the governing rule in `src/server/index.ts`), so this bucket is defending against a
     * runaway loop, not against expense.
     */
    agentCheapRatePerMinute: number;
    /**
     * Calls per minute per AGENT KEY on the three operations that cost more than a seek.
     *
     * `/api/search` is real CPU over a 1.27M-row index -- the same reason
     * `searchRatePerMinute` exists. `GET /api/title/:tconst` BLOCKS on providers for an
     * agent caller and holds a server connection for its whole deadline, so this number is
     * also the cap on how many of those one key can have in flight. `POST /api/requests`
     * starts a real download.
     */
    agentExpensiveRatePerMinute: number;
    /**
     * `FINDERR_NO_AUTH=1` -- run with no login wall at all. Off by default.
     *
     * > [!CAUTION] THIS REMOVES AUTHENTICATION ENTIRELY. Anyone who can reach the port is an admin.
     * > There is deliberately NO guard rail on it -- no forced loopback bind, no refusal to
     * > start, no production sniffing. aannarr's call, 2026-09-01, and the reasoning is worth
     * > keeping: Sonarr and Radarr both ship an unauthenticated local-access mode for exactly
     * > this shape of deployment, a household tool with one user behind their own front door,
     * > and finderr being unable to do the same would be a missing feature rather than a
     * > safety property. **So the decision is the operator's and the mechanism does not
     * > second-guess it.**
     * >
     * > What that costs, stated plainly because nothing in the code will stop you: this
     * > process holds the Radarr, Sonarr and full-account Plex credentials in its
     * > environment, and it can start real downloads. Setting this on a host that is
     * > reachable from the internet -- or from a LAN you do not control -- hands all of that
     * > to whoever finds the port. It is announced at boot, in `/api/health` and in a banner
     * > across the top of every page, and those three are the entire defence.
     *
     * **ONE FLAG AND ONE CONSTANT, and no name-override env.** aannarr's shape, and it
     * replaced a `FINDERR_DEV_LOGIN_AS` that took a display NAME -- which was never asked
     * for and is gone. A flag you have to feed a value to is a flag you have to look up:
     * the whole point of this is that a dev server comes up working at short notice, and
     * "which name did we use last time" is exactly the friction it exists to remove.
     *
     * The account is still REAL rather than a synthetic anonymous principal, because that
     * is what keeps the mode honest: `requested_by` would be null here and populated in
     * production, so `visibleRequest` stripping, the admin request log and every role-gated
     * surface would never render while somebody worked. It is found or created under
     * `NO_AUTH_USER` (`the_user`), so every path downstream of `principal()` sees an
     * ordinary admin and no code carries a branch for this mode.
     */
    noAuth: boolean;
  };

  /**
   * The callback Radarr and Sonarr push request state changes to.
   *
   * > [!CAUTION] This is the ONE route that accepts state changes without a session
   * > `/api/webhook/arr` is on `AuthService.publicPaths()` -- it has to be, because an arr
   * > has no cookie and no Plex account -- so the credentials here are the whole of its
   * > authentication. **Unset `password` means the route refuses every caller**, which is
   * > the right default for a surface reachable from `finderr.example.com`: a webhook nobody
   * > configured is a webhook nobody misses, and a webhook nobody authenticated is an
   * > anonymous writer of somebody's request log.
   *
   * A Webhook connection's configurable fields are `url, method, username, password,
   * headers` -- there is no shared-secret field -- so the choice was HTTP basic auth or a
   * token in the URL. Basic auth, for the reason `safeUrl` and the `X-Plex-Token` header
   * rule were both bought with: a credential in a URL ends up in a log line.
   */
  webhook: {
    /** The basic-auth user an arr sends. A name, not a secret; the password is the secret. */
    username: string;
    /** The basic-auth password. UNSET DISABLES THE ROUTE ENTIRELY -- see above. */
    password?: string;
    /**
     * Refuse a webhook whose source address is not on a private network.
     *
     * A SECOND LAYER, off by default. The arrs reach finderr over the LAN in the shipped
     * deployment, so this costs nothing there and closes the route to the internet even if
     * the password leaks. It is off by default because on is silently wrong for anyone whose
     * arrs are not on an RFC1918 network -- a tunnel, a different site, a hosted arr -- and
     * the failure mode is a webhook that stops arriving with nothing in a browser to say so.
     *
     * > [!IMPORTANT] It reads the source address through `auth.trustProxy`, like everything else
     * > Behind Caddy every request carries the proxy's own address, so with `trustProxy` off
     * > this would see one private address for the entire internet and be worthless. With it
     * > on, the header is only trusted at its LAST hop -- and anyone who can reach finderr
     * > directly on the LAN can forge it, which is accepted here exactly as it is for the
     * > rate limiter: this narrows the surface, the password is what closes it.
     */
    lanOnly: boolean;
    /**
     * Requests per minute per IP on the webhook route.
     *
     * Generous rather than tight, because a legitimate season pack is a burst: a grab and an
     * import per episode, back to back. Dropping one of those costs nothing permanent -- the
     * reconcile poller is the safety net and catches up within thirty seconds -- but it
     * would cost the `manual_import` state, which nothing else can see.
     */
    ratePerMinute: number;
  };

  /**
   * Keep what people search for, so the scorer can be tuned against real queries.
   *
   * The whole reason this is worth having, and the whole reason it is safe to have, are in
   * `./search-log.ts`. In short: every constant in `SearchEngine.rank` was chosen to make an
   * agent-written canary suite pass, and nothing has ever compared those cases to a query a
   * human typed. A row holds a query, a timestamp and a result count -- no session, no user,
   * no address -- so there is no person in this data to protect.
   */
  searchLog: {
    /**
     * ON by default, which is the one default here that deserves an argument.
     *
     * Every other switch in this file that changes behaviour for an existing install is
     * opt-in, and those are performance or policy switches whose off state is what the
     * operator already had. This one is different in the way that matters: it collects
     * nothing about anybody, and off by default means the mechanism ships and the data
     * never arrives -- an operator does not know to turn on a log they have not read the
     * source for. Set `FINDERR_SEARCH_LOG=0` and nothing is buffered and nothing is
     * written; the two tables are left in place rather than dropped, because a flag flipped
     * to try something out must not destroy state.
     */
    enabled: boolean;
    /**
     * Rows kept per table, oldest deleted first. A disk bound, not a retention policy.
     *
     * 50,000 queries is more than a household types in a year and costs a few megabytes.
     * See `Store.pruneSearchLog` for why the ceiling is a row count rather than an age.
     */
    keepRows: number;
  };

  /**
   * The conversational assistant: which models, whose money, and who may use it at all.
   *
   * Three gates, and only two of them are configurable -- `aiGate` in `./ai-spend.ts` is the
   * single place all three are evaluated. THE DEPLOYMENT opts in by providing
   * `openrouterApiKey`; with no key the feature does not exist rather than failing, which is
   * the shape `tmdb` already ships. THE AUDIENCE is administrators, full stop, and there is
   * no key here for it. THE SPEND is limited by `dailyLimitUsd`, counted from the `ai_call`
   * ledger.
   */
  ai: {
    /**
     * The OpenRouter credential. NO KEY MEANS NO FEATURE, silently and deliberately.
     *
     * `OPENROUTER_API_KEY` in `.env`, unprefixed, reaching the container as
     * `FINDERR_OPENROUTER_API_KEY` -- the same mapping compose performs for every other
     * credential here.
     *
     * > [!CAUTION] It travels in an `Authorization` header and NEVER in a query parameter
     * > The lesson `tmdb` bought with `?api_key=` and the Plex mirror bought with its token:
     * > a credential in a URL is a logging problem, and every log line is a place it leaks.
     * > Anything that logs an OpenRouter URL goes through `safeUrl`.
     */
    openrouterApiKey?: string;
    /**
     * Which models may be used, best first. A LIST so an admin can benchmark an alternative
     * without a deploy -- aannarr, 2026-09-04.
     *
     * > [!IMPORTANT] This list and `dailyLimitUsd` are ONE decision, not two
     * > The cap is the naive `if (spent > limit) refuse`, with no reservation machinery, and
     * > that is only correct because the worst overshoot is one conversation. Measured
     * > 2026-09-04: one conversation costs ~$0.003 on `z-ai/glm-5.3-flash`, which is 0.3% of
     * > a $1 cap. On `anthropic/claude-fable-5.1` it is ~90%. Adding an expensive model here
     * > without re-checking that number quietly turns the cap into a suggestion.
     *
     * The default is `meta/muse-spark-1.3-contributor`, chosen by aannarr 2026-09-05. On the
     * six-case advanced tier that day it graded **6/6 correct** at **$0.0004 a question**,
     * median 9.4s, with 88% of its prompt tokens served from provider-side cache -- against
     * `z-ai/glm-5.3-flash` at 5/6, $0.00085 and 18.9s. It is the rare swap that is better and
     * cheaper at once, so the headroom the naive cap depends on got wider rather than
     * narrower. (The ~$0.003 figure above is per CONVERSATION and was measured on glm; only
     * the per-question cost has been re-measured, and it went down.)
     *
     * > [!IMPORTANT] `-contributor` IS A DATA-SHARING TIER, AND THAT IS THE WHOLE PRICE
     * > It is ~21x cheaper than plain `meta/muse-spark-1.3` because Meta may train on the
     * > prompts and completions sent through it. What travels is a user's question, this
     * > server's tool surface, and index rows we already publish -- no credential, since the
     * > arr and Plex keys never reach the agent. aannarr accepted that on 2026-09-05 for a
     * > household movie-search assistant, in those terms. **An operator who does not want it
     * > sets `FINDERR_AI_MODELS=meta/muse-spark-1.3`** and pays $0.0111 a question instead
     * > (6/6 and 6/6 on route in the same run, median 8.2s) -- still ~1% of a $1 cap.
     *
     * Only `models[0]` is ever used (`src/server/agent-chat.ts`). The rest of the list is
     * documentation for whoever benchmarks next, not a fallback chain -- nothing fails over.
     */
    models: string[];
    /**
     * USD one ordinary user may spend per day. Zero or less is UNLIMITED.
     *
     * A day is a day in the CONTAINER'S timezone, not in UTC -- see `localDay`. Admins are
     * exempt from this and from nothing else. The spend is counted from the `ai_call` table
     * and never from a running total.
     */
    dailyLimitUsd: number;
    /*
      THERE IS NO adminOnly KEY HERE, AND ITS ABSENCE IS THE POINT.

      This is an admin-only beta and `aiGate` enforces that with no switch to widen it. A
      config flag would put the whole household one env var away from a surface whose consent
      mechanism -- the per-account opt-in -- is not built. The flag arrives WITH that opt-in
      or not at all; see the comment on the `role` check in `./ai-spend.ts`.
    */
  };

  /** What one person may ask the library for. */
  requests: {
    /**
     * Titles an ordinary user may request per UTC day. `0`, the default, is UNLIMITED.
     *
     * Zero rather than a number, because a limit that appears at an upgrade is a limit
     * nobody chose: every existing install keeps behaving exactly as it did until an
     * operator opts in. It is the same zero-is-unlimited reading `RateLimiter` already
     * uses for its own limit, so there is one convention here rather than two.
     *
     * Counted in TITLES, not in HTTP calls, and admins are exempt -- the whole rule lives in
     * `./request-quota.ts` and the count is derived from the request log by
     * `Store.countRequestsSince`. It is a different thing from `auth.searchRatePerMinute`:
     * that one defends CPU per IP per minute and forgets on restart, this one is a fact
     * about a person over a day and survives one.
     */
    quotaPerDay: number;
  };

  /** Telling the person who asked, on the device they asked from. */
  push: {
    /**
     * Whether this instance offers web push at all. ON by default.
     *
     * It costs nothing when nobody subscribes -- the keys are generated on the first ask
     * and no message is ever sent to zero devices -- and turning it off is for an operator
     * who does not want their server talking to Google's, Apple's and Mozilla's push
     * services on their users' behalf. That is a legitimate position and it deserves a
     * switch rather than an explanation.
     *
     * Off makes `/api/push/key` report `enabled: false`, which is what the client checks
     * before offering the control. Existing subscriptions are kept, not deleted: a flag
     * flipped to debug something must not destroy state.
     */
    enabled: boolean;
    /**
     * The `sub` claim in every VAPID token: how a push service reaches THIS operator.
     *
     * RFC 8292 asks for a `mailto:` or `https:` URL, and the services use it to contact
     * whoever is sending if something goes wrong. It is configuration rather than a
     * constant because it is a claim about a deployment and this repo is somebody else's.
     *
     * The default is a valid address at `localhost`, which is honest -- it says "nobody
     * filled this in" without inventing a real inbox. Every push service tested accepts a
     * well-formed address; set `FINDERR_PUSH_CONTACT` to a real one if yours refuses, or
     * simply so a service that needs to reach you can.
     */
    contact: string;
  };

  /** Mirror the arr libraries locally so "do we have it?" never hits the network. */
  libraryRefreshSeconds: number;

  shelves: {
    /**
     * Hold the front page in memory, rebuilt by the timer that owns each shelf.
     *
     * `FINDERR_KEEP_SHELVES_FRESH=1`. OFF by default, because a cache that can serve a
     * stale page is exactly the sort of thing that should be switched on deliberately and
     * switchable off in one environment variable if it ever misbehaves -- there is no
     * migration and no state to unwind, the next boot simply computes per request again.
     *
     * It is a performance switch and NOT a correctness one: `src/server/front-page.ts`
     * holds unfiltered candidates and every user-specific fact stays on the request path,
     * so on and off produce identical shelves. `front-page.test.ts` pins that row for row.
     */
    keepFresh: boolean;
  };

  /**
   * How stale one series' EPISODE mirror may get before it is walked again, in seconds.
   *
   * > [!CAUTION] This is not `libraryRefreshSeconds` and it must never become it
   * > Sonarr answers `/episode` for ONE series at a time, so mirroring episodes costs one
   * > call per series rather than one call per pass. On a 596-series library, walking the
   * > lot on the 60-second library timer is ~596 requests a minute against Sonarr, forever
   * > -- for a fact that changes when a file lands or a new episode airs.
   *
   * Six hours, so a whole library is re-walked four times a day. Combined with the batch
   * below the steady state is a couple of calls a minute, and the mirror still notices a
   * newly imported episode within a few hours. A request the reader just made does NOT
   * wait for it: `markEpisodesMonitored` writes that through the moment Sonarr accepts.
   */
  episodeRefreshSeconds: number;

  /**
   * How many series' episode lists to walk per library refresh.
   *
   * The rate limiter for the above. Stale series are taken oldest-first, and one that has
   * never been walked comes first of all -- so a freshly added show, or a first boot,
   * fills in within a minute or two instead of waiting out a full cycle.
   */
  episodeRefreshBatch: number;

  /**
   * How often to log the one-line resource summary (RSS, heap, cgroup usage against
   * its ceiling, and the GC share of CPU). Zero disables it.
   *
   * Five minutes by default: often enough that a growing heap is visible in the log
   * before it becomes a limit, rare enough to stay out of the way of real output.
   */
  resourceLogSeconds: number;

  /**
   * A request at or over this many milliseconds is logged and kept in the slow log.
   * Zero disables both.
   *
   * 500 ms by default, and that is a threshold rather than a target. Every render path in
   * this product reads local SQLite and nothing else, so anything past half a second is a
   * query doing more work than it should -- which is exactly what it caught on the day it
   * shipped. Set it lower to profile, never higher to quieten it: a raised threshold is a
   * slow page nobody is told about.
   */
  slowRequestMs: number;

  /**
   * Link previews: what an ANONYMOUS caller may buy by sharing a `/title/:tconst` URL.
   *
   * The preview page itself reads local SQLite and nothing else, so it is close to free
   * and the per-IP number is generous. Resolving a poster we have never seen is the only
   * expensive thing on that path -- it calls Radarr and Sonarr -- and it is bounded
   * GLOBALLY rather than per IP, because the resource being protected is one NAS and an
   * attacker with many addresses defeats a per-address bound trivially.
   */
  preview: {
    /**
     * Requests per minute per IP for the preview PAGE. Zero disables the limiter.
     *
     * Deliberately not the single-digit number the outbound path gets. Slack, Discord and
     * Facebook unfurl from a handful of shared infrastructure addresses, so a tight per-IP
     * bound silently stops previews working in a busy channel -- which is the case previews
     * exist for. The page costs three indexed lookups; there is nothing here to ration.
     */
    ratePerMinute: number;
    /**
     * Poster resolutions per minute, PROCESS-WIDE, for anonymous previews. Zero disables
     * resolution entirely and previews then draw only posters already in the cache.
     *
     * This is the volume bound. Burst is bounded separately and by a different mechanism:
     * a fixed window would let a whole minute's worth fire in its first second, which is
     * the pile-up that takes the arrs down, so the resolver also holds a bulkhead at
     * concurrency 2 with NO queue. Both refuse instantly; a refusal renders a preview
     * without an image and is never an error.
     */
    resolvePerMinute: number;
  };

  /**
   * Where facet provider plugins are loaded from. Empty means the built-in directory
   * that ships with the source (`src/plugins`), which is the normal case -- this exists
   * so a container can mount a directory of plugins without a rebuild.
   */
  pluginsDir: string;

  /**
   * Installed addons to load, as module specifiers -- `finderr-addon-foo`, `@scope/bar`.
   *
   * The second way an addon gets in, for code that is versioned and installed rather
   * than dropped in a directory. Resolved from the app root, so a specifier finds what
   * `bun install` wrote; anything not installed is logged at boot and skipped.
   *
   * > [!CAUTION] Naming a package here runs its code with this process's privileges.
   * > `meta.hosts` gates `c.fetch`, not the module -- an addon can import `node:fs` at
   * > load time like any dependency. This list is as sensitive as `package.json`, and
   * > `ADDONS.md` says so at greater length.
   */
  pluginModules: string[];
}

const DEFAULTS: Config = {
  port: 7979,
  host: "0.0.0.0",
  dataDir: "/data",
  logLevel: "info",
  index: {
    fuzzyMinVotes: 100,
    // 25,000 measured against the real index on 2026-09-01: it reproduces IMDb's own
    // Top 250 head (Shawshank, Godfather, Dark Knight, Return of the King, Schindler's
    // List) to within a couple of positions, without IMDb's unpublished vote filtering.
    rankPriorVotes: 25_000,
    titleTypes: ["movie", "tvSeries", "tvMiniSeries", "tvMovie"],
    includeAdult: false,
    castMinVotes: 1000,
    castCategories: [
      "actor",
      "actress",
      "casting_director",
      "cinematographer",
      "composer",
      "director",
      "editor",
      "producer",
      "production_designer",
      "writer",
    ],
    castRefreshDays: 7,
    // 0 = every episode of every series. See the field's own doc comment for why the floor
    // that shipped here first was the wrong trade.
    episodeSeriesMinVotes: 0,
    refreshCron: "0 9 * * *", // after TMDB publishes (~07:20 UTC observed) and IMDb's drop
    refreshTz: "UTC",
    refreshOnBoot: true,
    staleRebuildDelayMs: 30_000,
    // All four DERIVED from the cgroup limit and the index size at boot. See the fields.
    memoryBudgetMb: null,
    sqliteMmapMb: null,
    sqliteCacheMb: null,
    prefault: null,
  },
  regions: ["US"],
  tmdb: {
    imageBase: "https://image.tmdb.org/t/p",
    cacheImages: true,
    cacheMaxBytes: 2_000_000_000, // 2 GB -- tens of thousands of w342 posters
  },
  plex: {
    enabled: true,
    productName: "finderr",
  },
  auth: {
    // localhost, because a checkout of this repo is somebody else's deployment. Set
    // AUTH_RP_ID and AUTH_ORIGINS in .env to the name finderr will actually live at --
    // and set it BEFORE the first passkey is registered, since rpId cannot change
    // afterwards without invalidating every credential.
    rpId: "localhost",
    rpName: "finderr",
    origins: ["http://localhost:7979", "http://localhost:7980"],
    sessionDays: 30,
    inviteHours: 72,
    // OFF: the shipped compose publishes the port directly, so the socket address is the
    // only honest answer. Turn it on when a reverse proxy is in front -- see the caution
    // on the field, both directions of this being wrong fail silently.
    trustProxy: false,
    authRatePerMinute: 20,
    searchRatePerMinute: 120,
    // Generous for reads a local index answers in under a millisecond; tight for the three
    // operations that cost real work. See the fields for the reasoning behind each number.
    agentCheapRatePerMinute: 120,
    agentExpensiveRatePerMinute: 20,
    // The login wall is ON unless an operator turns it off, and it is never off by accident.
    noAuth: false,
  },
  webhook: {
    username: "finderr",
    // No password default, deliberately: a shipped one would be a shipped credential on a
    // public route. Absent means the route refuses everybody, which is the state every
    // install starts in and stays in until an operator sets one.
    lanOnly: false,
    ratePerMinute: 300,
  },
  // On, and bounded. See the field for why this is the one default that is not opt-in.
  searchLog: { enabled: true, keepRows: 50_000 },
  // No key by default, so a checkout of this repo has no assistant and says nothing about
  // it. $1/day and admins-only are aannarr's calls of 2026-09-04; see the fields.
  ai: { models: ["meta/muse-spark-1.3-contributor"], dailyLimitUsd: 1 },
  // 0 = unlimited, which is what every version before the quota existed did. An operator
  // opts in; nobody wakes up to a limit they did not choose.
  requests: { quotaPerDay: 0 },
  push: { enabled: true, contact: "mailto:finderr@localhost" },
  libraryRefreshSeconds: 60,
  // Opt-in. See `shelves.keepFresh` -- off is the behaviour every version so far has had.
  shelves: { keepFresh: false },
  episodeRefreshSeconds: 21_600,
  episodeRefreshBatch: 25,
  resourceLogSeconds: 300,
  slowRequestMs: 500,
  // 30/min per IP is loose enough that no real unfurl service ever trips it and tight
  // enough that walking 1.27M titles from one address takes eighty years. 60/min global
  // for the outbound half -- a steady stream of shared links, never a sweep.
  preview: { ratePerMinute: 30, resolvePerMinute: 60 },
  pluginsDir: "",
  pluginModules: [],
};

// ---------------------------------------------------------------------------

function envStr(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === "" ? undefined : v;
}

function envInt(key: string): number | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new ConfigError(`${key} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * A number that may have a fractional part. Only money needs this so far.
 *
 * Separate from `envInt` rather than replacing it: every other numeric setting here is a
 * count, a port or a duration, and `envInt` rejecting "2.5" for those is the check working.
 */
function envNum(key: string): number | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

function envBool(key: string): boolean | undefined {
  const v = envStr(key)?.toLowerCase();
  if (v === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(v)}`);
}

export class ConfigError extends Error {}

/** Deep merge where `override` wins, ignoring undefined so ENV gaps don't blank YAML. */
function merge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = merge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/**
 * The three fields every servarr shares. `undefined` when the operator set none of them,
 * which is what keeps an unconfigured service absent rather than half-present.
 */
function servarrFromEnv(prefix: "RADARR" | "SONARR" | "PROWLARR"): Partial<ServarrService> | undefined {
  const url = envStr(`FINDERR_${prefix}_URL`);
  const apiKey = envStr(`FINDERR_${prefix}_API_KEY`);
  const publicUrl = envStr(`FINDERR_${prefix}_PUBLIC_URL`);
  if (!url && !apiKey && !publicUrl) return undefined;
  return { url, apiKey, publicUrl } as Partial<ServarrService>;
}

function arrFromEnv(prefix: "RADARR" | "SONARR"): Partial<ArrService> | undefined {
  const rootFolder = envStr(`FINDERR_${prefix}_ROOT_FOLDER`);
  const qualityProfileId = envInt(`FINDERR_${prefix}_QUALITY_PROFILE_ID`);
  const shared = servarrFromEnv(prefix);
  if (!shared && !rootFolder && qualityProfileId === undefined) return undefined;
  return { ...shared, rootFolder, qualityProfileId } as Partial<ArrService>;
}

function envOverrides(): Record<string, unknown> {
  return {
    port: envInt("FINDERR_PORT"),
    host: envStr("FINDERR_HOST"),
    dataDir: envStr("FINDERR_DATA_DIR"),
    logLevel: envStr("FINDERR_LOG_LEVEL"),
    index: {
      fuzzyMinVotes: envInt("FINDERR_INDEX_FUZZY_MIN_VOTES"),
      rankPriorVotes: envInt("FINDERR_INDEX_RANK_PRIOR_VOTES"),
      includeAdult: envBool("FINDERR_INDEX_INCLUDE_ADULT"),
      refreshCron: envStr("FINDERR_INDEX_REFRESH_CRON"),
      refreshTz: envStr("FINDERR_INDEX_REFRESH_TZ"),
      castRefreshDays: envInt("FINDERR_INDEX_CAST_REFRESH_DAYS"),
      refreshOnBoot: envBool("FINDERR_INDEX_REFRESH_ON_BOOT"),
      memoryBudgetMb: envInt("FINDERR_MEMORY_BUDGET_MB"),
      sqliteMmapMb: envInt("FINDERR_SQLITE_MMAP_MB"),
      sqliteCacheMb: envInt("FINDERR_SQLITE_CACHE_MB"),
      prefault: envBool("FINDERR_INDEX_PREFAULT"),
      castMinVotes: envInt("FINDERR_INDEX_CAST_MIN_VOTES"),
      episodeSeriesMinVotes: envInt("FINDERR_INDEX_EPISODE_SERIES_MIN_VOTES"),
      titleTypes: envStr("FINDERR_INDEX_TITLE_TYPES")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      castCategories: envStr("FINDERR_INDEX_CAST_CATEGORIES")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    radarr: arrFromEnv("RADARR"),
    sonarr: arrFromEnv("SONARR"),
    prowlarr: servarrFromEnv("PROWLARR"),
    // Upper-cased on the way in: TMDB takes ISO 3166-1 alpha-2 and rejects "us".
    regions: envStr("FINDERR_REGIONS")
      ?.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    tmdb: {
      apiKey: envStr("FINDERR_TMDB_API_KEY"),
      imageBase: envStr("FINDERR_TMDB_IMAGE_BASE"),
      cacheImages: envBool("FINDERR_TMDB_CACHE_IMAGES"),
      cacheMaxBytes: envInt("FINDERR_ARTWORK_CACHE_MAX_BYTES"),
      // Same upper-casing as `regions`, and for the same reason: the codes are matched
      // against TMDB's own ISO 3166-1 alpha-2 keys, which are upper case.
      watchProviderRegions: envStr("FINDERR_TMDB_WATCH_PROVIDER_REGIONS")
        ?.split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    },
    plex: {
      enabled: envBool("FINDERR_PLEX_ENABLED"),
      productName: envStr("FINDERR_PLEX_PRODUCT_NAME"),
      machineIdentifier: envStr("FINDERR_PLEX_MACHINE_ID"),
      url: envStr("FINDERR_PLEX_URL"),
      token: envStr("FINDERR_PLEX_TOKEN"),
    },
    auth: {
      rpId: envStr("FINDERR_AUTH_RP_ID"),
      rpName: envStr("FINDERR_AUTH_RP_NAME"),
      origins: envStr("FINDERR_AUTH_ORIGINS")
        ?.split(",")
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean),
      sessionDays: envInt("FINDERR_AUTH_SESSION_DAYS"),
      inviteHours: envInt("FINDERR_AUTH_INVITE_HOURS"),
      cookieSecure: envBool("FINDERR_AUTH_COOKIE_SECURE"),
      trustProxy: envBool("FINDERR_AUTH_TRUST_PROXY"),
      adminApiKey: envStr("FINDERR_ADMIN_API_KEY"),
      authRatePerMinute: envInt("FINDERR_AUTH_RATE_PER_MINUTE"),
      searchRatePerMinute: envInt("FINDERR_SEARCH_RATE_PER_MINUTE"),
      agentCheapRatePerMinute: envInt("FINDERR_AGENT_CHEAP_RATE_PER_MINUTE"),
      agentExpensiveRatePerMinute: envInt("FINDERR_AGENT_EXPENSIVE_RATE_PER_MINUTE"),
      noAuth: envBool("FINDERR_NO_AUTH"),
    },
    webhook: {
      username: envStr("FINDERR_WEBHOOK_USERNAME"),
      password: envStr("FINDERR_WEBHOOK_PASSWORD"),
      lanOnly: envBool("FINDERR_WEBHOOK_LAN_ONLY"),
      ratePerMinute: envInt("FINDERR_WEBHOOK_RATE_PER_MINUTE"),
    },
    searchLog: {
      enabled: envBool("FINDERR_SEARCH_LOG"),
      keepRows: envInt("FINDERR_SEARCH_LOG_KEEP_ROWS"),
    },
    ai: {
      openrouterApiKey: envStr("FINDERR_OPENROUTER_API_KEY"),
      models: envStr("FINDERR_AI_MODELS")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      dailyLimitUsd: envNum("FINDERR_AI_DAILY_LIMIT_USD"),
    },
    requests: { quotaPerDay: envInt("FINDERR_REQUEST_QUOTA_PER_DAY") },
    push: {
      enabled: envBool("FINDERR_PUSH_ENABLED"),
      contact: envStr("FINDERR_PUSH_CONTACT"),
    },
    libraryRefreshSeconds: envInt("FINDERR_LIBRARY_REFRESH_SECONDS"),
    shelves: { keepFresh: envBool("FINDERR_KEEP_SHELVES_FRESH") },
    episodeRefreshSeconds: envInt("FINDERR_EPISODE_REFRESH_SECONDS"),
    episodeRefreshBatch: envInt("FINDERR_EPISODE_REFRESH_BATCH"),
    resourceLogSeconds: envInt("FINDERR_RESOURCE_LOG_SECONDS"),
    slowRequestMs: envInt("FINDERR_SLOW_REQUEST_MS"),
    preview: {
      ratePerMinute: envInt("FINDERR_PREVIEW_RATE_PER_MINUTE"),
      resolvePerMinute: envInt("FINDERR_PREVIEW_RESOLVE_PER_MINUTE"),
    },
    pluginsDir: envStr("FINDERR_PLUGINS_DIR"),
    pluginModules: envStr("FINDERR_PLUGIN_MODULES")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function loadYaml(): Record<string, unknown> {
  const path = envStr("FINDERR_CONFIG_FILE") ?? "/config/config.yml";
  if (!existsSync(path)) return {};
  try {
    // Bun.YAML is builtin -- no dependency needed.
    return (Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>) ?? {};
  } catch (err) {
    throw new ConfigError(`failed to parse ${path}: ${(err as Error).message}`);
  }
}

function validate(c: Config): void {
  const problems: string[] = [];
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    problems.push(`port ${c.port} is out of range`);
  if (!c.dataDir.startsWith("/")) problems.push("dataDir must be an absolute path");
  if (c.index.fuzzyMinVotes < 0) problems.push("index.fuzzyMinVotes must be >= 0");
  if (c.index.titleTypes.length === 0) problems.push("index.titleTypes must not be empty");
  if (c.index.castMinVotes < 0) problems.push("index.castMinVotes must be >= 0");
  if (c.index.episodeSeriesMinVotes < 0) problems.push("index.episodeSeriesMinVotes must be >= 0");
  // Zero would divide by zero for an unrated title and make every rank its own rating,
  // which is the exact failure the prior exists to prevent.
  if (c.index.rankPriorVotes < 1) problems.push("index.rankPriorVotes must be >= 1");
  // Empty is legal and means "index no cast at all" -- a deliberate way to opt out of
  // the largest dump. It is not an error, so nothing is pushed for it.

  for (const name of ["radarr", "sonarr", "prowlarr"] as const) {
    const svc = c[name];
    if (!svc) continue;
    if (!svc.url) problems.push(`${name} is configured but FINDERR_${name.toUpperCase()}_URL is missing`);
    if (!svc.apiKey)
      problems.push(`${name} is configured but FINDERR_${name.toUpperCase()}_API_KEY is missing`);
    if (svc.url && !/^https?:\/\//.test(svc.url))
      problems.push(`${name}.url must start with http:// or https://`);
  }

  // A bad rpId does not fail loudly at boot -- it fails at the one moment a user is
  // holding a phone waiting for Touch ID, with a browser-side error nobody can read from
  // the server. So it is checked here, where the message can say what is wrong.
  if (/[:/]/.test(c.auth.rpId))
    problems.push(
      `auth.rpId must be a bare domain with no scheme or port, got ${JSON.stringify(c.auth.rpId)}`,
    );
  if (c.auth.origins.length === 0) problems.push("auth.origins must not be empty");
  for (const o of c.auth.origins) {
    if (!/^https?:\/\/[^/]+$/.test(o))
      problems.push(
        `auth.origins entry ${JSON.stringify(o)} must be a bare origin like https://finderr.example.com`,
      );
  }
  // Zero would prune every row on the flush that wrote it, which reads as "logging is
  // broken" rather than as "logging is off" -- that is what `enabled` is for.
  if (c.searchLog.keepRows < 1) problems.push("searchLog.keepRows must be >= 1");

  if (c.auth.sessionDays <= 0) problems.push("auth.sessionDays must be > 0");
  if (c.auth.inviteHours <= 0) problems.push("auth.inviteHours must be > 0");
  // Short enough to brute-force is worse than absent, because absent is visible in the
  // health payload and a weak key looks like security.
  if (c.auth.adminApiKey !== undefined && c.auth.adminApiKey.length < 24)
    problems.push("auth.adminApiKey is too short to be a credential -- use at least 24 characters");

  /*
    An empty model list with a key present is the one AI misconfiguration that fails LATE and
    silently: the gate says yes -- there is a key -- and the runner then has nothing to call.
    Caught here, where the message can say which variable was emptied.

    A NEGATIVE limit is not caught, because zero-or-less means unlimited by convention across
    every limit in this file, and a -1 someone typed means the same thing as the 0 they meant.
  */
  if (c.ai.openrouterApiKey !== undefined && c.ai.models.length === 0)
    problems.push("ai.models is empty -- FINDERR_AI_MODELS must name at least one model");
  if (!Number.isFinite(c.ai.dailyLimitUsd))
    problems.push("ai.dailyLimitUsd must be a number of dollars per day");

  if (problems.length) {
    throw new ConfigError(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * Whether the session cookie should carry `Secure`.
 *
 * Derived rather than remembered: the flag has to be OFF while finderr is reachable only
 * over plain http on the LAN (the browser discards a `Secure` cookie there and the user
 * is silently never logged in), and ON the moment it is served over TLS. Reading it off
 * the origins means moving the app is one config change rather than two, and the two can
 * never disagree.
 */
export function cookieIsSecure(c: Config = loadConfig()): boolean {
  if (c.auth.cookieSecure !== undefined) return c.auth.cookieSecure;
  return c.auth.origins.every((o) => o.startsWith("https://"));
}

let cached: Config | undefined;

export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  const merged = merge(merge(DEFAULTS, loadYaml()), envOverrides());
  validate(merged);
  cached = merged;
  return merged;
}

/** Paths derived from dataDir. Everything mutable is under one volume. */
export function paths(c: Config = loadConfig()) {
  return {
    root: c.dataDir,
    /** The live index, atomically swapped in. */
    db: `${c.dataDir}/titles.db`,
    /** Built here, then renamed over `db`. */
    dbNew: `${c.dataDir}/titles.new.db`,
    /** Kept for one generation so a rollback is a `mv`. */
    dbPrev: `${c.dataDir}/titles.prev.db`,
    /** Application state: requests, sessions, library mirror, ETags. */
    appDb: `${c.dataDir}/finderr.db`,
    dumps: `${c.dataDir}/dumps`,
    images: `${c.dataDir}/images`,
  };
}
