/**
 * Choosing which of the server's addresses to fetch this session's media from, and changing
 * our mind when one stops answering.
 *
 * The server ADVERTISES candidates (`src/lib/stream-endpoints.ts`); it cannot know which of
 * them this browser can reach, because it cannot see the NAT, the VPN or the firewall in
 * between. So the question is settled here, the only way it can be: by trying.
 *
 * ## Two mechanisms, and they answer different questions
 *
 * **`electEndpoint` -- which address works at all.** A staggered race, in the shape RFC 8305
 * gives Happy Eyeballs: ask the best candidate, and if it has not answered in a moment ask
 * the next one too, and take whoever answers first. This is what makes it safe for the server
 * to advertise a LAN address to a client that turns out to be on the far side of the
 * internet -- an unroutable private address does not fail fast, it hangs until a SYN timeout,
 * and a strictly ordered walk would stall the player for ten seconds before trying anything
 * else. The probe is the MASTER PLAYLIST: a few hundred bytes that exercise DNS, TCP, TLS,
 * CORS and the token in one request.
 *
 * **`EndpointRing` -- which address to use for the next request, and what to do when it
 * fails.** One pinned choice, rotated on failure. That is the per-segment half: HLS segments
 * are independent GETs, so a dead path costs one retry rather than the session.
 *
 * > [!IMPORTANT] SEGMENTS ARE NOT RACED, and that is a bandwidth decision rather than an
 * > oversight
 * > Firing every segment at three candidates would triple the traffic of a video stream for
 * > the whole of its length, to buy something the retry already buys -- the card's own
 * > statement of the value is *"a dead path costs one segment retry, not the session"*. The
 * > race is spent once, on a payload measured in bytes, where it settles the only question
 * > that needed a race.
 */

/** Mirrors `StreamEndpoint` in `src/lib/stream-endpoints.ts`. */
export interface StreamEndpoint {
  base: string;
  family: "v4" | "v6" | null;
  kind: "lan" | "wan";
  source: "static" | "interface" | "upnp";
}

/**
 * How long to wait for one candidate before ALSO trying the next.
 *
 * 250 ms is RFC 8305's Connection Attempt Delay, chosen there for the same trade: long enough
 * that a healthy first candidate almost always wins on its own, short enough that a black
 * hole does not hold the player. A working LAN path answers a 300-byte playlist in single
 * digit milliseconds, so in the ordinary case nothing but the first probe is ever sent.
 */
export const STAGGER_MS = 250;

/**
 * How many candidates a race may have in flight. Beyond this they queue behind the stagger.
 *
 * Not a limit on the LIST -- every candidate is still tried -- only on how many probes are
 * outstanding at once, so a deployment advertising eight addresses does not open eight
 * connections to answer one question.
 */
export const RACE_WIDTH = 3;

/** Probe one base. True means it served the playlist; anything else is false. */
export type EndpointProbe = (base: string, signal: AbortSignal) => Promise<boolean>;

/** Injected so a test drives the stagger rather than waiting for it. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const timerSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    });
  });

/**
 * The first candidate that answers, or null when none of them does.
 *
 * The losers are ABORTED as soon as there is a winner, which is what keeps the cost of the
 * race to "one extra playlist, sometimes" rather than one per candidate. A null answer is not
 * an error: the caller falls back to the origin the page was loaded from, which is by
 * definition reachable, and playback proceeds exactly as it did before this feature existed.
 */
export async function electEndpoint(
  bases: readonly string[],
  probe: EndpointProbe,
  opts: { staggerMs?: number; sleep?: Sleep } = {},
): Promise<string | null> {
  if (bases.length === 0) return null;
  const staggerMs = opts.staggerMs ?? STAGGER_MS;
  const sleep = opts.sleep ?? timerSleep;
  const race = new AbortController();

  /** One candidate's whole life: wait its turn, probe, answer with itself or with null. */
  const attempt = async (base: string, waitMs: number): Promise<string | null> => {
    if (waitMs > 0) await sleep(waitMs, race.signal);
    if (race.signal.aborted) return null;
    return (await probe(base, race.signal).catch(() => false)) ? base : null;
  };

  try {
    for (let start = 0; start < bases.length; start += RACE_WIDTH) {
      const wave = bases.slice(start, start + RACE_WIDTH);
      const winner = await firstTruthy(wave.map((base, i) => attempt(base, i * staggerMs)));
      if (winner) return winner;
    }
    return null;
  } finally {
    // Whatever happened, nothing is still probing when this returns -- including on the
    // path where a winner was found while three others were mid-flight.
    race.abort();
  }
}

/**
 * The first non-null result, without waiting for the rest.
 *
 * `Promise.any` is the near miss and it is the wrong tool: it settles on the first FULFILMENT,
 * and every attempt above fulfils -- with null when it failed. Rejecting instead, to make
 * `any` fit, would mean building a rejection for the ordinary case of a candidate that simply
 * is not reachable.
 */
function firstTruthy(attempts: Promise<string | null>[]): Promise<string | null> {
  return new Promise((resolve) => {
    let outstanding = attempts.length;
    for (const attempt of attempts) {
      void attempt.then((result) => {
        if (result) resolve(result);
        else if (--outstanding === 0) resolve(null);
      });
    }
  });
}

/**
 * The candidate every request goes to, and the rotation when one stops answering.
 *
 * A RING rather than a list with an index: a demoted candidate goes to the BACK rather than
 * being deleted, so a path that was down when the film started is tried again once everything
 * else has also failed. Paths come back -- a wifi handover, a VPN reconnect -- and a client
 * that permanently struck one off would spend the rest of a two-hour film on its worst route.
 */
export class EndpointRing {
  private order: string[];

  /**
   * @param bases Candidate origins, best first. An empty list is legal and means every
   *   request goes to the page's own origin, which is what a deployment with no advertised
   *   endpoints does.
   * @param token The session's stream token, appended to every retargeted URL. A segment may
   *   be fetched from an origin the page was not loaded at, and the session cookie is
   *   `SameSite=Lax`, so the cookie is not sent there -- see `Session.token` on the server.
   */
  constructor(
    bases: readonly string[],
    private token: string | null = null,
  ) {
    this.order = [...bases];
  }

  /**
   * Swap in a freshly minted token, for every request from here on.
   *
   * The token expires long before a feature film does, so the player renews it mid-playback
   * from the app's own origin -- see `STREAM_TOKEN_TTL_MS` on the server for why it is short
   * and why only that origin may renew it. The requests already in flight keep the old value
   * and are covered by the server's grace window, so there is nothing to cancel here.
   */
  setToken(token: string): void {
    this.token = token;
  }

  /** The origin the next request should go to, or null for "wherever the page came from". */
  current(): string | null {
    return this.order[0] ?? null;
  }

  /** Every candidate in current preference order. For diagnostics and for tests. */
  candidates(): readonly string[] {
    return this.order;
  }

  /**
   * Make `base` the current choice, if it is one of ours.
   *
   * How a race result is recorded. Silently ignores a base that is not a candidate rather
   * than adding it: the list is the server's statement of where this session can be served
   * from, and a client inventing an entry would be guessing at a deployment it cannot see.
   */
  pin(base: string): void {
    if (!this.order.includes(base)) return;
    this.order = [base, ...this.order.filter((b) => b !== base)];
  }

  /**
   * Move `base` to the back, so the next request goes somewhere else.
   *
   * **A demotion for a base that is no longer current does nothing**, and that guard is what
   * stops a burst of failures rotating past a good candidate: several segments are usually in
   * flight at once, so one dead path produces several errors, and acting on every one of them
   * would advance the ring several places for a single fault.
   */
  demote(base: string): void {
    if (this.order.length < 2 || this.order[0] !== base) return;
    this.order = [...this.order.slice(1), base];
  }

  /**
   * The URL to actually fetch, for a URL naming a file of this session.
   *
   * IDEMPOTENT, and it has to be: hls.js retries by calling its loader again with the URL the
   * previous attempt already rewrote, so this is handed its own output as often as it is
   * handed a fresh relative name. Only the PATH survives -- origin and query are rebuilt --
   * which makes a second pass produce the same answer as the first.
   *
   * Anything that is not a playback path is returned untouched. The loader this serves is a
   * general hls.js loader and must stay correct for a URL that was never ours.
   */
  retarget(url: string, pageOrigin: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url, pageOrigin);
    } catch {
      return url;
    }
    if (!parsed.pathname.startsWith(PLAYBACK_PATH_PREFIX)) return url;
    return streamUrl(this.current() ?? pageOrigin, parsed.pathname, this.token);
  }
}

/**
 * One session file, at one address, with the credential that admits it.
 *
 * The single owner of "how a playback URL is assembled", so the race probe and the loader
 * cannot disagree about it -- a probe that authenticated differently from the loader would
 * elect an address that then failed on its first real request.
 */
export function streamUrl(base: string, path: string, token: string | null): string {
  const url = new URL(path, base);
  if (token) url.searchParams.set(TOKEN_PARAM, token);
  return url.href;
}

/**
 * The path prefix everything this ring may retarget sits under.
 *
 * A copy of the server's route, and the pair is checked by
 * `web/src/lib/stream-endpoints.test.ts` against the URL the start response hands back --
 * which is the only place the two could drift and the only place a drift would be silent.
 */
const PLAYBACK_PATH_PREFIX = "/api/play/s/";

/** Mirrors `TOKEN_PARAM` in `src/server/playback-routes.ts`. */
const TOKEN_PARAM = "t";
