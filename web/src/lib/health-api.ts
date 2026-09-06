/**
 * `/api/health`, as the operator dashboard reads it.
 *
 * > [!IMPORTANT] There is no new endpoint behind this file, and there did not need to be
 * > `/api/health` already answers with the FULL detail payload to an admin SESSION -- the
 * > server computes `detailed` from `principal(req)?.role === "admin"` and accepts a cookie
 * > or the system bearer key indifferently. Every doc in the repo demonstrates it with
 * > `curl -H "Authorization: Bearer $ADMIN_API_KEY"`, which reads as though the key were the
 * > only way in; it never was. The gap this file closes is that nothing DREW it.
 *
 * A NARROW MIRROR, not the whole payload. `HealthDeps` on the server carries a dozen more
 * blocks -- awards, upcoming, the search log, the front-page tiers -- and typing them here
 * would be a second copy of a shape this page does not render. What is declared below is
 * exactly what `ServerHealth` draws, and the fields are all optional-by-nullability where the
 * server says they can be absent, so an older container answering a newer bundle degrades to
 * a missing line rather than to a thrown render.
 *
 * The server-side owner of every one of these shapes is `src/server/health.ts`. When a field
 * moves, that file is the one to read.
 */

/** What the last in-place index swap did. `null` until the daily refresh has run once. */
export interface IndexReload {
  /** FALSE is the field worth alerting on: a promoted index would not answer, so we kept the old one. */
  ok: boolean;
  swapped: boolean;
  at: string;
  ms: number;
  reason?: string;
  canary?: { passed: number; total: number; ratio: number };
}

/**
 * Where the page-cache prefault got to, what it kept, and what it was asked for.
 *
 * `state` says which of six situations this is -- `src/server/live-index.ts` owns the
 * vocabulary and the reasons. `ok: false` is `failed` or `partial`: it RAN and did not
 * deliver the file. `last.residentMb` far below `readMb` is a different problem again -- it
 * ran and the memory cap took most of it back -- which is why both numbers are drawn.
 */
export interface IndexWarm {
  /** Mirrors `WarmState`. Widened to `string` would lose the exhaustive render; keep it in step. */
  state: "off" | "pending" | "running" | "done" | "partial" | "failed";
  ok: boolean;
  last: { readMb: number; ms: number; residentMb: number | null; error?: string } | null;
  tuning: {
    budgetMb: number;
    budgetSource: string;
    mmapMb: number;
    cacheMb: number;
    prefault: boolean;
  } | null;
}

/** One request slow enough to have kept its arguments. See `src/lib/slow-log.ts`. */
export interface SlowRequest {
  /** Epoch milliseconds, so "just now" is distinguishable from "before the last deploy". */
  at: number;
  /** The route PATTERN, never a filled-in path. */
  label: string;
  ms: number;
  /** What made this call this one -- a query, a filter, an id. Bounded on write. */
  detail: string;
}

export interface ServerHealthPayload {
  index: {
    rows: number;
    builtAt: string | null;
    reload: IndexReload | null;
    warm: IndexWarm | null;
  };
  library: { radarr: number; sonarr: number; episodes: number };
  plex: { items: number; machineId: string | null };
  services: { radarr: boolean; sonarr: boolean; prowlarr: boolean };
  /** Each addon and the hosts core will let it fetch -- its whole outbound surface. */
  plugins: { loaded: { id: string; hosts: string[] }[] };
  facets: { rows: number; images: number; pruned: number };
  runtime: {
    uptimeSeconds: number;
    rss: number;
    cgroup: { current: number; limit: number | null; ratio: number | null } | null;
  };
  timings: { slow: SlowRequest[] };
}

/**
 * Read it.
 *
 * Its own tiny fetch rather than `auth-api`'s `get`: this endpoint answers `{ ok: true }` and
 * a 200 to a NON-admin instead of an error, so "the JSON has no `index` block" is the only
 * signal that the caller was not trusted with the detail -- and a helper that only throws on
 * `!res.ok` would hand the page an empty object with no explanation.
 */
export async function getServerHealth(): Promise<ServerHealthPayload> {
  const res = await fetch("/api/health");
  const parsed = (await res.json().catch(() => ({}))) as Partial<ServerHealthPayload>;
  if (!res.ok) throw new Error(`the server did not answer (${res.status})`);
  if (!parsed.index) throw new Error("the server answered without its detail -- are you still signed in?");
  return parsed as ServerHealthPayload;
}
