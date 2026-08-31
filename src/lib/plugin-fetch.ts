/**
 * The only way a plugin reaches the network.
 *
 * A plugin declares `hosts: [...]` in its `meta` and core hands it a `fetch` that
 * refuses everything else. Two reasons this lives in core rather than in an allowlist
 * each plugin edits:
 *
 *   1. A shared constant is a one-line edit in a file no plugin owns, so two providers
 *      written in parallel collide on it. A declaration on the plugin is readable in
 *      the plugin file and cannot collide with anything.
 *   2. Courtesy to a third party -- an honest User-Agent, a timeout, and not hammering
 *      one host -- becomes a property of the host rather than something each plugin
 *      author has to remember. `api.radarr.video` and `skyhook.sonarr.tv` are Servarr's
 *      own infrastructure and we are an uninvited third party on them.
 *
 * This is NOT `ALLOWED_HOSTS` in `src/server/artwork.ts`. That gates the image byte
 * proxy, checked against a poster URL before streaming image bytes. Different job,
 * different data, deliberately not shared.
 */

import { type BulkheadPolicy, bulkhead } from "cockatiel";
import { type SamplerReport, Timings } from "./timings";

/**
 * What a plugin gets instead of the global `fetch`.
 *
 * Deliberately narrower than `typeof fetch`: the global carries a `preconnect` method
 * that has no meaning for a guarded, paced, host-checked call, and pretending to
 * implement it would be a lie about what this wrapper does.
 */
export type PluginFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Identify honestly, so a third party can see and throttle us rather than guess. */
export const PLUGIN_USER_AGENT = "finderr (self-hosted media request UI)";

export interface OutboundPolicy {
  userAgent: string;
  timeoutMs: number;
  /** Minimum gap between two calls to the SAME host, across every plugin. */
  minIntervalMsPerHost: number;
}

export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = {
  userAgent: PLUGIN_USER_AGENT,
  timeoutMs: 15_000,
  minIntervalMsPerHost: 250,
};

/**
 * A URL with its query string removed, which is the only form that may be logged.
 *
 * Some upstreams take their credential as a query parameter -- TMDB's `?api_key=` is the
 * one in the tree -- so a URL printed verbatim into an error message puts a live key in
 * the container log, and `FacetResolver` logs `err.message` on every provider failure.
 * Stripping the query costs the log nothing: the path already says which call failed.
 *
 * A string that is not a URL comes back unchanged. It cannot be carrying a query
 * parameter we would be leaking, and a caller reporting a malformed URL needs to see it.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** A plugin tried to reach somewhere it did not declare, or over plain http. */
export class OutboundHostError extends Error {
  constructor(
    readonly pluginId: string,
    readonly url: string,
    reason: string,
  ) {
    super(`plugin ${pluginId} may not fetch ${safeUrl(url)}: ${reason}`);
    this.name = "OutboundHostError";
  }
}

/**
 * Ask an upstream for JSON, with the difference that decides how long a wrong answer
 * sticks around.
 *
 * `null` means "this title is genuinely not there" -- a provider turns it into an empty
 * facet, which caches for weeks. Anything else THROWS, because `FacetResolver` caches a
 * throw for ten minutes: a 502 during somebody else's deploy must not blank a title's
 * cast until next month.
 *
 * In core rather than beside one plugin because it is the same contract for every
 * upstream, and a second copy would be the one that forgets to redact.
 */
export async function getJson<T>(fetch: PluginFetch, url: string): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${safeUrl(url)} answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Serialises calls per host so a burst of providers never fans out onto one third party.
 *
 * Shared by every plugin: pacing is a courtesy owed to the HOST, so two plugins hitting
 * the same host must queue behind each other rather than each keeping its own clock.
 * The clock and the sleep are injected so a test does not have to spend real seconds.
 */
export class HostPacer {
  private nextFreeAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = Bun.sleep,
  ) {}

  /** Resolves when it is this caller's turn on `host`, reserving the following slot. */
  async take(host: string): Promise<void> {
    const now = this.now();
    const free = Math.max(this.nextFreeAt.get(host) ?? 0, now);
    this.nextFreeAt.set(host, free + this.minIntervalMs);
    if (free > now) await this.sleep(free - now);
  }
}

/**
 * How many outbound calls this PROCESS may have in flight, and how many may wait.
 *
 * Shared by every plugin, like the pacer, and for the same reason: the limit is a property
 * of us, not of any one addon. Sized above the number of hosts we talk to so a single
 * slow host cannot starve the others, and well under anything that would look like a
 * crawl to a third party.
 *
 * > [!IMPORTANT] The REFUSAL is the point, not the queue
 * > An unbounded queue only moves the failure: instead of overloading the upstream we
 * > overload ourselves, and the reader gets facets four minutes late instead of an honest
 * > "not now". Past the bound this throws `BulkheadRejectedError`, which `FacetResolver`
 * > recognises and **writes no row for** -- overload is not an answer, and caching it as
 * > one would turn a busy second into a ten-minute suppression of a working provider.
 */
export const OUTBOUND_CONCURRENCY = 6;
export const OUTBOUND_QUEUE_LIMIT = 64;

/**
 * The process-wide gate, created once.
 *
 * A module-level singleton for the same reason `HostPacer` is passed to every plugin: a
 * per-plugin gate would cap each addon and cap nothing overall, so ten plugins would be
 * ten times the ceiling. `loadPlugins` builds one and hands it to every `createPluginFetch`;
 * this lazy fallback exists so a direct caller (a test, a one-off script) still gets a
 * bounded fetch rather than an unbounded one by omission.
 */
let processGate: BulkheadPolicy | undefined;
function sharedOutboundGate(): BulkheadPolicy {
  processGate ??= bulkhead(OUTBOUND_CONCURRENCY, OUTBOUND_QUEUE_LIMIT);
  return processGate;
}

/**
 * Where an outbound call's time actually went, per host.
 *
 * THREE NUMBERS, NOT ONE, and the split is the whole reason this exists. "TMDB took 900 ms"
 * is not a finding: it can mean the host was slow, or that we held the call behind five
 * others, or that `HostPacer` was spacing us at 250 ms and this was the third call in a
 * burst. Those have three different fixes -- ask them less, raise the ceiling, stop making
 * three serial calls -- and a single total cannot tell them apart.
 *
 *   - `waitGate` is OUR ceiling. Non-zero means we are the bottleneck.
 *   - `waitPace` is OUR courtesy. Non-zero means one title is making several calls to one
 *     host and paying 250 ms between each; collapsing them into one call is the fix.
 *   - `host` is THEIR latency, and the only part no amount of local cleverness improves.
 */
export class OutboundTimings {
  private readonly gate = new Timings();
  private readonly pace = new Timings();
  private readonly host = new Timings();

  record(hostname: string, sample: { waitGateMs: number; waitPaceMs: number; hostMs: number }): void {
    this.gate.add(hostname, sample.waitGateMs);
    this.pace.add(hostname, sample.waitPaceMs);
    this.host.add(hostname, sample.hostMs);
  }

  /** Per host: what the far end cost, and what we cost ourselves waiting to ask it. */
  report(): Record<string, { host: SamplerReport; waitGateMs: number; waitPaceMs: number }> {
    const out: Record<string, { host: SamplerReport; waitGateMs: number; waitPaceMs: number }> = {};
    for (const [hostname, host] of Object.entries(this.host.report())) {
      out[hostname] = {
        host,
        waitGateMs: this.gate.get(hostname)?.report().totalMs ?? 0,
        waitPaceMs: this.pace.get(hostname)?.report().totalMs ?? 0,
      };
    }
    return out;
  }
}

/**
 * Process-wide, for the same reason the gate is: the interesting question is what THIS
 * finderr is spending on each host, across every CALLER that talks to it. A per-plugin
 * tally would hide the case where two of them are queueing behind each other.
 *
 * "Every caller" is wider than "every plugin", and the difference will surprise a reader
 * of the report: the upcoming sync builds its own `createPluginFetch` and its boot-time
 * `/discover` walk lands under `api.themoviedb.org` too. So a call count well above the
 * number of titles anybody has opened is expected, not a leak. Attribute a host's traffic
 * with `facets.timing.providers` beside it, which counts only the facet path.
 */
let processTimings: OutboundTimings | undefined;
export function outboundTimings(): OutboundTimings {
  processTimings ??= new OutboundTimings();
  return processTimings;
}

export interface PluginFetchOptions {
  pluginId: string;
  /** Exactly the hosts this plugin declared. Anything else is refused. */
  hosts: readonly string[];
  pacer: HostPacer;
  policy?: Partial<OutboundPolicy>;
  /** Injected so tests never touch the network. */
  fetchImpl?: PluginFetch;
  /**
   * The shared concurrency gate. Omitted, a process-wide one is used.
   *
   * Injected in tests so a case can prove the refusal with a gate of 1 rather than
   * arranging 70 concurrent calls.
   */
  gate?: BulkheadPolicy;
  /** Where per-host latency is recorded. Omitted, the process-wide one is used. */
  timings?: OutboundTimings;
}

/**
 * Build the `fetch` handed to one plugin.
 *
 * Refusals throw rather than returning a failed Response: a plugin fetching an
 * undeclared host is a bug in the plugin, and the resolver already turns any throw into
 * "this provider contributed nothing" without touching the rest of the facet.
 */
export function createPluginFetch(opts: PluginFetchOptions): PluginFetch {
  const policy = { ...DEFAULT_OUTBOUND_POLICY, ...opts.policy };
  const allowed = new Set(opts.hosts.map((h) => h.toLowerCase()));
  const doFetch = opts.fetchImpl ?? fetch;
  const outbound = opts.gate ?? sharedOutboundGate();
  const timings = opts.timings ?? outboundTimings();

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    let target: URL;
    try {
      target = new URL(href);
    } catch {
      throw new OutboundHostError(opts.pluginId, href, "not a valid absolute URL");
    }
    // https only: these calls carry no credentials, but a plaintext hop is a place for
    // someone on the path to feed a plugin whatever answer they like.
    if (target.protocol !== "https:") {
      throw new OutboundHostError(opts.pluginId, href, `${target.protocol} is not allowed, https only`);
    }
    if (!allowed.has(target.hostname.toLowerCase())) {
      throw new OutboundHostError(opts.pluginId, href, `${target.hostname} is not in its declared hosts`);
    }

    const headers = new Headers(init?.headers);
    // Set, not append: a plugin does not get to lie about who is calling.
    headers.set("User-Agent", policy.userAgent);

    /*
      BOTH DEADLINES, NEVER WHICHEVER ONE THE CALLER HAPPENED TO PASS.

      This was `init?.signal ?? AbortSignal.timeout(policy.timeoutMs)`, which silently
      DROPPED the outbound timeout for any caller that supplied its own signal -- and since
      `FacetProvider` now hands providers a cancellation signal to pass here, that shape
      would have turned an encouraged practice into "this plugin no longer has a fetch
      timeout". `AbortSignal.any` takes whichever fires first, so a provider wiring up
      cancellation gains a deadline rather than trading one away.
    */
    const deadline = AbortSignal.timeout(policy.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;

    /*
      Gate FIRST, then pace, then fetch, and the order is the point.

      `HostPacer` spaces calls to one host and is a courtesy owed to that host; it caps
      nothing about us, because `take()` RESERVES a slot and then sleeps -- a thousand
      callers reserve a thousand slots and hold a thousand promises in memory until their
      turn arrives minutes later. Pacing before gating would let that queue form before
      anything could refuse it, which is the failure the gate exists to prevent.

      So the pacer's sleep happens INSIDE a gate slot, deliberately. Waiting for a host is
      outbound work in progress, and holding a slot while it happens is backpressure rather
      than waste: it is what stops a slow host quietly authorising unbounded new work.
    */
    /*
      The three marks below are placed so each interval measures ONE wait, which is what
      makes the split readable: `askedAt` before the gate, `admittedAt` the moment a slot
      was granted, `pacedAt` the moment the host's turn came round. A single `startedAt` at
      the top and a duration at the bottom would total the same milliseconds and answer
      none of the three questions.
    */
    const hostname = target.hostname.toLowerCase();
    const askedAt = performance.now();
    return outbound.execute(async () => {
      const admittedAt = performance.now();
      await opts.pacer.take(hostname);
      const pacedAt = performance.now();
      try {
        return await doFetch(target, { ...init, headers, signal });
      } finally {
        // In `finally` so a refused, aborted or failed call still records what it cost --
        // a host that times out at 15 s is exactly the one worth seeing in the report, and
        // recording only successes would hide it.
        timings.record(hostname, {
          waitGateMs: admittedAt - askedAt,
          waitPaceMs: pacedAt - admittedAt,
          hostMs: performance.now() - pacedAt,
        });
      }
    });
  };
}
