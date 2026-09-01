/**
 * Resolving facets: cache on the render path, providers off it.
 *
 * THE RULE THAT DOES NOT BEND -- a request handler reads the SQLite facet cache and
 * nothing else. Providers are network calls; they run in the background and their
 * answers land in the cache for the next read. `read()` is the render path, `warm()`
 * kicks the work, and `resolve()` is for the pre-warm job and for tests, which are the
 * only callers allowed to wait.
 *
 * A provider that throws, hangs, or returns garbage leaves the facet resolved without
 * it. That is the whole point of contributions being namespaced per plugin: one bad
 * answer can only ever remove itself.
 */

import {
  isBulkheadRejectedError,
  isTaskCancelledError,
  type TimeoutPolicy,
  TimeoutStrategy,
  timeout,
} from "cockatiel";
import type {
  EntityKind,
  FacetEntity,
  FacetName,
  FacetProblem,
  FacetShapes,
  FailureReason,
  FreshnessClass,
} from "./facets";
import {
  classFor,
  DEFAULT_FRESHNESS,
  FRESHNESS_TTL_MS,
  facetsFor,
  isValidContribution,
  mergeContributions,
  scheduleHorizonOf,
} from "./facets";
import type { PluginRegistry, RegisteredProvider } from "./plugins";
import type { FacetContributionRow, FacetOutcome } from "./store";
import { type SamplerReport, Timings } from "./timings";

/**
 * Four states, not two. A pane renders a skeleton for `pending`, hides for `empty`, and
 * hides quietly for `failed` -- collapsing the last three would make a dead provider
 * look identical to a title that genuinely has nothing.
 */
export type FacetStatus = "ready" | "pending" | "empty" | "failed";

export interface ResolvedFacet<F extends FacetName = FacetName> {
  status: FacetStatus;
  data?: FacetShapes[F];
}

/** Mapped rather than `Partial<Record<...>>` so `facets.ratings.data` is a `Rating[]`. */
export type ResolvedFacets = { [F in FacetName]?: ResolvedFacet<F> };

/**
 * Does this cached row still count?
 *
 * Two rules, and they are the reason the cache needs no migrations: a row whose plugin is
 * no longer loaded is ignored (deleting a plugin file removes its contributions without
 * touching the database), and a row written under a superseded config version is ignored
 * (a corrected API key takes effect immediately).
 *
 * Exported because a reverse read of the cache -- "which titles name this collection?" --
 * has to apply the same judgement, and a second copy of it would be the one nobody
 * updates when a third rule arrives.
 */
export function isLiveContribution(registry: PluginRegistry, row: FacetContributionRow): boolean {
  return registry.has(row.plugin_id) && row.config_version === registry.configVersionOf(row.plugin_id);
}

/**
 * Is this row good enough to DRAW, even though it may not be current?
 *
 * ## The two questions this splits apart
 *
 * `isLiveContribution` answers "may this row be treated as the provider's current answer?"
 * and is the right rule for deciding whether to ASK again. It was also, until 2026-09-01,
 * the rule for deciding whether to RENDER -- and those are not the same question.
 *
 * `configVersion` is a hash of a plugin's whole source tree, which is deliberately
 * conservative: the cost of a false positive is a re-fetch, the cost of a false negative is
 * a wrong value served for up to 90 days, and that is not a close call. But it is very
 * coarse. Editing a log line invalidates every row the plugin ever wrote.
 *
 * **Measured on the live deployment, 2026-09-01.** A release that touched a fetch helper and
 * a comment in three plugins took the cache from 5,379 rows to 3,495 at one restart, and
 * the warm loop then re-bought every one of them from `api.radarr.video` and an Algolia
 * index we are uninvited on. The upgrade was not wrong about anything -- almost none of
 * those facets had changed shape -- and it cost a burst of traffic to third parties plus a
 * page of skeletons for every reader who arrived first.
 *
 * ## So: serve the old value, and ask anyway
 *
 * A superseded row is USABLE. It renders immediately, at the value we last received, while
 * `outstanding()` still counts its provider as owing an answer -- so the page polls, the
 * provider is asked at the ordinary paced rate, and the fresh row replaces it in place.
 * Convergence is one view rather than one TTL.
 *
 * That directly addresses the failure the source hash was introduced for. The symptom then
 * was "correct a provider's mapping and the OLD value keeps being served until the facet's
 * own TTL expires", which for a `settled` facet is 90 days. Here the old value survives
 * exactly one render of one title, and only for someone who was already looking at it.
 *
 * A row whose PLUGIN is gone is not usable, and that rule does not soften: an uninstalled
 * addon's facts must leave the page, and nobody is ever going to answer for them again.
 */
export function isUsableContribution(registry: PluginRegistry, row: FacetContributionRow): boolean {
  return registry.has(row.plugin_id);
}

/** The slice of `Store` this needs. Narrow so a test can hand over a fake. */
export interface FacetCache {
  facetContributions(entityId: string, now?: string): FacetContributionRow[];
  putFacetContribution(row: FacetContributionRow): void;
}

/** A detail view is a deliberate click, so a little latency is affordable there. */
export const DEFAULT_DEADLINE_MS = 400;

/**
 * A provider is cut off well before this; the hard cap only exists so a provider that
 * never settles cannot leak a pending entry for the life of the process.
 */
const HARD_TIMEOUT_MS = 30_000;

/*
  THE CONCURRENCY GATE IS NOT HERE, AND THAT IS THE SECOND TIME THIS LAYER LOOKED RIGHT.

  A `bulkhead` wrapped around `provider.run` was written here first and the suite refused
  it: three tests went red, all of them the plugins' own coalescing tests -- "thirteen
  facets cost one call, not thirteen", the skyhook crosswalk, the collection document.

  The reason is easy to walk straight past: a plugin serving
  many facets from ONE upstream document coalesces its own in-flight fetches, and that only
  works because **the resolver starts every provider in one synchronous burst**. Gate the
  provider CALLS and the burst stops being a burst -- the seventh facet is admitted after
  the first has finished, by which time the in-flight entry it would have joined is gone, so
  it fetches the same document again. A limiter that multiplies upstream calls by ten is not
  a limiter.

  So the gate belongs where the scarce thing actually is: the outbound FETCH, in
  `plugin-fetch.ts`, beside `HostPacer` which is already there for the same reason. Thirteen
  providers may all start; they resolve to one fetch, and it is the fetch that queues.
*/

/** Long enough to stop a dead provider being hammered on every view, short enough to recover. */
const FAILED_TTL_MS = 10 * 60 * 1000;

/**
 * "We asked and there was nothing" is cached, but never forever, even for an immutable
 * facet: an empty answer today often means the provider had not indexed the title yet,
 * and permanently caching that would leave a real cast list unreachable.
 */
const EMPTY_IMMUTABLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Gap between two TITLES in the pre-warm loop.
 *
 * Per title, never per facet: servarr-metadata serves thirteen facets from ONE upstream
 * document and coalesces its own in-flight calls, so a title costs roughly one request
 * per provider however many panes it fills. `HostPacer` in `./plugin-fetch` already keeps
 * a floor between calls to one host; this is the courtesy on top of it -- a warm loop
 * that never looks like a crawl even when every provider it wakes is a different host.
 *
 * Sized on requests, not bytes, and those differ by an order of magnitude: a film's
 * `api.radarr.video` answer is a few KB where a 73-episode series' skyhook document is
 * ~71 KB. A shelf of long-running dramas moves far more data for the same request count.
 */
export const WARM_PAUSE_MS = 750;

/**
 * A provider slower than this is named in the log, once per call.
 *
 * Above the whole cold-title budget rather than near it: a title fills in around a second,
 * so a threshold of a second would print a line for every ordinary first view and the log
 * would say nothing. This is set where "something is wrong with this provider" starts,
 * which is a call that has taken longer than a reader will wait for the page.
 */
export const SLOW_PROVIDER_MS = 3_000;

export interface FacetResolverDeps {
  store: FacetCache;
  registry: PluginRegistry;
  log?: (message: string) => void;
  now?: () => number;
  /** Injected so the pre-warm loop's pacing costs a test no real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** The per-provider hard cap. Injected so a test proves cancellation in ms, not 30s. */
  hardTimeoutMs?: number;
}

export class FacetResolver {
  private readonly store: FacetCache;
  private readonly registry: PluginRegistry;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Keyed `tconst|facet|pluginId` -- one title being viewed twice must not ask twice. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /**
   * The give-up, per provider, so one misbehaving plugin cannot hold the page.
   *
   * **Aggressive** rather than Optimistic, and the word carries the whole fix: Optimistic
   * only stops us waiting, while Aggressive aborts the signal the provider was handed, so a
   * cancelled call releases its socket and its `inFlight` lock instead of running on
   * invisibly. That is the difference between a timeout and a leak.
   */
  private readonly deadline: TimeoutPolicy;
  private readonly hardTimeoutMs: number;
  /** Calls the outbound gate turned away. The only outcome that writes nothing. */
  private refused = 0;
  /**
   * How long each provider takes, keyed `pluginId|facet`.
   *
   * Keyed by the PAIR, not by the plugin: `servarr-metadata` serves thirteen facets from
   * one document, so its thirteen providers settle together and a per-plugin number would
   * be thirteen copies of the same measurement. The pair is also what the log line and the
   * cache row already name, so nothing new has to be correlated by hand.
   */
  private readonly timings = new Timings();

  constructor(deps: FacetResolverDeps) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? Bun.sleep;
    this.hardTimeoutMs = deps.hardTimeoutMs ?? HARD_TIMEOUT_MS;
    this.deadline = timeout(this.hardTimeoutMs, TimeoutStrategy.Aggressive);
  }

  /**
   * Every facet this kind of entity can have, answered from cache alone.
   *
   * Never awaits anything. Facets nobody provides come back `empty`, so the client can
   * hide their panes rather than wait for data that is never coming.
   */
  read(entity: FacetEntity): ResolvedFacets {
    const rows = this.rowsFor(entity.tconst, "usable");
    const out: Record<string, ResolvedFacet> = {};
    for (const facet of facetsFor(entity.kind)) {
      out[facet] = this.resolveOne(facet, entity.kind, rows.get(facet) ?? []);
    }
    // Built through a loose record because the key is only known at runtime; the mapped
    // type is what every CALLER sees, which is where the per-facet data type earns its keep.
    return out as ResolvedFacets;
  }

  /**
   * Ask every provider that has nothing fresh cached, in the background.
   *
   * Returns immediately. Safe to call on every view: work already in flight is joined
   * rather than duplicated, and a provider with a fresh row is not asked at all.
   */
  warm(entity: FacetEntity): void {
    for (const task of this.pendingWork(entity)) void task.catch(() => {});
  }

  /**
   * Warm, then wait -- but only until the deadline, and never for a specific provider.
   *
   * A provider still running when the deadline passes is NOT abandoned: its promise
   * carries the cache write, so its answer still lands and the next read has it. This is
   * why a slow provider is slow once per title rather than once per request.
   */
  async resolve(entity: FacetEntity, opts: { deadlineMs?: number } = {}): Promise<ResolvedFacets> {
    const work = this.pendingWork(entity);
    if (work.length > 0) {
      let expire: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((r) => {
        expire = setTimeout(r, opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
      });
      // Clearing matters: without it a fast resolve still holds the event loop open for
      // the rest of the budget, which turns a 5 ms warm loop into a 400 ms one.
      await Promise.race([Promise.allSettled(work), deadline]).finally(() => clearTimeout(expire));
    }
    return this.read(entity);
  }

  /**
   * Warm a whole shelf ahead of anyone asking for it: one title at a time, with a pause
   * between the ones that actually cost a call.
   *
   * A BOUNDED QUEUE, never a parallel fan-out -- providers ride third-party endpoints we
   * are uninvited on, and 175 titles arriving at once is the difference between a polite
   * client and a crawler. Unlike `resolve` this waits for every provider to settle rather
   * than racing a deadline: nobody is on the other end of a warm, and abandoning the wait
   * would only mean pacing against work that is still running.
   *
   * A title with nothing outstanding costs neither a call nor a pause, which is what makes
   * the six-hourly re-run of a warm shelf effectively free.
   */
  async prewarm(
    entities: FacetEntity[],
    opts: { pauseMs?: number } = {},
  ): Promise<{ fetched: number; alreadyWarm: number }> {
    let fetched = 0;
    let alreadyWarm = 0;

    for (const entity of entities) {
      const work = this.pendingWork(entity);
      if (work.length === 0) {
        alreadyWarm++;
        continue;
      }
      await Promise.allSettled(work);
      fetched++;
      await this.sleep(opts.pauseMs ?? WARM_PAUSE_MS);
    }
    return { fetched, alreadyWarm };
  }

  /**
   * Every provider that owes this title an answer has given one, including "nothing".
   *
   * Reads the cache and asks nobody, so `/api/health` can report coverage for every shelf
   * without the check itself being what warms them.
   */
  isWarm(entity: FacetEntity): boolean {
    return this.outstanding(entity).length === 0;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Cached rows grouped by facet, for one of the two questions the caller has.
   *
   * `"usable"` is what to DRAW -- superseded rows included, so an upgrade renders the last
   * known value instead of a skeleton. `"current"` is who still OWES an answer. See
   * `isUsableContribution` for why those are different questions.
   */
  private rowsFor(entityId: string, want: "usable" | "current"): Map<string, FacetContributionRow[]> {
    const keep = want === "usable" ? isUsableContribution : isLiveContribution;
    const grouped = new Map<string, FacetContributionRow[]>();
    for (const row of this.store.facetContributions(entityId, new Date(this.now()).toISOString())) {
      if (!keep(this.registry, row)) continue;
      const list = grouped.get(row.facet);
      if (list) list.push(row);
      else grouped.set(row.facet, [row]);
    }
    return grouped;
  }

  /**
   * One facet's status and merged value.
   *
   * A single good answer makes the facet `ready` even while another provider is still
   * out -- showing the IMDb score now beats holding it back until RT replies, and the
   * late one merges in on the next read.
   */
  private resolveOne(facet: FacetName, kind: EntityKind, rows: FacetContributionRow[]): ResolvedFacet {
    const providers = this.registry.providersFor(facet, kind);
    if (providers.length === 0) return { status: "empty" };

    /*
      One value per plugin, and a CURRENT row always beats a superseded one.

      Both can be present at once: a plugin whose source moved writes its new answer beside
      the old one, and the old one stays readable until it is replaced (see
      `isUsableContribution`). The map is keyed by plugin, so without this the winner would
      be whichever row the store happened to return last -- and the store returns them in
      insert order, which is a race rather than a rule. Ranking on CONTENT rather than on
      position is the same rule `mergeRatings` follows for the same reason.
    */
    const byPlugin = new Map<string, FacetShapes[FacetName]>();
    const currentPlugin = new Set<string>();
    for (const row of rows) {
      if (row.outcome !== "ok" || row.data === null) continue;
      const current = isLiveContribution(this.registry, row);
      if (!current && currentPlugin.has(row.plugin_id)) continue;
      if (current) currentPlugin.add(row.plugin_id);
      byPlugin.set(row.plugin_id, JSON.parse(row.data) as FacetShapes[FacetName]);
    }

    const merged = mergeContributions(facet, byPlugin);
    if (merged !== null) return { status: "ready", data: merged };

    const answered = new Set(rows.map((r) => r.plugin_id));
    if (providers.some((p) => !answered.has(p.pluginId))) return { status: "pending" };
    return rows.some((r) => r.outcome === "failed") ? { status: "failed" } : { status: "empty" };
  }

  /**
   * The providers that owe this entity an answer, asking none of them.
   *
   * Separate from `pendingWork` because "is this title warm?" must be answerable without
   * setting off the very fetches it is asking about -- `/api/health` reports coverage for
   * every shelf, and a health check that warms the cache measures itself.
   */
  private outstanding(entity: FacetEntity): RegisteredProvider[] {
    const rows = this.rowsFor(entity.tconst, "current");
    const owed: RegisteredProvider[] = [];

    for (const facet of facetsFor(entity.kind)) {
      const answered = new Set((rows.get(facet) ?? []).map((r) => r.plugin_id));
      for (const provider of this.registry.providersFor(facet, entity.kind)) {
        if (!answered.has(provider.pluginId)) owed.push(provider);
      }
    }
    return owed;
  }

  /** One promise per provider that owes this entity an answer. Deduplicated. */
  private pendingWork(entity: FacetEntity): Promise<void>[] {
    return this.outstanding(entity).map((provider) => this.ask(provider, entity));
  }

  /**
   * Join the call already running for this provider and entity, or start one.
   *
   * > [!CAUTION] The lock must outlive our PATIENCE, not just our await
   * > This used to release the key when `callProvider` settled -- which happens when the
   * > timeout fires, while `provider.run()` is still executing. A caller arriving after
   * > that started a SECOND upstream call for the same title while the first was still in
   * > flight, which is precisely the fan-out `HostPacer` exists to prevent, arriving
   * > through the side door. The give-up is now a real cancellation (`TimeoutStrategy
   * > .Aggressive`), so "we stopped waiting" and "the work stopped" are the same moment
   * > again and one key can safely mean one call.
   */
  private ask(provider: RegisteredProvider, entity: FacetEntity): Promise<void> {
    const key = `${entity.tconst}|${provider.facet}|${provider.pluginId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const task = this.callProvider(provider, entity).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Ask one provider and record whatever came back, including nothing.
   *
   * Never rejects: a plugin's failure is data about that plugin, not an error the host
   * has to handle. Everything the provider can do wrong -- throw, hang, answer with
   * junk -- ends as one `failed` row and no effect on any other contribution.
   */
  private async callProvider(provider: RegisteredProvider, entity: FacetEntity): Promise<void> {
    const { facet, pluginId } = provider;
    const startedAt = this.now();
    let refused = false;
    try {
      const answer = await this.deadline.execute((ctx) => provider.run(entity, ctx.signal));

      /*
        A PROVIDER THAT SWALLOWS ITS CANCELLATION MUST NOT HAVE ITS ANSWER BELIEVED.

        `Aggressive` aborts the signal, but a plugin is free to catch that and return
        normally -- and if its `resolve` wins the race against cockatiel's rejection, we
        land here holding a value produced by a call we had already given up on. Usually
        that value is `null`, which would be written as `empty`: a cached "there is nothing
        here" for a title we never actually got an answer about.

        Elapsed time is the check, because the SIGNAL cannot be one -- it is aborted on
        success too (pinned in `facet-resolver.test.ts`), so `signal.aborted` afterwards is
        true either way and says nothing.
      */
      if (this.now() - startedAt >= this.hardTimeoutMs) {
        this.log(`plugin ${pluginId}: '${facet}' answered AFTER being cancelled -- answer dropped`);
        this.write(entity, provider, "failed", null, DEFAULT_FRESHNESS, "timeout");
        return;
      }

      if (answer === null || answer === undefined) {
        this.write(entity, provider, "empty", null, DEFAULT_FRESHNESS);
        return;
      }
      if (!isValidContribution(facet, answer)) {
        this.log(`plugin ${pluginId}: '${facet}' contribution did not fit the facet shape -- dropped`);
        this.write(entity, provider, "failed", null, DEFAULT_FRESHNESS, "invalid-shape");
        return;
      }
      this.write(entity, provider, "ok", answer.data, answer.freshness ?? DEFAULT_FRESHNESS);
    } catch (err) {
      /*
        OVERLOAD IS NOT AN ANSWER, SO IT IS NOT CACHED AS ONE.

        Every other exit from here writes a row, because every other exit means we ASKED and
        learned something -- including "it broke". A gate refusal means we never asked at
        all: the process was already at its outbound ceiling. Writing `failed` would earn a
        `FAILED_TTL_MS` row, so one busy second would suppress a perfectly good provider for
        ten minutes on a title nobody had even queried yet. The facet stays `pending`, which
        is TRUE, and the next read asks again.

        This holds only for a plugin that PROPAGATES the rejection. One that catches every
        error and returns `null` gets `empty` cached instead -- not new (it has always been
        true of any fetch failure), but it is why `ADDONS.md` tells authors to let host
        errors through rather than swallow them.
      */
      if (isBulkheadRejectedError(err)) {
        this.refused++;
        refused = true;
        this.log(`refused '${facet}' for ${entity.tconst} -- outbound gate full, will retry`);
        return;
      }
      const cancelled = isTaskCancelledError(err);
      const why = cancelled ? `gave up after ${this.hardTimeoutMs}ms` : (err as Error).message;
      this.log(`plugin ${pluginId}: '${facet}' failed for ${entity.tconst} -- ${why}`);
      this.write(entity, provider, "failed", null, DEFAULT_FRESHNESS, cancelled ? "timeout" : "error");
    } finally {
      /*
        EVERY exit is timed EXCEPT the gate refusal, for the same reason it writes no row:
        we never asked. A refusal returns in about no time at all, so counting it would pull
        the provider's distribution down -- a busy minute would make a slow plugin look fast,
        which is the one direction a latency report must never be wrong in.
      */
      if (!refused) {
        const elapsed = this.now() - startedAt;
        this.timings.add(`${pluginId}|${facet}`, elapsed);
        if (elapsed >= SLOW_PROVIDER_MS) {
          this.log(`plugin ${pluginId}: '${facet}' took ${Math.round(elapsed)}ms for ${entity.tconst}`);
        }
      }
    }
  }

  /**
   * How long each `pluginId|facet` has been taking, worst total first.
   *
   * Reported beside the outbound per-host figures on `/api/health`: this is what a title
   * WAITED, the other is where that wait went. A provider slow while its host is fast is
   * doing several serial calls, which is the shape worth catching.
   */
  timingReport(): Record<string, SamplerReport> {
    return this.timings.report();
  }

  /** Provider calls the outbound gate turned away since boot. The only silent outcome. */
  refusedCount(): number {
    return this.refused;
  }

  /**
   * What is still being worked on for this entity, and what has already gone wrong.
   *
   * **This is the answer the client polls on**, and it replaces a timer the browser was
   * guessing with. Asks nobody and starts nothing -- `outstanding()` reads the cache, which
   * is the whole reason it exists separately from `pendingWork()`.
   *
   * `working` is not derivable from the facet statuses alone. A facet is `pending` when any
   * provider owes it an answer, so `pending` and "somebody is still trying" look identical
   * from outside -- but a facet whose provider was REFUSED by the outbound gate is also
   * `pending` while nobody is working on it at all. Reporting the provider count directly
   * means the client stops when the work stops rather than when a clock says so.
   *
   * `problems` names the PLUGIN, so a reader who sees a pane missing can be told which
   * addon to blame and which author to tell, and knows to go and grep the log for the
   * message this deliberately does not carry.
   */
  workState(entity: FacetEntity): { working: number; facets: FacetName[]; problems: FacetProblem[] } {
    const owed = this.outstanding(entity);
    const problems: FacetProblem[] = [];

    // CURRENT rows, not usable ones: a failure recorded under a superseded config version
    // is a fact about a plugin we have already replaced, and its provider is in `owed`
    // right now. Reporting it would name an author whose next answer is already in flight.
    for (const row of this.rowsFor(entity.tconst, "current").values()) {
      for (const r of row) {
        if (r.outcome !== "failed") continue;
        problems.push({
          pluginId: r.plugin_id,
          facet: r.facet as FacetName,
          // A row written before the column existed has no code, and `error` is the
          // honest generalisation: something went wrong and the log knows what.
          reason: (r.reason as FacetProblem["reason"]) ?? "error",
        });
      }
    }

    return { working: owed.length, facets: [...new Set(owed.map((p) => p.facet))], problems };
  }

  /**
   * Record one provider's answer, at the freshness the LADDER picked for it.
   *
   * The `freshness` column holds the effective class rather than the claimed one, so a
   * row always explains its own expiry: `settled` beside a 90-day expiry reads, whereas
   * the `moving` both shipped providers claim for `ratings` beside the same 90 days does
   * not. What the provider claimed is an input to that decision, not a fact about the row.
   */
  private write(
    entity: FacetEntity,
    provider: RegisteredProvider,
    outcome: FacetOutcome,
    data: unknown,
    claimed: FreshnessClass,
    reason: FailureReason | null = null,
  ): void {
    const now = this.now();
    const subject = { year: entity.year, latestKnownDate: scheduleHorizonOf(provider.facet, data) };
    const freshness = classFor(provider.facet, claimed, subject, now);

    this.store.putFacetContribution({
      entity_id: entity.tconst,
      facet: provider.facet,
      plugin_id: provider.pluginId,
      config_version: this.registry.configVersionOf(provider.pluginId),
      outcome,
      data: outcome === "ok" ? JSON.stringify(data) : null,
      freshness,
      resolved_at: new Date(now).toISOString(),
      expires_at: expiryFor(outcome, freshness, now),
      reason,
    });
  }
}

/** When this row stops counting, as an ISO string, or null for never. */
function expiryFor(outcome: FacetOutcome, freshness: FreshnessClass, now: number): string | null {
  if (outcome === "failed") return new Date(now + FAILED_TTL_MS).toISOString();

  const ttl = FRESHNESS_TTL_MS[freshness];
  if (outcome === "empty") return new Date(now + (ttl ?? EMPTY_IMMUTABLE_TTL_MS)).toISOString();
  return ttl === null ? null : new Date(now + ttl).toISOString();
}

/*
  `withTimeout` used to live here, and its own doc comment named the defect it carried:
  "The promise itself keeps running." It rejected the wrapper and abandoned the work, so
  the provider held its socket, its answer was discarded when it finally arrived, and the
  `inFlight` lock was released while the call was still in flight -- which let the next
  reader start a SECOND call to the same upstream for the same title.

  Replaced by cockatiel's `timeout(ms, TimeoutStrategy.Aggressive)`, which aborts the
  signal the provider is handed rather than only ceasing to wait. Do not reintroduce a
  hand-rolled race here: an unabortable timeout is a leak wearing a limit's clothes.
*/
