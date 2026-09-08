/**
 * What playback costs this box: bytes handed out, and CPU the ffmpeg CHILDREN burned, over a
 * rolling window and per session.
 *
 * The operator question is *"what is playback costing this box right now, and what did the
 * last few plays cost"*. `/api/health` answers neither: it reports process-wide rss and CPU at
 * the instant you ask, with no history and no attribution.
 *
 * > [!IMPORTANT] BYTES HANDED OUT, NEVER BYTES WATCHED, and the label must not blur the two
 * > A viewer who seeks away discards buffered segments this meter has already counted. That is
 * > the right number for *"what did this box push"* and the wrong number for *"what did
 * > somebody watch"*, so nothing here is ever called `watched`.
 *
 * > [!IMPORTANT] THE CPU IS THE ffmpeg CHILDREN. `process.cpuUsage()` CANNOT ANSWER THIS
 * > This process also serves the render path, the API, the image proxy and every scan job, so
 * > its own CPU number includes all of that -- a graph built on `runtime-stats.ts` would answer
 * > a different question and look plausible doing it. What lands here is each child's own
 * > `rusage`, taken once when it exits (see `SpawnedProcess.cpuMillis` in
 * > `transcode-session.ts`), so a box with nothing transcoding reports exactly zero however
 * > busy the process is. `transcode-meter.test.ts` pins that.
 *
 * ## Two windows, because there are two questions
 *
 * The RING is two hours of 30-second slices and answers "what is happening now" -- it is what
 * the chart draws. The SESSION TABLE is cumulative for the life of each session and survives
 * long after that session has left the ring, which is what answers "what did the last few
 * plays cost". Neither survives a restart, and that is the correct trade for an operator
 * glance rather than an audit log: history in a file would be a second durable store for a
 * number nobody bills on.
 *
 * ## The instrument's own cost
 *
 * The rule this epic is built on applies to the thing doing the measuring, so it is measured.
 * On an M1 Max, 2026-09-08, warm, timed with `Bun.nanoseconds()` over 5M and 20k calls
 * respectively:
 *
 * | | |
 * |---|---|
 * | `served()`, the per-segment charge | **49 ns** |
 * | `report()`, the whole 240-slice window plus the session table | **2.6 us** |
 *
 * A copy-mode segment takes 70-80 ms to produce, so the accounting is around one millionth of
 * the work it accounts for. It allocates nothing after the first call for a session either: the
 * ring is three typed arrays fixed at construction and a slice that has rolled off the far end
 * is overwritten rather than swept, so a session serving ten thousand segments costs exactly as
 * much memory as one serving a single segment.
 *
 * > [!NOTE] There is NO SAMPLING TIMER, and the card that asked for one was reasoning about a
 * > design that had already been replaced
 * > A timer is what turns a GAUGE into a rate. Every input here is already a DELTA -- one
 * > segment's size, one ffmpeg's rusage -- so the bucket can be picked at record time, which is
 * > cheaper (no wakeups on an idle box), more accurate (no aliasing against a sampling
 * > interval) and exactly what `cost-meter.ts`, named on the card as the precedent, already
 * > does. The card's own reason for wanting a timer -- "per-segment accounting is a counter
 * > increment" -- is satisfied by this: `served()` IS the counter increment, and the bucket it
 * > lands in is arithmetic on the clock rather than a second pass over the sessions.
 * >
 * > The mechanism below is `cost-meter.ts`'s self-expiring ring with one thing added: a slice
 * > can be read back IN ORDER, which a chart needs and a rate limiter does not. That is why it
 * > is a second implementation rather than a shared one; collapsing them means giving the rate
 * > limiter an ordered read it has no use for. See the follow-up card named in this module's
 * > history if the third caller ever shows up.
 */

import { NOT_AN_EPISODE } from "./media-file";

/** How long one slice of the chart covers. */
const SLICE_MS = 30_000;

/**
 * How many slices the ring holds -- two hours at `SLICE_MS`.
 *
 * Two hours because that is roughly one film, which is the unit an operator thinks in, and 240
 * points is about as many as a chart this wide can draw distinctly. The whole ring is three
 * `Float64Array`s of this length: **5.8 kB, fixed at construction**, on a container capped at
 * 1.5 GB against a 1.9 GB index.
 */
const SLICES = 240;

/**
 * How many sessions keep a row.
 *
 * The session table outlives the ring, so it is the half that could grow without a bound.
 * Thirty-two is four times `MAX_SESSIONS`, which makes it several playbacks of history without
 * ever being a list somebody has to page through.
 *
 * On overflow the LEAST RECENTLY ACTIVE row is dropped rather than the cheapest, which is the
 * opposite of `cost-meter.ts`'s rule and deliberately so: that meter drops the cheapest because
 * an attacker rotating addresses must not be able to evict the record of their own spend. This
 * one is a history, not a defence, and in a history the oldest thing is what nobody is looking
 * at.
 */
const MAX_TRACKED = 32;

/** What was being played, so a cost has a title rather than only a session id. */
export interface PlayedMedia {
  tconst: string;
  /** `NOT_AN_EPISODE` for a film. */
  season: number;
  /** `NOT_AN_EPISODE` for a film. */
  episode: number;
}

/** One slice of the window. Bytes handed out and child CPU burned inside it. */
export interface CostSlice {
  bytes: number;
  cpuMs: number;
}

/** Everything one session has cost since it started. */
export interface SessionCost {
  id: string;
  media: PlayedMedia;
  bytes: number;
  cpuMs: number;
  startedAt: string;
  /** When this session last had a segment served or a transcode charged to it. */
  lastAt: string;
  /** Whether the session manager still holds it. Supplied by the caller -- see `report`. */
  running: boolean;
}

export interface TranscodeCostReport {
  /** Epoch ms at which the NEWEST slice begins. Every earlier one is `sliceSeconds` before it. */
  at: number;
  sliceSeconds: number;
  windowSeconds: number;
  /**
   * Oldest first, contiguous, zero-filled, always exactly the full window.
   *
   * No per-slice timestamp: they are evenly spaced by construction, so 240 of them would be
   * 240 copies of one piece of arithmetic the reader can do from `at` and `sliceSeconds`.
   */
  slices: CostSlice[];
  /** The sum of `slices`, so nothing has to add them up to state the headline. */
  window: CostSlice;
  /** Biggest spender first, capped at `MAX_TRACKED`. */
  sessions: SessionCost[];
  /**
   * Sessions whose row was evicted to keep the table bounded.
   *
   * Reported because their bytes are still in `window` and in the ring -- the machine really
   * pushed them -- so the rows can sum to less than the total, and a reader who cannot see
   * why would read that gap as a bug. Same honesty `cost-meter.ts`'s `report` states.
   */
  evicted: number;
  /**
   * Whether anything has EVER been recorded in this process.
   *
   * What tells "nothing has played" apart from "nothing is measuring", which look identical on
   * a chart and want opposite reactions from an operator.
   */
  measured: boolean;
}

interface Tracked {
  media: PlayedMedia;
  bytes: number;
  cpuMs: number;
  startedAt: number;
  lastAt: number;
}

export interface TranscodeMeterOptions {
  now?: () => number;
}

export class TranscodeMeter {
  /** Bytes per slot, indexed by absolute slice number mod `SLICES`. */
  private readonly bytes = new Float64Array(SLICES);
  private readonly cpuMs = new Float64Array(SLICES);
  /** The absolute slice number each slot currently holds, so a stale slot reads as zero. */
  private readonly slot = new Float64Array(SLICES).fill(-1);
  private readonly tracked = new Map<string, Tracked>();
  private readonly now: () => number;
  private evicted = 0;
  private everRecorded = false;

  constructor(opts: TranscodeMeterOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Register a session and what it is playing, before anything is charged to it.
   *
   * Idempotent, because sessions JOIN: two viewers of one film share one session id and both
   * of their starts arrive here. Re-registering must not reset a running session's totals.
   */
  open(sessionId: string, media: PlayedMedia): void {
    if (this.tracked.has(sessionId)) return;
    const at = this.now();
    this.evictOldest();
    this.tracked.set(sessionId, { media, bytes: 0, cpuMs: 0, startedAt: at, lastAt: at });
  }

  /**
   * Charge bytes handed out to a session.
   *
   * Called with the file's DECLARED size, never with a length counted off the body: the segment
   * route is zero-copy and reading it to measure it would undo the property that lets a
   * transcoder live beside a render path. See `serveFromSession` in `playback-routes.ts`.
   */
  served(sessionId: string, bytes: number): void {
    this.charge(sessionId, bytes, 0);
  }

  /** Charge one finished ffmpeg's own CPU to the session that caused it. */
  burned(sessionId: string, cpuMs: number): void {
    this.charge(sessionId, 0, cpuMs);
  }

  private charge(sessionId: string, bytes: number, cpuMs: number): void {
    if (!(bytes > 0) && !(cpuMs > 0)) return;
    const at = this.now();
    const slice = Math.floor(at / SLICE_MS);
    const i = ((slice % SLICES) + SLICES) % SLICES;
    // A slot still holding an OLDER slice is history that has rolled off the far end of the
    // window, so it is overwritten rather than added to. That is what makes the ring
    // self-expiring with no sweep, no timer and no allocation.
    if (this.slot[i] !== slice) {
      this.slot[i] = slice;
      this.bytes[i] = 0;
      this.cpuMs[i] = 0;
    }
    this.bytes[i] += bytes;
    this.cpuMs[i] += cpuMs;
    this.everRecorded = true;

    const row = this.tracked.get(sessionId);
    if (!row) return;
    row.bytes += bytes;
    row.cpuMs += cpuMs;
    row.lastAt = at;
  }

  /**
   * What an operator sees.
   *
   * `running` is INJECTED rather than tracked here, because whether a session still exists is
   * the session manager's fact and a meter keeping its own copy would be free to disagree with
   * the thing that actually reaps them.
   */
  report(running: (sessionId: string) => boolean): TranscodeCostReport {
    const newest = Math.floor(this.now() / SLICE_MS);
    const oldest = newest - (SLICES - 1);
    const slices: CostSlice[] = [];
    const window: CostSlice = { bytes: 0, cpuMs: 0 };
    for (let slice = oldest; slice <= newest; slice++) {
      const i = ((slice % SLICES) + SLICES) % SLICES;
      const live = this.slot[i] === slice;
      const bytes = live ? (this.bytes[i] ?? 0) : 0;
      const cpuMs = live ? (this.cpuMs[i] ?? 0) : 0;
      slices.push({ bytes, cpuMs });
      window.bytes += bytes;
      window.cpuMs += cpuMs;
    }

    const sessions = [...this.tracked]
      .map(([id, row]) => ({
        id,
        media: row.media,
        bytes: row.bytes,
        cpuMs: Math.round(row.cpuMs),
        startedAt: new Date(row.startedAt).toISOString(),
        lastAt: new Date(row.lastAt).toISOString(),
        running: running(id),
      }))
      .sort((a, b) => b.bytes - a.bytes || b.cpuMs - a.cpuMs);

    return {
      at: newest * SLICE_MS,
      sliceSeconds: SLICE_MS / 1000,
      windowSeconds: (SLICES * SLICE_MS) / 1000,
      slices,
      window: { bytes: window.bytes, cpuMs: Math.round(window.cpuMs) },
      sessions,
      evicted: this.evicted,
      measured: this.everRecorded,
    };
  }

  private evictOldest(): void {
    while (this.tracked.size >= MAX_TRACKED) {
      let victim: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, row] of this.tracked) {
        if (row.lastAt < oldest) {
          oldest = row.lastAt;
          victim = id;
        }
      }
      if (victim === null) return;
      this.tracked.delete(victim);
      this.evicted++;
    }
  }
}

/**
 * How a played thing is named on screen: `tt0111161` or `tt0903747 S02E07`.
 *
 * Here rather than in the browser because it is the one rule that turns the `NOT_AN_EPISODE`
 * sentinel into words, and that sentinel is a server fact -- a client re-deriving it would be a
 * second reader of `-1 means film`.
 */
export function mediaLabel(media: PlayedMedia): string {
  if (media.season === NOT_AN_EPISODE && media.episode === NOT_AN_EPISODE) return media.tconst;
  const season = String(Math.max(0, media.season)).padStart(2, "0");
  const episode = String(Math.max(0, media.episode)).padStart(2, "0");
  return `${media.tconst} S${season}E${episode}`;
}
