/**
 * The cache-header audit, as assertions.
 *
 * The bug these defend against is not a crash and does not show up in a log: a response that
 * depends on the session cookie, stored under a key that does not include it, and handed to
 * the next reader. `/api/title/:tconst` carries `arrLink` -- a Radarr address -- for an admin
 * and `null` for everybody else; `/api/requests` carries `requested_by` on the same terms.
 * Both were `private, max-age=N` with no `Vary`, which tells a browser it may reuse either
 * body for any later request to that URL.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  type CachePolicy,
  cacheHeaders,
  IMMUTABLE_PUBLIC,
  NO_STORE,
  PER_SESSION_REVALIDATED,
  perSession,
  REVALIDATED,
  sharedPerSession,
} from "./cache-policy";
import { json } from "./json-response";

/**
 * Every policy in the vocabulary, and whether its body depends on who asked.
 *
 * Keyed by `CachePolicy["kind"]` on purpose: a variant added to the union without an entry
 * here is a TYPE error, so a new policy cannot reach production without somebody stating
 * whether it is reader-dependent. That statement is what the invariant below tests.
 */
const EVERY_POLICY = {
  "no-store": { policy: NO_STORE, dependsOnReader: false },
  "per-session": { policy: perSession(60), dependsOnReader: true },
  "per-session-revalidated": { policy: PER_SESSION_REVALIDATED, dependsOnReader: true },
  "shared-per-session": { policy: sharedPerSession(600), dependsOnReader: true },
  // Same bytes for everybody: an icon, the manifest, an unhashed asset.
  revalidated: { policy: REVALIDATED, dependsOnReader: false },
  // Content-addressed bytes: a poster keyed by a title id, a hashed bundle.
  "immutable-public": { policy: IMMUTABLE_PUBLIC, dependsOnReader: false },
} satisfies Record<CachePolicy["kind"], { policy: CachePolicy; dependsOnReader: boolean }>;

describe("cacheHeaders", () => {
  /**
   * THE RULE THE WHOLE FILE EXISTS FOR.
   *
   * `private` bars a SHARED cache from storing a response. It says nothing about the
   * browser's own cache, which is the one two readers of the same device share -- so a
   * storable answer whose body depends on the session needs the session in the cache key,
   * and `Vary: Cookie` is what puts it there.
   */
  test("a storable, reader-dependent answer is keyed on the session cookie", () => {
    for (const [kind, { policy, dependsOnReader }] of Object.entries(EVERY_POLICY)) {
      const headers = cacheHeaders(policy);
      const storable = headers["Cache-Control"] !== "no-store";
      const expected: string = dependsOnReader && storable ? "Cookie" : "none";
      expect({ kind, varies: headers.Vary ?? "none" }).toEqual({ kind, varies: expected });
    }
  });

  /**
   * The exact directives, so a change to one is a change somebody made on purpose.
   * `max-age=0, s-maxage=600` is the shape that lets Caddy hold a crawler's copy while
   * every browser still asks.
   */
  test("each policy spells the directives it means", () => {
    expect(cacheHeaders(NO_STORE)["Cache-Control"]).toBe("no-store");
    expect(cacheHeaders(perSession(30))["Cache-Control"]).toBe("private, max-age=30");
    expect(cacheHeaders(PER_SESSION_REVALIDATED)["Cache-Control"]).toBe("no-cache");
    expect(cacheHeaders(sharedPerSession(600))["Cache-Control"]).toBe("public, max-age=0, s-maxage=600");
    expect(cacheHeaders(REVALIDATED)["Cache-Control"]).toBe("no-cache");
    expect(cacheHeaders(IMMUTABLE_PUBLIC)["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });
});

describe("json", () => {
  /**
   * The posture `withAuth` takes about reachability, taken about storage: a route added
   * later is uncacheable by having been added. Before this default, a handler that simply
   * did not think about caching sent no `Cache-Control` at all, which leaves an
   * intermediary free to apply its own heuristic freshness to a per-reader body.
   */
  test("a route that says nothing gets no-store", () => {
    expect(json({ ok: true }).headers.get("Cache-Control")).toBe("no-store");
  });

  test("a route that asks for a session cache gets the Vary with it", () => {
    const res = json({ hits: [] }, { cache: perSession(60) });
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  /**
   * The policy is spread LAST. A route reaching for a hand-written header is the exact move
   * that produced the drift this card was filed for, so it loses.
   */
  test("a hand-written Cache-Control cannot override the policy", () => {
    const res = json({}, { headers: { "Cache-Control": "public, max-age=99999" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("everything else a route sends survives", () => {
    const res = json({ error: "too many" }, { status: 429, headers: { "Retry-After": "30" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

/**
 * ONE OWNER, ENFORCED. The audit is only worth what it stays worth: a route written next
 * month that hand-writes `Cache-Control` re-opens exactly the hole that was just closed,
 * and nothing else in the gate would notice.
 */
test("cache-policy.ts is the only server file that writes a Cache-Control", () => {
  const dir = new URL(".", import.meta.url).pathname;
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "cache-policy.ts" && !f.endsWith(".test.ts"))
    .filter((f) => readFileSync(`${dir}${f}`, "utf8").includes('"Cache-Control"'));
  expect(offenders).toEqual([]);
});
