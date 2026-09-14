/**
 * One playback: a plan, a timeline per rendition, an output directory, and the rules that
 * stop it owning the machine.
 *
 * A session here does NOT hold a running ffmpeg. It holds the DECISION -- which file, cut
 * how, into which segments -- and makes each segment when a player asks for it. ffmpeg runs
 * for the length of one segment and exits. `hls-timeline.ts` owns the segmentation,
 * `playback-plan.ts` owns the argv, and this module owns the bookkeeping between them.
 *
 * **A segment belongs to a TRACK as well as to an index**, and a track is a KIND plus an
 * ORDINAL: a film with three audio tracks publishes three audio renditions, each cut on its
 * own grid -- see `hls-timeline.ts` for why the video and audio grids differ and what that
 * closes. Every question this module answers is asked per track, and the concurrency ceiling
 * and the disk cache are per track too. A rendition nobody has selected costs nothing at all:
 * no player fetches it, so no ffmpeg ever runs for it.
 *
 * Segments are handed out by the route with `Bun.file`, which is zero-copy, so **segment
 * bytes never enter the JS heap and the event loop pays a stat and an fd handoff per
 * segment** rather than megabytes. That is the whole reason a transcoder can live beside a
 * render path that must stay fast.
 *
 * ## Why the process is short-lived now, and what that bought
 *
 * The first version ran one long ffmpeg per session, paced to roughly realtime so it could
 * not encode a whole film for somebody who watched nine seconds. It worked, and it made
 * seeking impossible: a player can only seek inside the playlist, the playlist grew as
 * ffmpeg wrote, and pacing kept the end of it near the playhead on purpose.
 *
 * Producing one segment per request fixes that and deletes the pacing problem rather than
 * solving it. Nothing runs while a viewer is paused, a viewer who quits has bought the
 * segments they watched and one more, and a scrub to 01:20:00 costs exactly the segment at
 * 01:20:00. Measured on the NAS over the array 2026-09-08: **0.07-0.08 s for one ten-second
 * copy-mode segment**, deep into a 3.4 GB file.
 *
 * ## The two budgets, and why one number would be wrong
 *
 * The measured library splits cleanly into a cheap majority and an expensive minority:
 * remuxing a container and re-encoding one audio track costs under 5% of a core, while
 * re-encoding video costs most of a Celeron J4125. **A single "max sessions" number would
 * either strangle the cheap case or admit enough of the expensive one to take the box
 * down.** So there are two limits and `isExpensive(plan)` decides which one a session
 * spends -- see `EXPENSIVE_SESSIONS` and `MAX_SESSIONS`.
 *
 * > [!CAUTION] A SESSION IS KEYED BY ITS INPUTS, so two viewers of one thing cost one session
 * > The key is the resolved path, the plan and the encoder. Two clients asking for the same
 * > thing JOIN, and then share every segment either of them causes to be produced -- which
 * > is not merely thrift: two sessions over one output directory would have two ffmpegs
 * > racing to write the same segment file.
 * >
 * > The seek offset is NOT part of the key any more, and that is the shape of the whole
 * > change. It used to be, because a session was a position; a session is now a whole film
 * > and a position is just which segment gets asked for first.
 * >
 * > So a stop COUNTS HOLDERS. Every `start`, new or joined, hands its caller a viewer handle,
 * > and `stop(id, viewer)` ends the session only when the last handle is gone. It used to end
 * > it outright, and on the NAS on 2026-09-15 the first of three viewers to close the player
 * > killed the other two mid-segment. A stale or repeated handle is a no-op, because Stop and
 * > a `pagehide` beacon can both fire for one play; a stop with NO handle (a client older than
 * > this) ends only a session with at most one holder. A viewer who vanishes without a stop
 * > is the idle reaper's, exactly as before.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { secretEquals } from "./auth";
import type { EncoderChoice } from "./encoder";
import {
  initFileName,
  type PublishedTracks,
  RUN_INIT_NAME,
  segmentCount,
  segmentFileName,
  segmentRange,
  type Timeline,
  type Track,
  trackKey,
} from "./hls-timeline";
import { ffmpegArgs, isExpensive, type PlaybackPlan } from "./playback-plan";

/**
 * How many sessions may re-encode VIDEO at once.
 *
 * **Three, and it is now a benchmark rather than a guess.** It was two, chosen from the
 * hardware's known class before anything had ever run on that hardware, with a note asking
 * for exactly the measurement below.
 *
 * Measured on the deployment Synology (Celeron J4125, UHD 600, `h264_vaapi` via
 * intel-media-driver, 2026-09-08) against 60 s of 1080p HEVC Main 10 re-encoded to 720p h264:
 *
 * | concurrent sessions | wall clock for 60 s of film | vs realtime | CPU |
 * |---|---|---|---|
 * | 1 | 6.43 s | 9.3x | 0.70 of one core |
 * | 3 | 10.7 / 11.0 / 12.3 s | 4.9x (worst) | 1.25 of four cores |
 *
 * Three concurrent viewers each get frames 4.9x faster than they can watch them, which is the
 * property that matters -- a session slower than realtime is a session that buffers forever.
 * Per-session CPU barely moved (4.48 s to 5.06 s), so what they contend for is the
 * fixed-function encode block and not the four cores the render path needs: **2.75 of them
 * are still idle at three sessions**, which is rule four of this epic honoured with a number.
 *
 * FOUR IS NOT SHIPPED because four was not measured. The trend says it would land near 3.7x
 * and still work; the trend is not a benchmark, and this constant has already spent one
 * generation being a plausible number nobody had checked.
 */
export const EXPENSIVE_SESSIONS = 3;

/**
 * How many sessions may exist at all.
 *
 * The cheap case is a container rewrite plus one audio track, measured at 28.7x and 57x
 * realtime on an M1 Max over SMB -- so this bound is about file descriptors and disk, not
 * CPU. It is deliberately not generous: every session holds a temp directory.
 */
export const MAX_SESSIONS = 8;

/**
 * How many segments one RENDITION of one session may be producing at the same moment.
 *
 * Two, because a player asks for the initialisation segment and the first media segment
 * almost together and serialising those two is a visible delay. Past that it is
 * BACK-PRESSURE, and the case it exists for is the one the card named: a viewer dragging the
 * scrubber emits a seek per pointer move, and without a ceiling each one would spawn an
 * ffmpeg for a position the viewer has already left. A refused production is a 404, which is
 * what a player retries.
 *
 * **Per rendition rather than per session**, because a player now fetches video and audio in
 * parallel: one shared ceiling of two would be filled by the first segment of each track, and
 * the very next request -- the one the player makes before the first frame -- would be
 * refused. The two tracks contend for the disk rather than for each other's slots.
 */
export const SEGMENT_CONCURRENCY = 2;

/**
 * How many produced segments one RENDITION of a session keeps on disk.
 *
 * A full watch-through of a remuxed 4K film would otherwise leave the whole film in the data
 * directory -- gigabytes, for a viewer who has already passed it. The oldest production is
 * dropped once this many exist, and re-producing one costs the measured 0.08 s, so a rewind
 * past the window is cheap rather than broken.
 */
export const SEGMENT_CACHE = 10;

/**
 * How many segments past the one a player just asked for are produced in the background.
 *
 * hls.js asks for one fragment per rendition at a time and only once the previous one has
 * arrived, so a design that produces strictly on request serialises the whole warm-up behind
 * ffmpeg's start time -- and on the NAS the AUDIO rendition is the slow one: measured
 * 2026-09-15 on the J4125, a copy-mode title's video segment took 100-270 ms but its
 * EAC3-to-AAC audio segment 470-860 ms, so 60 s of media took 6.4-7.4 s to be in hand. Running
 * a few ahead turns the player's next request into a stat and an fd.
 *
 * **It is NOT back-pressure-free work, it is work outside the back-pressure BUDGET**: a
 * read-ahead run takes no `SEGMENT_CONCURRENCY` slot, so a scrub storm is refused exactly as
 * before, and it is bounded instead by running at most ONE background production per
 * rendition at a time. A request elsewhere moves the window, so a seek abandons whatever had
 * not started yet. Plex and Jellyfin get the same property from a transcoder that runs ahead
 * and throttles; this keeps seek-anywhere and short-lived processes.
 */
export const READ_AHEAD = 3;

/**
 * Read-ahead for a session that re-encodes video: ONE.
 *
 * A VAAPI segment costs about a second of wall clock on the J4125 and the encode block is
 * shared by every expensive session, so a deep window would spend it on media a viewer who
 * seeks never watches.
 */
export const READ_AHEAD_EXPENSIVE = 1;

/** How long one segment production may take before it is killed. */
export const SEGMENT_TIMEOUT_MS = 45_000;

/** No client has asked for a segment in this long -- the session is abandoned. */
export const IDLE_REAP_MS = 60_000;

/**
 * Nothing lives past this, touched or not.
 *
 * A client that keeps polling forever is indistinguishable from a healthy viewer, so the
 * idle reaper alone cannot bound the total. This is the backstop that makes the session
 * table finite under any client behaviour at all.
 */
export const HARD_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a stream token is accepted before the player has to ask the app for another.
 *
 * > [!IMPORTANT] THIS IS THE ONE CREDENTIAL THAT TRAVELS OVER PLAIN HTTP, so it is the one
 * > with a short clock
 * > A token is MINTED in a reply from the app's own origin -- HTTPS wherever there is a
 * > public name -- and then SPENT against whichever candidate answered the race, which on a
 * > home network is very often a plain-http LAN address. So it is observable on the wire in a
 * > way the session cookie never is, and the answer is to make the observation worth little:
 * > thirty minutes, one film, no account access, and a re-mint that only the app's own origin
 * > can perform.
 *
 * Thirty minutes rather than the length of a film: the player renews well inside the window
 * (`web/src/components/PlayHere.tsx`), so the length of the film is not the constraint -- how
 * long a captured token stays useful is.
 */
export const STREAM_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * How long the PREVIOUS token keeps working after a re-mint.
 *
 * Long enough to cover the requests already in flight when the swap happened, and no longer.
 * `SEGMENT_TIMEOUT_MS` is the honest bound on how old an outstanding request can be, so the
 * window is derived from it rather than being a second number to keep in step.
 */
export const TOKEN_GRACE_MS = SEGMENT_TIMEOUT_MS;

/** Grace between asking ffmpeg to stop and insisting. */
const SIGKILL_AFTER_MS = 2_000;

/**
 * Which segment's run is asked to write a rendition's initialisation segment, when nothing has.
 *
 * A FREE CHOICE, because every run of a rendition writes a byte-identical init -- and zero is
 * the one that is usually already made: `warmFirstSegments` produces segment 0 of the video and
 * the default audio rendition before the start request is even answered, so by the time a
 * player reads a playlist the init it names is on disk and no run happens here at all. It costs
 * one extra ffmpeg only for a rendition selected mid-film, once per session, and that run's
 * media segment is kept rather than thrown away.
 */
const INIT_FROM_SEGMENT = 0;

export class SessionRefused extends Error {
  constructor(readonly reason: "too-many" | "too-many-expensive") {
    super(reason);
  }
}

/** How much of one limit is spent. */
export interface Budget {
  used: number;
  max: number;
}

/**
 * What is running against each of the two limits.
 *
 * Reported rather than re-derived by a caller: the numerators live in this class and the
 * denominators are the constants above it, so anything that counted them itself would be a
 * second reading of the rule that decides whether a viewer is refused.
 */
export interface SessionBudgets {
  sessions: Budget;
  expensive: Budget;
}

export interface StartOpts {
  /** ALREADY resolved through `media-path.ts`. This module never validates a path. */
  input: string;
  plan: PlaybackPlan;
  /**
   * Every rendition this title publishes, in offer order, from `hls-timeline.ts`.
   *
   * Two grids, not one: video is cut on the source's keyframes while audio and subtitles get
   * a plain uniform grid, which is what stops the muxer dropping ~60 ms of sound at every
   * boundary.
   */
  tracks: PublishedTracks;
  /** Which encoder to use for a re-encode. From `chooseEncoder`, probed once at boot. */
  encoder?: EncoderChoice;
  /** Who asked, for the health report. Never used for a decision. */
  owner?: string;
}

export interface Session {
  id: string;
  /**
   * The bearer secret for THIS session's playlists and segments, and nothing else.
   *
   * > [!IMPORTANT] SEPARATE FROM `id` ON PURPOSE -- one is identity, the other is authority
   * > The id is a path component: it appears in logs, in `/api/play/sessions` and in an admin's
   * > URL bar, and it must stay safe to show. The token never leaves the reply to the caller
   * > that started the session. Conflating them would make every place that prints a session
   * > id a place that leaks the right to stream it.
   *
   * It exists because a segment may be fetched from an origin the page was not loaded from --
   * that is the whole of multi-homed playback -- and the session cookie is `SameSite=Lax`, so
   * a browser will not send it cross-origin. Relaxing the cookie instead would weaken the
   * credential that guards the entire application in order to serve one video.
   *
   * > [!IMPORTANT] MINTED ON THE APP'S OWN ORIGIN, CARRIED TO ANY OF THEM
   * > It is only ever produced in the reply to an authenticated request the app itself made
   * > -- which in a deployment with a public name is HTTPS -- and it is then spent against
   * > whichever candidate answers, which may be a plain-http LAN address. That asymmetry is
   * > the point, and it is why the token expires on its own clock rather than the session's:
   * > the thing that travels over plain http is short-lived and scoped to one film. See
   * `STREAM_TOKEN_TTL_MS`.
   */
  token: string;
  /**
   * The token this session used to have, honoured until `priorTokenUntil`.
   *
   * Rotation without a stall. Several segment requests are always in flight, and they carry
   * the token that was current when they were issued -- so cutting the old one dead at the
   * instant of a re-mint would fail every one of them, which the player would read as a dead
   * path and answer by rotating endpoints. A grace window costs nothing and removes the
   * entire failure mode.
   */
  priorToken: string | null;
  /** When `token` stops being accepted. Epoch ms. */
  tokenExpiresAt: number;
  /** When `priorToken` stops being accepted. Epoch ms; meaningless when `priorToken` is null. */
  priorTokenUntil: number;
  key: string;
  dir: string;
  input: string;
  plan: PlaybackPlan;
  /** Every rendition this session publishes, in offer order. */
  tracks: PublishedTracks;
  expensive: boolean;
  encoder?: EncoderChoice;
  startedAt: number;
  lastAccessAt: number;
  owner: string | null;
}

/** One running transcode, as this module needs to see it. */
export interface SpawnedProcess {
  kill(signal?: number): void;
  exited: Promise<number>;
  /**
   * CPU this ONE child actually burned, in milliseconds, read after it has exited.
   *
   * > [!IMPORTANT] THIS IS THE ONLY HONEST ANSWER TO "WHAT DOES TRANSCODING COST", and
   * > `process.cpuUsage()` is not it
   * > This process serves the render path, the API, the image proxy and every scan job, so its
   * > own CPU number is mostly not transcoding. A per-CHILD number is, and `TranscodeMeter` is
   * > built on nothing else.
   *
   * NARROWER THAN THE RUNTIME'S `rusage` ON PURPOSE: the manager needs one number, so widening
   * this to the whole `ResourceUsage` would make every fake spawner stub out context switches
   * and swap counts it has no opinion about.
   *
   * OPTIONAL, and absent is a real answer rather than a missing feature: a spawner that cannot
   * account for its children (a test fake standing in for ffmpeg, a runtime that does not
   * expose `rusage`) says so by not having it, and the meter then records nothing rather than
   * recording a zero that would read as "transcoding is free".
   */
  cpuMillis?(): number | null;
  /**
   * Everything the child wrote to stderr, once it has exited. Optional for the same reason as
   * `cpuMillis`: a fake that has nothing to say says so by not having it.
   */
  stderr?(): Promise<string>;
}

/** How much of a failed run's stderr reaches the log. ffmpeg's cause is on its LAST lines. */
const STDERR_TAIL_CHARS = 600;

/** Injected so tests need no ffmpeg. */
export type Spawner = (argv: string[]) => SpawnedProcess;

/**
 * `Bun.spawn`, plus the child's own CPU once it is reaped.
 *
 * `resourceUsage()` is `wait4`'s rusage, so it is exact rather than sampled and it works the
 * same on the Synology and on the dev Mac -- which is what makes per-pid `/proc` parsing
 * unnecessary. It would also have been WRONG here: this subsystem runs one short-lived ffmpeg
 * per segment (0.07-0.08 s for a copy-mode one, measured on the NAS), so a sampler walking
 * `/proc` once a second would miss almost every run and report a busy box as idle.
 *
 * `cpuTime.total` is BigInt MICROseconds, and it is only populated after the process has been
 * reaped -- hence "read after it has exited" on the interface. Anything falsy or unreadable
 * yields null, which the meter treats as "not known" rather than as zero.
 */
const defaultSpawner: Spawner = (argv) => {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  // Drained from the moment of spawn, not read after the exit: a pipe nobody reads fills at
  // 64 KB and then BLOCKS the child, which a run spewing decode errors would reach -- and the
  // segment timeout would then kill a run that was only waiting for us.
  const stderr = new Response(proc.stderr).text().catch(() => "");
  return {
    kill: (s) => proc.kill(s),
    exited: proc.exited,
    stderr: () => stderr,
    cpuMillis: () => {
      const micros = proc.resourceUsage()?.cpuTime?.total;
      return micros === undefined ? null : Number(micros) / 1000;
    },
  };
};

/** One finished transcode, and what it cost. Reported rather than kept -- see `ManagerOpts.onRun`. */
export interface SegmentRun {
  sessionId: string;
  /** CPU the ffmpeg child burned, in milliseconds. */
  cpuMs: number;
}

export interface ManagerOpts {
  /** Where session directories are made. Under the data dir in production. */
  root: string;
  spawn?: Spawner;
  now?: () => number;
  ffmpegPath?: string;
  /**
   * Told what each finished ffmpeg cost, so somebody else can keep the books.
   *
   * A NOTIFICATION rather than a meter this class holds: session bookkeeping and cost history
   * are two reasons to change, and a manager that owned both would have to be constructed with
   * a meter in every test that has no interest in one. `src/server/index.ts` wires it to
   * `TranscodeMeter.burned`.
   */
  onRun?: (run: SegmentRun) => void;
  /**
   * Where a FAILED run is reported, with its exit code and the tail of ffmpeg's stderr. A run
   * that succeeds says nothing: one line per segment would bury the one line that matters.
   */
  log?: (line: string) => void;
  /**
   * How deep to read ahead. Defaults to `READ_AHEAD` / `READ_AHEAD_EXPENSIVE`; a test pinning
   * one production per request passes zeros so its spawn counts stay about that alone.
   */
  readAhead?: { cheap: number; expensive: number };
}

/** Where a rendition's read-ahead is aimed: the segment last asked for, and the run after it. */
interface AheadWindow {
  /** The segment the player asked for most recently. Protected from eviction with the rest. */
  at: number;
  from: number;
  /** Inclusive, already clamped to the last segment -- `from > to` means nothing is left. */
  to: number;
}

/** One rendition's bookkeeping: what it is making, and what it has already made. */
interface TrackState {
  timeline: Timeline;
  /** Segment index -> the production in flight for it, so two requests cost one ffmpeg. */
  producing: Map<number, Promise<boolean>>;
  /** The subset of `producing` that is read-ahead, which spends no back-pressure slot. */
  background: Set<number>;
  /** Produced segment indices in the order they landed, for eviction. */
  produced: number[];
  /** Null until a player has asked for a segment of this rendition. */
  ahead: AheadWindow | null;
  /** Whether the one background loop this rendition may run is running. */
  aheadRunning: boolean;
}

/** Everything a session keeps that a caller has no business seeing. */
interface SessionState {
  session: Session;
  /** One entry per published rendition, keyed by `trackKey` -- a `Track` is not a map key. */
  byTrack: Map<string, TrackState>;
  /** Live children, so shutdown can kill what is running rather than orphaning it. */
  running: Set<ReturnType<Spawner>>;
  /** One handle per viewer holding this session; it ends when the last is released. */
  holders: Set<string>;
}

/** A session as one caller holds it: the shared session, and that caller's own handle on it. */
export interface Started {
  session: Session;
  /** Pass back to `stop` so releasing this viewer cannot end a stream another viewer shares. */
  viewer: string;
}

export class TranscodeSessions {
  private readonly states = new Map<string, SessionState>();
  private readonly byKey = new Map<string, string>();
  private readonly spawn: Spawner;
  private readonly now: () => number;
  private readonly ffmpeg: string;
  private readonly readAhead: { cheap: number; expensive: number };

  constructor(private readonly opts: ManagerOpts) {
    this.spawn = opts.spawn ?? defaultSpawner;
    this.now = opts.now ?? Date.now;
    this.ffmpeg = opts.ffmpegPath ?? "ffmpeg";
    this.readAhead = opts.readAhead ?? { cheap: READ_AHEAD, expensive: READ_AHEAD_EXPENSIVE };
  }

  /**
   * Start a session, or JOIN the one already serving exactly this thing.
   *
   * Cheap by construction: no process is started here. What it spends is a slot and a
   * directory, and what it refuses is a ninth viewer or a third re-encode.
   */
  start(o: StartOpts): Started {
    const key = sessionKey(o);
    const joined = this.byKey.get(key);
    if (joined) {
      const state = this.states.get(joined);
      if (state) {
        state.session.lastAccessAt = this.now();
        const viewer = crypto.randomUUID();
        state.holders.add(viewer);
        return { session: state.session, viewer };
      }
    }

    const expensive = isExpensive(o.plan);
    // Reap before refusing: an abandoned session must never keep a live viewer out.
    this.reap();
    if (this.states.size >= MAX_SESSIONS) throw new SessionRefused("too-many");
    if (expensive && this.expensiveCount() >= EXPENSIVE_SESSIONS) {
      throw new SessionRefused("too-many-expensive");
    }

    mkdirSync(this.opts.root, { recursive: true });
    const dir = mkdtempSync(join(this.opts.root, "sess-"));
    const at = this.now();
    const session: Session = {
      id: crypto.randomUUID(),
      // 122 bits from the platform CSPRNG, same strength as the id. Rotated rather than held
      // for the life of the session -- see `STREAM_TOKEN_TTL_MS`.
      token: crypto.randomUUID(),
      priorToken: null,
      priorTokenUntil: 0,
      tokenExpiresAt: at + STREAM_TOKEN_TTL_MS,
      key,
      dir,
      input: o.input,
      plan: o.plan,
      tracks: o.tracks,
      expensive,
      encoder: o.encoder,
      startedAt: at,
      lastAccessAt: at,
      owner: o.owner ?? null,
    };
    const byTrack = new Map<string, TrackState>();
    for (const published of o.tracks) {
      byTrack.set(trackKey(published.track), {
        timeline: published.timeline,
        producing: new Map(),
        background: new Set(),
        produced: [],
        ahead: null,
        aheadRunning: false,
      });
    }
    const viewer = crypto.randomUUID();
    this.states.set(session.id, { session, byTrack, running: new Set(), holders: new Set([viewer]) });
    this.byKey.set(key, session.id);
    return { session, viewer };
  }

  /** Mark a session as still wanted. Called on every playlist and segment read. */
  touch(id: string): Session | null {
    const state = this.states.get(id);
    if (!state) return null;
    state.session.lastAccessAt = this.now();
    return state.session;
  }

  get(id: string): Session | null {
    return this.states.get(id)?.session ?? null;
  }

  /**
   * Whether this secret may read this session's media right now.
   *
   * Lives HERE rather than in the route because the rule needs the clock, and the clock is
   * already injected into this class -- a route deciding expiry would need its own `now`, and
   * two clocks is how a test proves something the server does not do.
   *
   * `secretEquals` on both candidates unconditionally: returning early on a length mismatch
   * would leak which of the two matched, and checking the prior token only when the current
   * one failed would make the comparison count depend on the secret.
   */
  admitsToken(id: string, offered: string): boolean {
    const session = this.get(id);
    if (!session) return false;
    const at = this.now();
    const current = at < session.tokenExpiresAt && secretEquals(offered, session.token);
    const prior =
      session.priorToken !== null &&
      at < session.priorTokenUntil &&
      secretEquals(offered, session.priorToken);
    return current || prior;
  }

  /**
   * Issue a fresh token for a session and hand it back, keeping the old one alive briefly.
   *
   * The renewal half of `STREAM_TOKEN_TTL_MS`. Only ever reached through an
   * app-origin-authenticated route, which is what makes the new token's delivery as protected
   * as the first one's -- a re-mint reachable with the token itself would make the expiry
   * decorative, since a captured token could renew itself forever.
   *
   * Answers the SESSION rather than the token, so a caller that has to report the new token's
   * remaining life -- which is all of them -- does not go looking the session up again.
   * Null for a session that is gone, which the caller answers as a 404.
   */
  remintToken(id: string): Session | null {
    const state = this.states.get(id);
    if (!state) return null;
    const at = this.now();
    const session = state.session;
    session.priorToken = session.token;
    session.priorTokenUntil = at + TOKEN_GRACE_MS;
    session.token = crypto.randomUUID();
    session.tokenExpiresAt = at + STREAM_TOKEN_TTL_MS;
    return session;
  }

  list(): Session[] {
    return [...this.states.values()].map((s) => s.session);
  }

  expensiveCount(): number {
    return this.list().filter((s) => s.expensive).length;
  }

  /** Both limits and what is spent against them, for the admin surfaces that report them. */
  budgets(): SessionBudgets {
    return {
      sessions: { used: this.states.size, max: MAX_SESSIONS },
      expensive: { used: this.expensiveCount(), max: EXPENSIVE_SESSIONS },
    };
  }

  /**
   * The path of one rendition's segment `index`, producing it first if nobody has yet.
   *
   * Null means the caller should answer 404: no such session, no such rendition, no such
   * segment, ffmpeg failed, or too many productions are already in flight. Every one of those
   * is a state a player retries out of, which is why they share an answer.
   */
  segmentPath(id: string, track: Track, index: number): Promise<string | null> {
    // The request is started FIRST so its own production is spawned before any read-ahead run:
    // `produce` spawns synchronously, and the segment asked for is the one somebody is waiting on.
    const asked = this.published(id, track, index, segmentFileName(track, index));
    this.aimAhead(id, track, index);
    return asked;
  }

  /**
   * Point this rendition's read-ahead at the segments after `index`, and start its loop if idle.
   *
   * Only a SEGMENT request aims it -- never an init request, and never a rendition nobody
   * fetches, so subtitles cost nothing until a player switches them on. Moving the window is
   * the whole of cancellation: the loop re-reads it before every production, so segments queued
   * for a position the viewer has left are simply never started.
   */
  private aimAhead(id: string, track: Track, index: number): void {
    const state = this.states.get(id);
    const trackState = state?.byTrack.get(trackKey(track));
    if (!state || !trackState) return;
    const depth = state.session.expensive ? this.readAhead.expensive : this.readAhead.cheap;
    if (depth <= 0 || index < 0) return;
    const last = segmentCount(trackState.timeline) - 1;
    if (index > last) return;
    // Clamped to the timeline, so a window at the end of the film is empty rather than a run of
    // productions `segmentRange` would refuse one by one.
    trackState.ahead = { at: index, from: index + 1, to: Math.min(index + depth, last) };
    if (!trackState.aheadRunning) void this.runAhead(state, track, trackState);
  }

  /**
   * The ONE background loop a rendition may run: produce the first missing segment of the
   * current window, then look again.
   *
   * > [!IMPORTANT] AN IN-FLIGHT RUN IS LEFT TO FINISH WHEN THE PLAYHEAD JUMPS, deliberately
   * > It is at most one ffmpeg per rendition -- one copy-mode segment, or one VAAPI segment of
   * > about a second -- so killing it saves less than a segment. Killing it would also turn a
   * > seek into a logged ffmpeg failure, which is the line an operator reads when something is
   * > really broken. What a seek must never do is START work for the old position, and the
   * > window re-read before every production is what guarantees that.
   *
   * A failed production ends the loop rather than retrying: the next request re-aims it, and a
   * loop that retried a file ffmpeg cannot read would burn the box for nobody.
   */
  private async runAhead(state: SessionState, track: Track, trackState: TrackState): Promise<void> {
    trackState.aheadRunning = true;
    try {
      while (this.states.get(state.session.id) === state) {
        const next = this.nextAhead(state, track, trackState);
        if (next === null) return;
        if (!(await this.produce(state, track, next, "ahead"))) return;
      }
    } finally {
      trackState.aheadRunning = false;
    }
  }

  /** The first segment of the window that is neither on disk nor already being produced. */
  private nextAhead(state: SessionState, track: Track, trackState: TrackState): number | null {
    const window = trackState.ahead;
    if (!window) return null;
    for (let i = window.from; i <= window.to; i++) {
      if (trackState.producing.has(i)) continue;
      if (existsSync(join(state.session.dir, segmentFileName(track, i)))) continue;
      return i;
    }
    return null;
  }

  /**
   * The path of this rendition's ONE fMP4 initialisation segment, producing it if need be.
   *
   * Every run of a rendition writes a byte-identical init -- see `mediaPlaylist` for the
   * measurement and for what had to change first -- so there is a single file here, the single
   * `EXT-X-MAP` at the top of the playlist names it, and whichever run lands first has produced
   * it for the life of the session.
   *
   * Null without producing anything for a rendition that has no init at all -- WebVTT. No
   * playlist names one, so reaching here for subtitles means the name came from somewhere
   * other than a playlist this server wrote.
   */
  initPath(id: string, track: Track): Promise<string | null> {
    const name = initFileName(track);
    if (!name) return Promise.resolve(null);
    return this.published(id, track, INIT_FROM_SEGMENT, name);
  }

  /**
   * One published file -- a media segment, or the rendition's init -- produced if need be.
   *
   * Both come out of the SAME ffmpeg run, so both questions are the same question and asking
   * them through one method is what stops a player's init request and its media request
   * costing two transcodes of the same six seconds.
   */
  private async published(id: string, track: Track, index: number, name: string): Promise<string | null> {
    const state = this.states.get(id);
    if (!state) return null;
    state.session.lastAccessAt = this.now();
    const path = join(state.session.dir, name);
    if (existsSync(path)) return path;
    await this.produce(state, track, index);
    return existsSync(path) ? path : null;
  }

  /**
   * Produce one segment of one rendition, or join the production already making it.
   *
   * The dedupe is not an optimisation: two ffmpegs writing one segment file would hand a
   * player half of each.
   */
  private produce(
    state: SessionState,
    track: Track,
    index: number,
    kind: "request" | "ahead" = "request",
  ): Promise<boolean> {
    const trackState = state.byTrack.get(trackKey(track));
    if (!trackState) return Promise.resolve(false);
    // A request JOINS a read-ahead run already making its segment, which is the point of it.
    const already = trackState.producing.get(index);
    if (already) return already;
    // Only requests count against the ceiling: read-ahead is bounded by being one loop per
    // rendition, and letting it spend a slot would refuse the very request it is running ahead of.
    const requests = trackState.producing.size - trackState.background.size;
    if (kind === "request" && requests >= SEGMENT_CONCURRENCY) return Promise.resolve(false);
    const range = segmentRange(trackState.timeline, index);
    if (!range) return Promise.resolve(false);

    if (kind === "ahead") trackState.background.add(index);
    const run = this.runFfmpeg(state, track, index, range).finally(() => {
      trackState.producing.delete(index);
      trackState.background.delete(index);
    });
    trackState.producing.set(index, run);
    return run;
  }

  /**
   * One ffmpeg, into a private working directory, published by rename.
   *
   * > [!IMPORTANT] THE RENAME IS WHAT MAKES A SEGMENT SAFE TO SERVE
   * > ffmpeg writes a segment progressively, so a route that served the file the moment it
   * > appeared would hand a player a truncated fragment -- which is not a retryable 404, it
   * > is a decode error. Writing into a directory nobody serves and moving the finished file
   * > in is atomic within one filesystem, so a segment is either absent or complete.
   */
  private async runFfmpeg(
    state: SessionState,
    track: Track,
    index: number,
    range: { startSec: number; endSec: number },
  ): Promise<boolean> {
    const { session } = state;
    let work: string;
    try {
      // The track is in the name only so a directory left behind by a crash says which
      // rendition was making it; `mkdtempSync` is what makes it unique.
      work = mkdtempSync(join(session.dir, `w-${trackKey(track)}-${index}-`));
    } catch {
      // The session directory is gone: it was stopped while this request was in flight.
      return false;
    }

    const proc = this.spawn([
      this.ffmpeg,
      ...ffmpegArgs(session.plan, {
        input: session.input,
        outDir: work,
        track,
        segment: { index, startSec: range.startSec, endSec: range.endSec },
        encoder: session.encoder,
      }),
    ]);
    state.running.add(proc);

    const timer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {
        // Already gone; the exit below is what the caller waits on.
      }
    }, SEGMENT_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();

    let code: number;
    try {
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
      state.running.delete(proc);
      // AFTER the exit and whatever the exit code: a run that was killed on the timeout, or
      // that failed on a bad input, still burned the CPU it burned. Charging only successes
      // would hide exactly the runs an operator most wants to see.
      this.charge(session.id, proc);
    }

    if (code !== 0) await this.reportFailure(session.id, track, index, code, proc);
    const published = code === 0 && this.publish(state, track, work, index);
    rmSync(work, { recursive: true, force: true });
    return published;
  }

  /**
   * Say that a run failed, and what ffmpeg said about it.
   *
   * Without this a failing title leaves no trace on the box at all -- the player sees a 404 and
   * the container log is silent. Like `charge`, it must never be able to fail the segment path.
   */
  private async reportFailure(
    sessionId: string,
    track: Track,
    index: number,
    code: number,
    proc: SpawnedProcess,
  ): Promise<void> {
    const log = this.opts.log;
    if (!log) return;
    try {
      const said = ((await proc.stderr?.()) ?? "")
        .trim()
        .slice(-STDERR_TAIL_CHARS)
        .replace(/\s*\n\s*/g, " | ");
      log(
        `playback: ffmpeg exit ${code} for ${sessionId} ${trackKey(track)} segment ${index}${said ? `: ${said}` : ""}`,
      );
    } catch {
      // A diagnostic is never worth an exception on the segment path.
    }
  }

  /**
   * Tell whoever is keeping the books what this run cost, if anybody is and if it can be known.
   *
   * Every failure here is silent by design: a spawner that cannot account for its children, a
   * runtime that returns nothing, or a listener that throws must not be able to fail a segment
   * a viewer is waiting on. Instrumentation that can break the thing it measures is worse than
   * no instrumentation.
   */
  private charge(sessionId: string, proc: SpawnedProcess): void {
    const onRun = this.opts.onRun;
    if (!onRun) return;
    try {
      const cpuMs = proc.cpuMillis?.() ?? null;
      if (cpuMs !== null && cpuMs > 0) onRun({ sessionId, cpuMs });
    } catch {
      // Accounting is never worth an exception on the segment path.
    }
  }

  /**
   * Move the finished media segment out of the working directory, and the rendition's init with
   * it the first time.
   *
   * The media is renamed LAST so that a segment file appearing implies the init is already
   * there -- a player asks for them in the other order, but nothing enforces that.
   *
   * A run whose rendition HAS an init and did not write one publishes nothing: a segment served
   * without the header it needs is a decode error rather than a retryable 404. A WebVTT
   * rendition has no init, so there is nothing to move first and nothing to wait for.
   */
  private publish(state: SessionState, track: Track, work: string, index: number): boolean {
    const trackState = state.byTrack.get(trackKey(track));
    if (!trackState) return false;
    const { dir } = state.session;
    const media = segmentFileName(track, index);
    const init = initFileName(track);
    try {
      if (!existsSync(join(work, media))) return false;
      if (init) {
        if (!existsSync(join(work, RUN_INIT_NAME))) return false;
        // ONE init per rendition, and every run writes a byte-identical one -- so the first run
        // to reach here has published it for good, and renaming again would replace a file with
        // its own bytes underneath a player that is reading it.
        const published = join(dir, init);
        if (!existsSync(published)) renameSync(join(work, RUN_INIT_NAME), published);
      }
      renameSync(join(work, media), join(dir, media));
    } catch {
      return false;
    }
    trackState.produced.push(index);
    this.evict(state, track, trackState);
    return true;
  }

  /**
   * Drop the oldest media segments once a rendition holds too many.
   *
   * THE INIT IS NEVER EVICTED, and that is why this is only about media now: there is one per
   * rendition, the single `EXT-X-MAP` at the top of its playlist names it for the life of the
   * session, and dropping it would leave every later fragment pointing at a 404. It is 765
   * bytes against the gigabytes this method exists to bound.
   */
  private evict(state: SessionState, track: Track, trackState: TrackState): void {
    const window = trackState.ahead;
    // THE SEGMENT BEING READ AND THE ONES ABOUT TO BE ARE NEVER EVICTED. Order of LANDING is
    // not order of playback: a viewer who returns to a segment produced long ago would
    // otherwise have it dropped by the very read-ahead run that lands behind it.
    const kept = (i: number) => window !== null && i >= window.at && i <= window.to;
    while (trackState.produced.length > SEGMENT_CACHE) {
      const at = trackState.produced.findIndex((i) => !kept(i));
      if (at < 0) return;
      const [oldest] = trackState.produced.splice(at, 1);
      if (oldest === undefined) return;
      rmSync(join(state.session.dir, segmentFileName(track, oldest)), { force: true });
    }
  }

  /**
   * Release one viewer's hold on a session, and end the session once nobody holds it.
   *
   * An unknown or already-released `viewer` changes nothing. No `viewer` at all is a client
   * older than handles, and it may only end a session held by at most one viewer -- see the
   * holder paragraph in this module's header.
   */
  stop(id: string, viewer?: string): void {
    const state = this.states.get(id);
    if (!state) return;
    if (viewer === undefined) {
      if (state.holders.size > 1) return;
    } else if (!state.holders.delete(viewer) || state.holders.size > 0) {
      return;
    }
    this.end(id);
  }

  /**
   * End a session whoever holds it: kill whatever it is running, drop its directory, free its slot.
   *
   * SIGTERM first because ffmpeg closes its output cleanly on it. The SIGKILL is a backstop
   * for a process wedged on a stalled read -- a NAS share going away mid-stream is the real
   * case, and it is exactly when a hung ffmpeg would otherwise hold a slot forever.
   */
  private end(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    for (const proc of state.running) {
      try {
        proc.kill(15);
      } catch {
        // Already gone. Dropping the directory below is what matters.
      }
      const timer = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {
          // Nothing to insist to.
        }
      }, SIGKILL_AFTER_MS);
      // Do not hold the process open for a grace period nobody is waiting on.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    this.states.delete(id);
    if (this.byKey.get(state.session.key) === id) this.byKey.delete(state.session.key);
    try {
      rmSync(state.session.dir, { recursive: true, force: true });
    } catch {
      // A directory we cannot remove is litter rather than a failure; the slot is what
      // mattered and it is already back.
    }
  }

  /**
   * Drop every session that is abandoned or simply too old.
   *
   * Cheap and synchronous, and called from `start` rather than from a timer: the moment a
   * limit could bite is exactly the moment it is worth knowing what is really still alive,
   * and a manager with no traffic has nothing to reap.
   */
  reap(): number {
    const t = this.now();
    let dropped = 0;
    for (const s of this.list()) {
      const idle = t - s.lastAccessAt >= IDLE_REAP_MS;
      const old = t - s.startedAt >= HARD_TTL_MS;
      if (idle || old) {
        this.end(s.id);
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Stop everything.
   *
   * > [!CAUTION] A PROCESS THAT EXITS WITHOUT CALLING THIS ORPHANS A RUNNING ffmpeg
   * > A child outlives its parent. When finderr goes away -- a redeploy, a `--watch`
   * > restart, an operator's Ctrl-C -- the new process starts with an empty session map
   * > while the old ffmpeg keeps running, reparented to init, forever. Nothing reaps it,
   * > because the only thing that knew about it was the map that just went away.
   * >
   * > Observed 2026-09-08 on the dev server: one orphan from a restart three edits earlier
   * > was still at 344% CPU when somebody noticed the fans. Segment runs are short, which
   * > narrows the window rather than closing it -- a 4K re-encode of one segment is still
   * > seconds of a Celeron. `bindShutdown` is not optional wiring.
   */
  stopAll(): void {
    for (const s of this.list()) this.end(s.id);
  }

  /**
   * Sweep session directories left by a PREVIOUS life of this process.
   *
   * Called at boot, before anything starts. A hard kill (SIGKILL, an OOM, a pulled plug)
   * skips `stopAll` by definition, so the disk keeps whatever those sessions had written.
   * The directories are safe to remove unconditionally because nothing durable lives here:
   * the whole tree is regenerable output, which is exactly why `paths.transcode` is its own
   * directory rather than a corner of the data root.
   */
  sweepStale(): number {
    let removed = 0;
    try {
      for (const name of readdirSync(this.opts.root)) {
        if (!name.startsWith("sess-")) continue;
        rmSync(join(this.opts.root, name), { recursive: true, force: true });
        removed++;
      }
    } catch {
      // No directory yet, or no permission. Neither is worth failing a boot over.
    }
    return removed;
  }
}

/**
 * Make the process kill its transcodes before it dies.
 *
 * Separate from the class so the class stays testable without touching global process
 * state, and so the wiring is one visible line at the call site rather than a side effect
 * of construction.
 *
 * **Every one of these signals matters and they arrive from different places.** `SIGTERM` is
 * what `docker stop` and a redeploy send; `SIGINT` is Ctrl-C on the dev server; `exit`
 * catches an ordinary return and an uncaught throw. What CANNOT be caught is `SIGKILL` --
 * which is why `sweepStale` exists as the second half of this.
 *
 * The handlers do not exit the process themselves. Something else owns shutdown ordering
 * (the database has a checkpoint to finish, and hard-killing it has cost this project a
 * file before), so this only ever adds a cleanup and never takes over the sequence.
 */
export function bindShutdown(sessions: TranscodeSessions): void {
  const stop = () => sessions.stopAll();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("exit", stop);
}

/**
 * What makes two requests the same session.
 *
 * The file, the plan and the encoder -- everything that changes what a segment would
 * CONTAIN. The position is deliberately absent: a session is a whole film now, so two
 * viewers at different points in it share one session and every segment either of them
 * causes to be produced.
 *
 * EVERY rendition is named, not just the ones a viewer is watching. Two clients with
 * different codec support get different per-track answers -- Safari copies the eac3 track
 * that Chrome must re-encode -- so a key naming only the first would JOIN them onto one
 * output directory, and the second viewer would be served the first's audio.
 */
export function sessionKey(o: StartOpts): string {
  const p = o.plan;
  return [
    o.input,
    p.video ? `v:${p.video.action}:${p.video.sourceIndex}:${p.video.scaleWidth}` : "v:none",
    ...p.audio.map((a) => `a:${a.action}:${a.sourceIndex}`),
    ...p.subtitles.map((s) => `s:${s.sourceIndex}`),
    o.encoder?.encoder ?? "",
  ].join("|");
}
