/**
 * The one route Radarr and Sonarr push to, and the credentials that close it.
 *
 * `../lib/arr-webhook.ts` is the VOCABULARY -- what an arr's payload means and which status
 * it implies. This is the POLICY: who may call, how fast, which request row an event belongs
 * to, and what gets written. The split is the one `./diagnose-requests.ts` already makes
 * against `../lib/request-diagnostics.ts`, for the same reason: the interesting half should
 * be testable without an HTTP request in the room.
 *
 * > [!IMPORTANT] PUSH FOR SPEED, POLL FOR TRUTH
 * > `RequestWorker.reconcile` stays exactly as it was and must never be deleted in favour of
 * > this. A webhook that never arrives -- finderr restarting, a network blip, a connection an
 * > operator disabled -- would otherwise strand a request forever with nothing anywhere
 * > saying so. Everything here is an OPTIMISATION on a loop that already works, with the one
 * > exception of `manual_import`, which no poll can see.
 *
 * > [!CAUTION] This is the only route that accepts state changes without a session
 * > It has to be on `AuthService.publicPaths()`: an arr has no cookie. So the basic-auth
 * > password in `config.webhook` is the whole of its authentication, and an unset password
 * > means the route refuses every caller rather than accepting anonymous writes to somebody's
 * > request log. `lanOnly` narrows it further where the deployment allows.
 */

import { type ArrTitleEvent, type ArrWebhookEvent, nextStatusFor, parseArrWebhook } from "../lib/arr-webhook";
import { secretEquals } from "../lib/auth";
import type { Config } from "../lib/config";
import { clientKey, isPrivateAddress, RateLimiter } from "../lib/rate-limit";
import type { MediaRequest, RequestStatus, Store } from "../lib/store";
import { json } from "./json-response";

/**
 * The path, as one exported constant.
 *
 * Named rather than typed twice, because it has to appear in the route table AND in
 * `AuthService.publicPaths()` -- and a route that is in the first but not the second answers
 * 401 to the arrs while looking exactly like a broken integration. That pair has already
 * gone wrong once here; see `INDEX_GATE_PUBLIC_PATHS`.
 */
export const ARR_WEBHOOK_PATH = "/api/webhook/arr";

/**
 * Every refusal an unauthenticated caller can provoke says the same thing.
 *
 * The same disclosure rule the auth routes run on: "no password configured", "wrong
 * username" and "wrong password" are three different facts about this server, and answering
 * them separately turns the endpoint into an oracle. The log gets the real reason.
 */
const REFUSED = "that did not work";

export interface ArrWebhookDeps {
  /** Only what this module calls, so a test hands over an object literal. */
  store: Pick<Store, "getRequest" | "requestByArrId" | "updateRequest">;
  webhook: Config["webhook"];
  /**
   * `config.auth.trustProxy`, passed rather than read, because the source address is only
   * as honest as the deployment -- see the caution on `clientKey`. Both the rate-limit key
   * and the `lanOnly` check read through it, so they cannot come to different conclusions
   * about who is calling.
   */
  trustProxy: boolean;
  /** Reads the socket address. Bun's server provides it; tests pass a stub. */
  addressOf?: (req: Request) => string | null;
  log: (msg: string) => void;
  /** Injected so a test can drive the limiter's window without sleeping. */
  now?: () => number;
}

/** What one accepted webhook did, for the log line and the reply. */
interface Applied {
  event: ArrWebhookEvent["kind"];
  /** The request this was filed against, or null when no row matched. */
  tconst: string | null;
  /** The status written, or null when the event moved nothing. */
  status: RequestStatus | null;
}

export class ArrWebhookService {
  private readonly limiter: RateLimiter;
  private received = 0;
  private applied = 0;
  private refused = 0;

  constructor(private readonly deps: ArrWebhookDeps) {
    this.limiter = new RateLimiter(deps.webhook.ratePerMinute, 60_000, deps.now);
  }

  /**
   * What has arrived since boot, for `/api/health`.
   *
   * `received: 0` is the answer that matters: configuring the two Webhook connections is a
   * manual step on the arr side, and nothing else in this process would ever say it was
   * skipped -- the poller keeps working, so a webhook that was never saved looks exactly
   * like one that works. Three counters in memory, reset by a restart, which is the same
   * bargain `RateLimiter` and `RequestWorker.stats` already take.
   */
  stats(): { enabled: boolean; received: number; applied: number; refused: number } {
    return {
      enabled: !!this.deps.webhook.password,
      received: this.received,
      applied: this.applied,
      refused: this.refused,
    };
  }

  /**
   * One webhook: authenticate, parse, file, answer.
   *
   * ALWAYS 2xx once the caller is authenticated, including for an event finderr ignores and
   * for a title nobody requested. An arr treats a non-2xx as a delivery failure and will
   * mark the connection unhealthy -- so "we understood you and there was nothing to do" has
   * to be a 200, or the operator is sent hunting for a broken integration that works.
   */
  async handle(req: Request): Promise<Response> {
    const refusal = this.authenticate(req);
    if (refusal) {
      this.refused++;
      return refusal;
    }

    this.received++;
    const outcome = await this.apply(req);
    if (!outcome) return json({ error: "not an arr webhook payload" }, { status: 400 });
    if (outcome.status) this.applied++;
    return json({ ok: true, ...outcome });
  }

  /**
   * The three gates, in the order that discloses least.
   *
   * Rate limit first: it is the cheapest and it must apply to an attacker guessing the
   * password, not only to callers who got it right. Then the network check, then the
   * credentials.
   */
  private authenticate(req: Request): Response | null {
    const key = clientKey(req, this.deps.addressOf?.(req) ?? null, { trustProxy: this.deps.trustProxy });
    if (!this.limiter.take(key)) {
      this.deps.log(`arr webhook: rate limited ${key}`);
      return json(
        { error: "too many requests" },
        { status: 429, headers: { "Retry-After": String(this.limiter.retryAfter(key)) } },
      );
    }

    if (this.deps.webhook.lanOnly && !isPrivateAddress(key)) {
      this.deps.log(`arr webhook: refused ${key} -- not a private address, and lanOnly is set`);
      return json({ error: REFUSED }, { status: 403 });
    }

    if (!this.credentialsMatch(req)) {
      this.deps.log(`arr webhook: refused ${key} -- bad or missing credentials`);
      return json(
        { error: REFUSED },
        // The realm is what makes an arr's own basic-auth fields work rather than needing a
        // hand-written header; arrs send the credentials pre-emptively either way.
        { status: 401, headers: { "WWW-Authenticate": 'Basic realm="finderr"' } },
      );
    }
    return null;
  }

  /**
   * Does the caller's `Authorization: Basic` match what is configured?
   *
   * BOTH halves are compared in constant time and BOTH comparisons run before either is
   * read, because the password is a bearer secret an attacker can retry: a `&&` that
   * short-circuits on the username turns "is this user real" into a separate, faster answer.
   */
  private credentialsMatch(req: Request): boolean {
    const { username, password } = this.deps.webhook;
    // No password means no way in. Checked here rather than at construction so an operator
    // can see the refusals in the log instead of a route that silently is not there.
    if (!password) return false;
    const offered = basicCredentials(req.headers.get("authorization"));
    if (!offered) return false;
    const userOk = secretEquals(offered.username, username);
    const passOk = secretEquals(offered.password, password);
    return userOk && passOk;
  }

  /**
   * Read the body, find the request it is about, and write whatever the mapping says.
   *
   * Null only when the body is not an arr payload at all. An event about a title nobody has
   * requested is a perfectly ordinary thing for a household arr to send -- somebody added a
   * film in Radarr directly -- and is reported as `tconst: null` rather than as an error.
   */
  private async apply(req: Request): Promise<Applied | null> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return null;
    }

    const event = parseArrWebhook(body);
    if (!event) return null;
    if (event.kind === "test") {
      // Loud on purpose: this line is how an operator confirms the connection they just
      // configured in Radarr or Sonarr actually reaches finderr.
      this.deps.log("arr webhook: test received -- the connection works");
      return { event: "test", tconst: null, status: null };
    }
    if (event.kind === "ignored") return { event: "ignored", tconst: null, status: null };

    const request = this.requestFor(event);
    if (!request) return { event: event.kind, tconst: null, status: null };

    const status = nextStatusFor(event, request.status);
    if (!status) return { event: event.kind, tconst: request.tconst, status: null };

    // `error` goes with the status. A row coming back from `failed` still carries the
    // sanitised reason it failed, and leaving it would put a stale sentence next to a
    // request that is visibly working again.
    this.deps.store.updateRequest(request.tconst, { status, error: null });
    this.deps.log(`arr webhook: ${event.kind} -> "${request.title}" is ${status}`);
    return { event: event.kind, tconst: request.tconst, status };
  }

  /**
   * The request row an event belongs to: IMDb id first, the arr's own id second.
   *
   * The IMDb id is the key finderr's own table is built on, so it is tried first and is what
   * matches in the ordinary case. The fallback exists because a Radarr movie or a Sonarr
   * series may hold no IMDb id at all, and then the arr's row id is the only handle in the
   * payload -- it is the id `RequestWorker.process` wrote onto the row when it added the
   * title, so it matches exactly the requests finderr itself made.
   *
   * A match on IMDb id is REJECTED when the services disagree: an event from Sonarr about a
   * tconst finderr requested from Radarr is either a mis-parse or two instances sharing a
   * webhook, and writing a series event onto a film's row is worse than doing nothing.
   */
  private requestFor(event: ArrTitleEvent): MediaRequest | null {
    if (event.imdbId) {
      const byImdb = this.deps.store.getRequest(event.imdbId);
      if (byImdb) return byImdb.service === event.service ? byImdb : null;
    }
    if (event.arrId !== null) return this.deps.store.requestByArrId(event.service, event.arrId);
    return null;
  }
}

/**
 * `Authorization: Basic <base64>` as a username and a password, or null.
 *
 * Split on the FIRST colon only: a password may legitimately contain one, and splitting on
 * every colon would quietly truncate it -- refusing a caller who sent exactly the right
 * secret, with a 401 that says nothing about why.
 */
function basicCredentials(header: string | null): { username: string; password: string } | null {
  const match = /^basic\s+(\S+)$/i.exec(header?.trim() ?? "");
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}
