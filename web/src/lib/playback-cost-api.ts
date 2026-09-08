/**
 * `/api/admin/playback/cost`, as the operator screen reads it.
 *
 * A NARROW MIRROR of `src/lib/transcode-meter.ts`, for the same reason `playback-types.ts`
 * copies the plan and `health-api.ts` copies part of the health payload: importing the real
 * type would pull a server module into this bundle. That file is the owner; when a field moves,
 * it is the one to read.
 *
 * > [!IMPORTANT] THE BODY IS VALIDATED, NEVER CAST, and the last file that got this wrong took
 * > the video down
 * > `fetchSessions` used to `as SessionsReport` whatever came back with a 200, and a body of
 * > another shape -- a proxy's courtesy page, a rolled-back server, a redirect that landed on
 * > JSON -- reached the panel as a report with no array in it and threw inside the player's
 * > tree. This screen has the same exposure one surface over: an admin graph that can break the
 * > admin screen is the same defect. So the parse below asks for exactly what the screen will
 * > dereference, and anything else is a refusal in words rather than an exception.
 */

/** Bytes handed out and ffmpeg CPU burned inside one slice of the window. */
export interface CostSlice {
  bytes: number;
  cpuMs: number;
}

/** What was being played. `NOT_AN_EPISODE` -- `-1` -- in both fields means a film. */
export interface PlayedMedia {
  tconst: string;
  season: number;
  episode: number;
}

export interface SessionCost {
  id: string;
  media: PlayedMedia;
  bytes: number;
  cpuMs: number;
  startedAt: string;
  lastAt: string;
  running: boolean;
}

export interface PlaybackCostReport {
  /** Epoch ms at which the NEWEST slice begins. Every earlier one is `sliceSeconds` before it. */
  at: number;
  sliceSeconds: number;
  windowSeconds: number;
  /** Oldest first, contiguous, zero-filled, always exactly the full window. */
  slices: CostSlice[];
  window: CostSlice;
  sessions: SessionCost[];
  /** Rows dropped to keep the table bounded. Their bytes are still in `window`. */
  evicted: number;
  /** Whether anything has EVER been measured -- "idle" and "not instrumented" look identical. */
  measured: boolean;
}

const isSlice = (v: unknown): v is CostSlice => {
  const s = v as CostSlice | null;
  return typeof s?.bytes === "number" && typeof s?.cpuMs === "number";
};

/**
 * Whether a parsed body really is a cost report.
 *
 * Structural and shallow on purpose: it asks only what the screen will actually dereference,
 * which is what keeps it from refusing a server that has ADDED a field. The per-session rows are
 * checked because they are mapped over and their `media` is read.
 */
function isCostReport(body: unknown): body is PlaybackCostReport {
  const r = body as PlaybackCostReport | null;
  if (!r || typeof r.sliceSeconds !== "number" || typeof r.windowSeconds !== "number") return false;
  if (!Array.isArray(r.slices) || !r.slices.every(isSlice)) return false;
  if (!isSlice(r.window) || !Array.isArray(r.sessions)) return false;
  return r.sessions.every((s) => typeof s?.id === "string" && typeof s?.media?.tconst === "string");
}

/**
 * Read it.
 *
 * THROWS rather than answering null, unlike `fetchSessions`. The difference is what the caller
 * can do about it: the player's stats panel is an aside beside a running video and must degrade
 * to "unknown", while this screen IS the report -- so a failure here has to be shown, and
 * `useAsyncData` renders a thrown message as the section's error line.
 *
 * The 404 gets its own sentence because it is not really an error: `/api/admin/*` answers a
 * non-admin with one, so this is the most likely way an ordinary reader arrives here.
 */
export async function getPlaybackCost(): Promise<PlaybackCostReport> {
  const res = await fetch("/api/admin/playback/cost");
  if (res.status === 404 || res.status === 401) {
    throw new Error("this is an administrator's page -- are you still signed in?");
  }
  if (!res.ok) throw new Error(`the server did not answer (${res.status})`);
  const body: unknown = await res.json().catch(() => null);
  if (!isCostReport(body)) throw new Error("the server answered with something that is not a cost report");
  return body;
}
