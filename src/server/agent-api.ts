/**
 * The API as an AGENT meets it: one credential, one document, two buckets.
 *
 * An agent key is not a session with a different header. It differs in four ways, and each
 * one is a decision rather than an omission:
 *
 * - **It carries its owner's authority MINUS admin, always.** `AuthService.principal` gives
 *   an agent principal the `user` role whatever its owner holds, so every existing
 *   role-gated surface refuses it without carrying a check of its own. The admin API also
 *   answers **404** rather than 403 -- the same refusal an ordinary session gets, so an
 *   agent key never becomes the oracle that tells its holder whether its owner is an admin.
 * - **It may not manage identity.** `/api/auth/*` is closed to it, so a key cannot mint,
 *   rotate or revoke a credential -- its own included. Rotation is a thing a PERSON does
 *   from a browser.
 * - **It is rate limited per KEY**, in addition to the per-IP limits everybody pays, and the
 *   two buckets are split on what the work costs us rather than on what it returns.
 * - **It waits.** See the blocking title read in `./index.ts`; the reasoning is there,
 *   beside the handler it justifies.
 *
 * > [!IMPORTANT] THE MANIFEST IS DERIVED, NEVER WRITTEN DOWN TWICE
 * > A hand-maintained markdown blob is a second owner of the API shape and rots on the
 * > first route change -- which is the whole failure this endpoint exists to avoid. So the
 * > operations below carry only what a route CANNOT say about itself (a sentence, a curl
 * > line, which bucket it belongs to), and everything else is read at view time from things
 * > that already own their fact: the live route table, the limiter instances, the config,
 * > and the key's own `read_only`. A route added later appears by having been added.
 */

import type { AgentKey, Principal } from "../lib/auth";
import type { RateLimiter } from "../lib/rate-limit";
import { cacheHeaders, NO_STORE } from "./cache-policy";
import { json } from "./json-response";
import { type HandlerWrap, wrapRoutes } from "./route-wrap";

/** Where an agent points its one bootstrap `curl`. A fixed, publicly known path. */
export const AGENT_MANIFEST_PATH = "/api/agent/manifest";

/** Where a PERSON creates, inspects and revokes their one key. Closed to the key itself. */
export const AGENT_KEY_PATH = "/api/auth/agent-key";

/**
 * How long a blocking title read waits before answering with what it has.
 *
 * From measurement rather than taste: cold titles settled at 417/422/1240 ms opened singly
 * and 1363/1520/1772/2027 ms in a burst (2026-08-31, the same numbers the browser's poll
 * cadence was built on). Five seconds clears every one of those with room for a slow
 * provider, and the ceiling stays UNDER the 15s outbound deadline in `plugin-fetch.ts` --
 * a wait longer than the providers are allowed to take is a wait that always loses first,
 * which is the useless case.
 */
export const AGENT_WAIT_MS = { default: 5_000, max: 12_000 } as const;

/** What a caller should expect a request to take. Stated once, quoted by the manifest. */
export const FULFILMENT_MINUTES = { min: 10, max: 30 } as const;

/**
 * How long THIS call may wait, from `?wait=`, clamped.
 *
 * The clamp is the point and it is why this is a function rather than a `Number.parseInt`
 * at the call site: an agent may ask for LESS than the default, and must not be able to ask
 * for more than the providers are allowed to take. Anything unparseable is the default,
 * because a caller who sent nonsense wanted the ordinary behaviour.
 */
export function agentWaitMs(url: URL): number {
  const raw = url.searchParams.get("wait");
  if (raw === null) return AGENT_WAIT_MS.default;
  const asked = Number.parseInt(raw, 10);
  if (Number.isNaN(asked)) return AGENT_WAIT_MS.default;
  return Math.min(Math.max(asked, 0), AGENT_WAIT_MS.max);
}

/** Which limiter a call is counted against. */
export type AgentBucket = "cheap" | "expensive";

/**
 * The operations that cost MORE than a local SQLite seek, keyed `METHOD path`.
 *
 * An enumerated set rather than a per-route annotation, because the default is already
 * guaranteed by something else: the governing rule in `./index.ts` is that the render path
 * touches nothing but local SQLite and local disk. So every other route is cheap by
 * construction, and this is the list of the three places that rule is deliberately broken.
 * A route added later is cheap by having been added, which is true until somebody writes a
 * handler that reaches the network -- and that is the edit at which they belong here.
 */
const EXPENSIVE_OPERATIONS: ReadonlySet<string> = new Set([
  // Real CPU over a 1.27M-row index. The same reason `searchLimiter` exists.
  "GET /api/search",
  // For an agent this BLOCKS on providers and holds a connection for its whole deadline.
  "GET /api/title/:tconst",
  // Starts a real download.
  "POST /api/requests",
  "POST /api/requests/episode",
  "POST /api/requests/season",
]);

export function agentBucket(path: string, method: string): AgentBucket {
  return EXPENSIVE_OPERATIONS.has(`${method.toUpperCase()} ${path}`) ? "expensive" : "cheap";
}

/**
 * The expensive operations THIS key may actually call, `METHOD path`.
 *
 * The manifest reads this instead of naming them in prose. A sentence listing them would be
 * a second copy of the set above -- and it would go on telling a read-only key about writes
 * it is refused, which is the drift this document exists to have none of.
 */
export function expensiveOperationsFor(key: { readOnly: boolean }): string[] {
  return [...EXPENSIVE_OPERATIONS].filter((op) => agentMayCall(op.split(" ")[0] ?? "", key)).sort();
}

/**
 * Path prefixes an agent key may never reach, whatever its owner's role.
 *
 * ONE OWNER for the rule, read by both halves that need it: the guard refuses these, and
 * the manifest never advertises them. Two lists would drift, and the direction they drift
 * in is a document promising an operation the guard refuses.
 */
const AGENT_DENIED_PREFIXES = [
  // Administration. A leaked admin agent key mints invites and deletes accounts.
  "/api/admin/",
  // Identity. A credential that can rotate or revoke credentials -- including its own --
  // is a credential that survives its owner noticing it leaked.
  "/api/auth/",
] as const;

export function agentMayReach(path: string): boolean {
  return !AGENT_DENIED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * A read-only key may GET and HEAD, and nothing else.
 *
 * Stated as a fact about the METHOD rather than as a list of write routes, so it cannot
 * miss one: a route added next month that writes is refused by having a method that writes.
 * A list would have to be remembered.
 */
export function agentMayCall(method: string, key: { readOnly: boolean }): boolean {
  if (!key.readOnly) return true;
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

// --- what the manifest says --------------------------------------------------

/** What a route cannot say about itself. Everything else is read from the live table. */
export interface AgentOperation {
  method: "GET" | "POST";
  /** The route-table pattern, VERBATIM. A test fails if it names a route that is not there. */
  path: string;
  summary: string;
  /** Curl, complete but for the origin. `$FINDERR_TOKEN` is the holder's own token. */
  example: string;
  /** Anything a caller gets wrong without being told. */
  notes?: string;
}

/**
 * The operations worth an example, in the order an agent meets them.
 *
 * NOT the allow-list -- `agentMayReach` is that, and the manifest lists everything else the
 * key can reach below these. This is the curated half: which routes deserve a sentence and
 * a copy-paste line, which is a judgement no route table can make for itself.
 */
export const AGENT_OPERATIONS: readonly AgentOperation[] = [
  {
    method: "GET",
    path: AGENT_MANIFEST_PATH,
    summary: "This document. Regenerated on every view, so it never goes stale.",
    example: `curl -H "Authorization: Bearer $FINDERR_TOKEN" {ORIGIN}${AGENT_MANIFEST_PATH}`,
  },
  {
    method: "GET",
    path: "/api/search",
    summary: "Fuzzy title search over the local index. Tolerates typos and partial titles.",
    example:
      "curl -H \"Authorization: Bearer $FINDERR_TOKEN\" \\\n  '{ORIGIN}/api/search?q=blade+runner&limit=10'",
    notes:
      "`q` is required. `limit` caps at 100. `genre`, `year`, `decade` and `kind` narrow it. " +
      "Every hit carries a `tconst` -- the IMDb id -- which is the id every other operation takes.",
  },
  {
    method: "GET",
    path: "/api/browse",
    summary: "The index as a filterable, sorted grid. What to call when there is no query.",
    example:
      "curl -H \"Authorization: Bearer $FINDERR_TOKEN\" \\\n  '{ORIGIN}/api/browse?genre=Drama&decade=1990&sort=votes&limit=20'",
    notes: "`limit` caps at 200. `offset` pages. An unknown `sort` falls back to the default.",
  },
  {
    method: "GET",
    path: "/api/discover",
    summary: "The front page: named shelves of titles, already decorated with library state.",
    example: `curl -H "Authorization: Bearer $FINDERR_TOKEN" {ORIGIN}/api/discover`,
  },
  {
    method: "GET",
    path: "/api/title/:tconst",
    summary: "Everything known about one title -- ratings, cast, seasons, where to watch.",
    example:
      "curl -H \"Authorization: Bearer $FINDERR_TOKEN\" \\\n  '{ORIGIN}/api/title/tt0083658?wait=5000'",
    notes:
      "THIS CALL WAITS. See “Waiting for facets” below -- it resolves and answers once, " +
      "rather than making you poll. `wait` is milliseconds and is clamped to the ceiling stated there.",
  },
  {
    method: "GET",
    path: "/api/requests",
    summary: "Requests and their status. `?mine=1` narrows it to the ones you asked for.",
    example: `curl -H "Authorization: Bearer $FINDERR_TOKEN" '{ORIGIN}/api/requests?mine=1'`,
    notes:
      "`status` moves `queued` -> `searching` -> `available`, and `error` is the failure. " +
      "Poll this to find out whether something arrived; there is nothing else to poll.",
  },
  {
    method: "POST",
    path: "/api/requests",
    summary: "Ask for a title. Returns 202 immediately; the download starts in the background.",
    example:
      'curl -X POST -H "Authorization: Bearer $FINDERR_TOKEN" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"tconst":"tt0083658"}\' \\\n' +
      "  {ORIGIN}/api/requests",
    notes:
      "`seasons` selects part of a series (`[1,2]`, or omit for all). A film has no seasons. " +
      "409 means it is already in the library. 429 means either the per-minute bucket or the " +
      "daily quota -- they are different refusals, see both sections below.",
  },
];

/** One bucket as the manifest reports it. `null` for either number means unlimited. */
export interface AgentBucketView {
  bucket: AgentBucket;
  limitPerMinute: number | null;
  remaining: number | null;
  windowSeconds: number;
}

/** One route the key can reach, as the live table declares it. */
export interface RouteSummary {
  path: string;
  /** Null for a bare handler, which Bun offers on every method. */
  methods: readonly string[] | null;
}

/** Everything the manifest states, as plain data. The renderer asks nobody anything. */
export interface AgentManifestView {
  origin: string;
  key: Pick<AgentKey, "createdAt" | "lastUsedAt" | "readOnly">;
  buckets: readonly AgentBucketView[];
  /** The DAILY title quota, which is a different refusal from a bucket. 0 = unlimited. */
  quota: { limitPerDay: number; usedToday: number; resetsAt: string };
  /** Read from the LIVE route table. What makes a new route appear by having been added. */
  reachable: readonly RouteSummary[];
}

/**
 * Every route in a live Bun table, with the methods it answers.
 *
 * A bare handler answers every method, which is `null` here rather than a guessed list --
 * writing `["GET"]` for it would be the manifest inventing a fact the table never stated.
 */
export function routeSummaries(routes: Record<string, unknown>): RouteSummary[] {
  return Object.entries(routes).map(([path, entry]) => {
    if (entry && typeof entry === "object" && !(entry instanceof Response)) {
      return { path, methods: Object.keys(entry as Record<string, unknown>).sort() };
    }
    return { path, methods: null };
  });
}

/**
 * The one block a person copies out of the account page and hands to an agent.
 *
 * A POINTER PLUS A CREDENTIAL AND NOTHING ELSE. It deliberately restates no operation, no
 * limit and no example: the manifest owns all of that, and a snippet that repeated any of
 * it would be exactly the hand-maintained second copy the manifest exists to prevent.
 *
 * A `curl` carrying an `Authorization` header rather than a bare URL, and that is not only
 * about logging: a bare URL is a thing a person pastes into a browser, a chat or an issue
 * without ever registering that they just published a credential. This reads as a secret to
 * anybody who looks at it, including the agent.
 */
export function bootstrapSnippet(origin: string, token: string): string {
  return [
    "You have access to finderr, a media request tool. Run this to learn what you can do:",
    "",
    `curl -H "Authorization: Bearer ${token}" ${origin}${AGENT_MANIFEST_PATH}`,
  ].join("\n");
}

function limitLine(v: AgentBucketView): string {
  const limit = v.limitPerMinute === null ? "unlimited" : `${v.limitPerMinute}`;
  const remaining = v.remaining === null ? "unlimited" : `${v.remaining}`;
  return `| \`${v.bucket}\` | ${limit} | ${v.windowSeconds}s | ${remaining} |`;
}

function operationSection(op: AgentOperation, origin: string): string {
  const lines = [
    `### \`${op.method} ${op.path}\``,
    "",
    op.summary,
    "",
    "```sh",
    op.example.replaceAll("{ORIGIN}", origin),
    "```",
  ];
  if (op.notes) lines.push("", op.notes);
  return lines.join("\n");
}

/**
 * The routes this key can reach that nobody wrote an example for.
 *
 * Derived from the LIVE table, which is what makes a route added later appear in the
 * document by having been added. Methods the key cannot call are REMOVED rather than listed
 * and disclaimed: a read-only manifest that names a write is one an agent will act on and be
 * refused for -- and because this list is derived, it would have named one without anybody
 * choosing to.
 */
function undescribedRoutes(view: AgentManifestView, described: ReadonlySet<string>): RouteSummary[] {
  return view.reachable
    .filter((r) => agentMayReach(r.path) && !described.has(r.path))
    .map((r) => ({
      path: r.path,
      methods: r.methods === null ? null : r.methods.filter((m) => agentMayCall(m, view.key)),
    }))
    .filter((r) => r.methods === null || r.methods.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The daily quota, which is a DIFFERENT refusal from a rate-limit bucket.
 *
 * Both answer 429 and they reset differently, so an agent that backs off from one while
 * waiting for the other wastes a day. Naming them separately is the whole job of this
 * section.
 *
 * It is spent by CREATING a request, so it cannot bite a key that may not create one: a
 * read-only key gets the one sentence that is true for it rather than a budget it can never
 * draw on.
 */
function quotaSection(view: AgentManifestView): string {
  if (view.key.readOnly) {
    return `## Daily title quota

Nothing here spends it: the quota is charged when a request is CREATED, and this key cannot
create one.`;
  }
  const line =
    view.quota.limitPerDay === 0
      ? "There is no daily title quota on this instance."
      : `**${view.quota.usedToday} of ${view.quota.limitPerDay}** titles used today. ` +
        `The count resets at ${view.quota.resetsAt} (00:00 UTC).`;

  return `## Daily title quota

**A different refusal from the rate limits, with different reset semantics.** The buckets
count CALLS per minute; this counts TITLES per UTC day, and it is only spent by a \`POST\`
that creates a new request. Both answer 429, so read the message: backing off from one while
waiting for the other wastes the whole day.

${line}`;
}

/**
 * What "I asked for it, is it here yet" looks like, and how long it takes.
 *
 * A read-only key gets the POLLING half and not the asking half: it can still watch a
 * request, and telling it how to make one would be telling it to do the single thing it is
 * refused.
 */
function requestSection(key: AgentManifestView["key"]): string {
  if (key.readOnly) {
    return `## Watching a request

This key cannot ask for a title. It can watch one: \`GET /api/requests?mine=1\` reports
\`status\`, which moves \`queued\` -> \`searching\` -> \`available\`, or \`error\`. Typical
fulfilment is ${FULFILMENT_MINUTES.min}-${FULFILMENT_MINUTES.max} minutes and can be much
longer for something obscure or unreleased, so poll about once a minute -- it is a
cheap-bucket call.`;
  }
  return `## How long a request takes

A \`POST /api/requests\` returns **202** as soon as it is enqueued -- that is not the
download finishing. Typical fulfilment is ${FULFILMENT_MINUTES.min}-${FULFILMENT_MINUTES.max}
minutes, and it can be much longer for something obscure or unreleased.

Poll \`GET /api/requests?mine=1\` and read \`status\`: \`queued\` -> \`searching\` ->
\`available\`, or \`error\`. Poll it at a sensible interval -- once a minute is plenty, and it
is a cheap-bucket call.`;
}

/**
 * Render the manifest for ONE key, at view time.
 *
 * Pure: it takes data and returns a string, so the test that pins "every advertised
 * operation is a real route" needs no server, and the route that calls it is the only thing
 * that has to know how to gather the numbers.
 */
export function renderManifest(view: AgentManifestView): string {
  const advertised = AGENT_OPERATIONS.filter(
    (op) => agentMayReach(op.path) && agentMayCall(op.method, view.key),
  );
  const other = undescribedRoutes(view, new Set(advertised.map((op) => op.path)));
  const expensive = expensiveOperationsFor(view.key)
    .map((op) => `\`${op}\``)
    .join(", ");

  return `# finderr agent API

You are talking to finderr at \`${view.origin}\` with an agent key. This document is
generated from the live route table every time you fetch it, so it describes the server you
are actually talking to rather than the one somebody documented once.

**This key is ${view.key.readOnly ? "READ-ONLY" : "read-write"}.** ${
    view.key.readOnly
      ? "Every request other than `GET` and `HEAD` is refused with 403, and the write operations are not listed below."
      : "It can ask for titles as well as read them."
  }
Created ${view.key.createdAt}${view.key.lastUsedAt ? `, last used ${view.key.lastUsedAt}` : ", never used before now"}.

## Authentication

Every call carries the key in a header:

\`\`\`
Authorization: Bearer <your key>
\`\`\`

**Never put it in a URL.** No route here accepts it as a query parameter or a path segment,
and a token in a URL ends up in an access log, a proxy, a browser history and a \`Referer\`
header.

The key carries its owner's authority **minus administration**. \`/api/admin/*\` answers 404
to it, and so does \`/api/auth/*\` -- a key cannot create, rotate or revoke a credential,
including itself. Ask the person who gave you the key to rotate it; that takes one click and
kills this token immediately.

## Rate limits

Per KEY, per minute, in memory. Two buckets, split on what the work costs the server:

| bucket | limit / min | window | remaining now |
|---|---|---|---|
${view.buckets.map(limitLine).join("\n")}

Expensive is ${expensive}. Everything else is cheap. Exceeding either bucket returns **429**
with a \`Retry-After\` header in seconds -- wait that long, do not retry immediately.

These limits are **in addition to** a per-address limit you also pay, so \`remaining\` is a
floor rather than a promise. The counters live in memory and reset when the server restarts,
which means the number above can go UP without you doing anything.

${quotaSection(view)}

## Operations

${advertised.map((op) => operationSection(op, view.origin)).join("\n\n")}

## Waiting for facets

\`GET /api/title/:tconst\` behaves differently for you than for a browser. A browser paints
the local row immediately and fills ratings, cast and seasons in behind it. **You get one
call and one answer**: the request resolves outstanding providers and waits for them, up to
\`wait\` milliseconds (default ${AGENT_WAIT_MS.default}, ceiling ${AGENT_WAIT_MS.max}).

When the deadline passes first, the answer is **partial and says so**. Read these two fields
before believing anything is absent:

- \`facets.<name>.status\` is \`ready\`, \`pending\`, \`empty\` or \`failed\`. **\`pending\` and
  \`empty\` are not the same fact.** \`empty\` means nobody has this datum for this title;
  \`pending\` means somebody still owes it. Reporting a \`pending\` rating as "this film has no
  rating" is a confident false statement.
- \`work.facets\` names every facet still outstanding, and \`work.problems\` names the plugin
  and a reason code for anything that already failed.

Asking again later is legitimate and cheap: whatever landed after your deadline was cached
on the way, so a second call usually answers instantly from local state.

${requestSection(view.key)}

## Everything else this key can reach

Listed because it exists in the route table, not because it was written down here. These
carry no example; read them if you need them.

${other.length === 0 ? "_Nothing._" : other.map((r) => `- \`${r.methods ? r.methods.join(", ") : "ANY"} ${r.path}\``).join("\n")}
`;
}

// --- the route ---------------------------------------------------------------

/**
 * What the manifest route needs, as functions rather than as services.
 *
 * Every one of these is a question somebody else already owns the answer to -- who is
 * calling, what key they hold, how much budget is left, what this origin is called, what the
 * quota says, what routes exist. Taking them as callbacks is what lets the route be tested
 * without a database, a limiter or a running server, and it is why nothing in this file
 * imports `Store` or `AuthStore`.
 */
export interface AgentManifestDeps {
  principal: (req: Request) => Principal | null;
  keyFor: (userId: string) => AgentKey | null;
  limiter: (bucket: AgentBucket) => RateLimiter;
  /** The origin as the CALLER reached it, so a dev checkout and production differ. */
  origin: (req: Request) => string;
  quota: (userId: string) => AgentManifestView["quota"];
  /** The live route table, read at call time -- this route is IN it. */
  routes: () => Record<string, unknown>;
}

/**
 * `GET /api/agent/manifest`: this server, described to the key that asked.
 *
 * ONLY an agent key. A browser session holds no key, so there is no budget to report and no
 * `read_only` to honour -- rendering a hypothetical manifest for one would be a second
 * document with different contents from the real one, which is the drift this endpoint
 * exists to have none of.
 *
 * NEVER CACHED: `remaining` is true for the instant it was read and no longer.
 */
export function agentManifestRoute(deps: AgentManifestDeps): (req: Request) => Response {
  return (req) => {
    const p = deps.principal(req);
    const user = p?.kind === "agent" ? p.user : null;
    const key = user ? deps.keyFor(user.id) : null;
    if (!user || !key) return json({ error: "this endpoint answers to an agent key" }, { status: 403 });

    const buckets: AgentBucketView[] = (["cheap", "expensive"] as const).map((bucket) => {
      const limiter = deps.limiter(bucket);
      return {
        bucket,
        // Zero is the limiter's own spelling of "unlimited"; `null` is this document's.
        limitPerMinute: limiter.limit > 0 ? limiter.limit : null,
        remaining: limiter.remaining(bucketKeyFor(bucket, user.id)),
        windowSeconds: Math.round(limiter.windowMs / 1000),
      };
    });

    const markdown = renderManifest({
      origin: deps.origin(req),
      key,
      buckets,
      quota: deps.quota(user.id),
      reachable: routeSummaries(deps.routes()),
    });

    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        ...cacheHeaders(NO_STORE),
      },
    });
  };
}

// --- the guard ---------------------------------------------------------------

/**
 * The limiter key for one bucket and one account.
 *
 * One owner, because the GUARD spends it and the MANIFEST reports what is left of it. Two
 * spellings would make the document confidently wrong about a budget it was not reading.
 * The prefixes matter: without them an account id that happened to look like an address
 * would share a bucket with that address.
 */
function bucketKeyFor(bucket: AgentBucket, userId: string): string {
  return `agent:${bucket}:${userId}`;
}

export interface AgentApiDeps {
  /** Resolves a request to a principal. The one owner of who is calling. */
  principal: (req: Request) => Principal | null;
  /** The limiter for a bucket. Held by the caller, so there is one instance per bucket. */
  limiter: (bucket: AgentBucket) => RateLimiter;
  log: (msg: string) => void;
}

/**
 * Close the agent surface: the denied prefixes, the read-only rule, and the two buckets.
 *
 * Wrapping the table rather than editing each handler, for the reason `withAuth` gives: a
 * route added later is governed by having been added, and exempting one is a visible edit
 * here rather than a check somebody forgot to write. It is INSIDE `withAuth`, so an
 * anonymous caller is still refused first and this only ever sees a caller we have named.
 *
 * A caller that is not an agent passes straight through and pays nothing.
 */
export function withAgentApi<T extends Record<string, unknown>>(routes: T, deps: AgentApiDeps): T {
  const wrap: HandlerWrap =
    (path, handler) =>
    (...args: unknown[]) => {
      const req = args[0] as Request;
      const call = () => (handler as (...a: unknown[]) => unknown)(...args);
      /*
        A request with no `Authorization` header cannot be an agent, and this is the whole
        reason the check is here rather than after resolving a principal. `principal()` reads
        the session row on every call, and this wrapper sits on EVERY route -- so without
        this line every browser request in the product would pay a session read that this
        guard has no use for.
      */
      if (!req.headers.get("authorization")) return call();

      const p = deps.principal(req);
      if (p?.kind !== "agent" || !p.agent || !p.user) return call();

      if (!agentMayReach(path)) {
        // 404, not 403, and the same body an ordinary session gets from the admin API: an
        // agent key must not become the oracle that tells its holder what its owner may do.
        deps.log(`agent key ${p.user.id} refused at ${path}`);
        return json({ error: "not found" }, { status: 404 });
      }

      if (!agentMayCall(req.method, p.agent)) {
        // A real reason, because it is actionable and discloses nothing: the holder already
        // knows the key exists, and the manifest already told them it is read-only.
        return json({ error: "this agent key is read-only" }, { status: 403 });
      }

      const bucket = agentBucket(path, req.method);
      const limiter = deps.limiter(bucket);
      // The KEY, never the address: one account behind several addresses would otherwise get
      // a fresh budget per address, which is the exact hole a limiter exists to close.
      const bucketKey = bucketKeyFor(bucket, p.user.id);
      if (!limiter.take(bucketKey)) {
        deps.log(`agent key ${p.user.id} rate limited on the ${bucket} bucket`);
        return json(
          { error: `too many ${bucket} calls` },
          { status: 429, headers: { "Retry-After": String(limiter.retryAfter(bucketKey)) } },
        );
      }
      return call();
    };

  return wrapRoutes(routes, wrap);
}
