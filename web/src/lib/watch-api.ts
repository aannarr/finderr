/**
 * The client half of watch state: read where the reader stopped, and tell the server as they go.
 *
 * > [!IMPORTANT] NOTHING HERE THROWS, and that is for the player's sake
 * > The writer runs on a timer inside a playing video and the readers decide a resume point. A
 * > failed write, an unreachable server or a body of the wrong shape must cost a missing resume
 * > point, never an exception thrown into the player. So every reader answers `null` for "could
 * > not tell" -- distinct from a successful answer that holds nothing.
 *
 * The shapes and `isFinished` come from `src/lib/watch-progress.ts`, which is import-free by
 * contract precisely so this file can take its VALUE as well as its types: there is one threshold
 * and no browser copy to drift from it.
 */

import type { WatchEntry, WatchHistoryPage, WatchState, WatchWrite } from "../../../src/lib/watch-progress";

export { isFinished } from "../../../src/lib/watch-progress";
export type { WatchEntry, WatchHistoryPage, WatchState, WatchWrite };

const watchUrl = (tconst: string) => `/api/watch/${encodeURIComponent(tconst)}`;

/** Shallow: only what a caller will dereference. A cast is not a check -- see `isSessionsReport`. */
function isEntry(v: unknown): v is WatchEntry {
  const e = v as WatchEntry | null;
  return (
    !!e &&
    typeof e.tconst === "string" &&
    typeof e.positionSec === "number" &&
    typeof e.durationSec === "number" &&
    typeof e.finished === "boolean"
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The resume point and every episode's state for one title. Null when the server could not say. */
export async function getWatch(tconst: string): Promise<WatchState | null> {
  try {
    const res = await fetch(watchUrl(tconst));
    if (!res.ok) return null;
    const body = (await readJson(res)) as WatchState | null;
    if (!body || !Array.isArray(body.episodes) || (body.resume !== null && !isEntry(body.resume)))
      return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Store a position. Returns the entry as stored, or null -- which includes a caller with no
 * account behind it, whom the server answers 204 because there is nobody to store it for.
 */
export async function putWatch(tconst: string, body: WatchWrite): Promise<WatchEntry | null> {
  try {
    const res = await fetch(watchUrl(tconst), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || res.status === 204) return null;
    const entry = await readJson(res);
    return isEntry(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Store a position from a page that is going away -- `pagehide`, a tab close.
 *
 * `sendBeacon` is the only request a browser promises to deliver after the page is gone, and it
 * can only POST. The body goes as `text/plain` because that is what keeps the request simple
 * (no preflight to be abandoned mid-unload); the server parses JSON whatever the type says.
 * When there is no beacon, or the browser declines to queue it, a `keepalive` fetch is the
 * fallback. Returns whether the beacon took it.
 */
export function beaconWatch(tconst: string, body: WatchWrite): boolean {
  const payload = JSON.stringify(body);
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    if (
      typeof nav?.sendBeacon === "function" &&
      nav.sendBeacon(watchUrl(tconst), new Blob([payload], { type: "text/plain;charset=UTF-8" }))
    ) {
      return true;
    }
  } catch {
    // A beacon that throws is a beacon that did not queue; fall through.
  }
  void fetch(watchUrl(tconst), {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
  return false;
}

/** Forget one episode, or the whole title when `at` is omitted. True when the server accepted it. */
export async function deleteWatch(
  tconst: string,
  at?: { season: number; episode: number },
): Promise<boolean> {
  const query = at ? `?season=${at.season}&episode=${at.episode}` : "";
  try {
    const res = await fetch(`${watchUrl(tconst)}${query}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

/** One page of the reader's plays, newest first. Null when the server could not say. */
export async function getHistory(
  opts: { limit?: number; offset?: number } = {},
): Promise<WatchHistoryPage | null> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const query = params.size > 0 ? `?${params}` : "";
  try {
    const res = await fetch(`/api/watch/history${query}`);
    if (!res.ok) return null;
    const body = (await readJson(res)) as WatchHistoryPage | null;
    if (!body || !Array.isArray(body.entries) || typeof body.hasMore !== "boolean") return null;
    return body.entries.every(isEntry) ? body : null;
  } catch {
    return null;
  }
}
