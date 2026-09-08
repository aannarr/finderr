/**
 * Stats for nerds: what the player and the server are actually doing, on a toggle.
 *
 * > [!IMPORTANT] IT IS DIAGNOSTIC TOOLING, not decoration
 * > Four of this subsystem's four historical failures were invisible server-side -- ffmpeg was
 * > fine and the picture was black. `readyState`, the buffer ahead of the playhead and the
 * > last player error name three of the four in seconds. That is the argument for it.
 *
 * ## Two clocks, and neither of them is per frame
 *
 * The browser half is free -- a property read on the element plus a counter hls.js already
 * keeps -- so it ticks every second. The server half is a fetch, so it ticks every five, and it
 * is ONE endpoint: `/api/play/sessions` already returned the whole session table and both
 * budgets before this panel existed. Nothing here asks the server for anything it was not
 * already computing, because a diagnostic that costs CPU is measuring a system it has changed.
 *
 * **Both stop the moment the panel closes**, and structurally rather than by a flag: the
 * player MOUNTS this only while its toggle is on, so closing it unmounts the component and the
 * effect cleanups clear both timers. A closed panel costs exactly nothing.
 *
 * Every value renders through `Facts`, the two-column list `/admin` health uses: a screen of
 * small measurements somebody is scanning for the one they came for. An unknown is a dash and
 * never `undefined`, and never a confident zero.
 */

import { useEffect, useState } from "react";
import {
  type Budget,
  fetchSessions,
  type PlaybackDiagnostics,
  type PlaybackSession,
  type SessionsReport,
} from "../lib/playback-api";
import { type BrowserStats, readyStateLabel } from "../lib/playback-telemetry";
import { isExpensivePlan, planSummary } from "../lib/playback-types";
import { count, formatBytes, uptime } from "../lib/units";
import { Fact, Facts } from "./Facts";

/** The browser half is a property read; a second is fast enough to watch a stall develop. */
const BROWSER_TICK_MS = 1_000;

/** The server half is a request. Five seconds is a session table that cannot go stale unseen. */
const SERVER_TICK_MS = 5_000;

/** What a value nobody knows reads as. */
const UNKNOWN = "—";

const text = (value: string | null | undefined): string => value ?? UNKNOWN;

const bytes = (n: number | null | undefined): string =>
  n === null || n === undefined ? UNKNOWN : formatBytes(n);

/** A number of seconds as a clock -- `2:28:00`, `9:41`. */
function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN;
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

/** Bits per second, as a person reads throughput. */
function bitrate(bps: number | null): string {
  if (bps === null) return UNKNOWN;
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

/** `2 of 3` -- the shape both limits are read in. */
const spent = (budget: Budget): string => `${budget.used} of ${budget.max}`;

/**
 * A line assembled from the parts that are PRESENT.
 *
 * Not a fixed template with dashes in the gaps: an arr row imported before it was scanned has
 * no bit depth and no dynamic range, and four dashes in a row say nothing except that this
 * panel does not know what it is looking at.
 */
const line = (parts: (string | null | undefined)[]): string => parts.filter(Boolean).join(" · ") || UNKNOWN;

const videoLine = (source: PlaybackDiagnostics["source"]): string =>
  line([
    source.videoCodec,
    source.resolution,
    source.bitDepth ? `${source.bitDepth}-bit` : null,
    source.dynamicRange,
  ]);

const audioLine = (source: PlaybackDiagnostics["source"]): string =>
  line([source.audioCodec, source.audioChannels === null ? null : count(source.audioChannels, "channel")]);

/**
 * How the film was cut up, with the fallback said out loud.
 *
 * `uniform` means the keyframe probe found nothing usable, so every boundary is a guess. That
 * is the difference between "this title stutters" and "this title fell back to a grid", and
 * until this line existed it was only answerable by reading a log on the box.
 */
function segmentLine(segmenting: PlaybackDiagnostics["segmenting"]): string {
  const cut =
    segmenting.source === "keyframes"
      ? "on source keyframes"
      : segmenting.source === "uniform"
        ? "on a uniform grid"
        : "no video timeline";
  return `${count(segmenting.count, "segment")}, ~${segmenting.targetSec}s, ${cut}`;
}

/** What the last segment fetch was, as one line. */
function fragmentLine(stats: BrowserStats | null): string {
  const frag = stats?.lastFragment;
  if (!frag) return UNKNOWN;
  // An initialisation segment has no place on the timeline, and "still fetching init" is a
  // different stage of a stall from "fetching segment 0".
  return line([
    frag.index === null ? "init" : `#${frag.index}`,
    frag.track,
    `${frag.loadMs} ms`,
    bytes(frag.bytes),
  ]);
}

/** The server half: the plan, the file it was made from, and what the box is spending. */
function ServerFacts(props: { session: PlaybackSession; report: SessionsReport | null; now: number }) {
  const { plan, diagnostics } = props.session;
  const mine = props.report?.sessions.find((s) => s.id === props.session.sessionId);
  const startedAt = mine ? Date.parse(mine.startedAt) : Number.NaN;
  const encoder = diagnostics?.encoder;

  return (
    <Facts>
      <Fact label="Plan" value={planSummary(plan)} />
      <Fact
        label="Encoder"
        value={text(encoder?.name)}
        // Reported even when nothing is encoding, because "which encoder would this box use"
        // is a question about the box. The hint is what stops that reading as a claim that
        // this title is being re-encoded.
        hint={
          encoder
            ? isExpensivePlan(plan)
              ? encoder.reason
              : `${encoder.reason}, idle — this video is copied`
            : undefined
        }
        tone="info"
      />
      <Fact label="Container" value={text(diagnostics?.source.container)} />
      <Fact label="Video" value={diagnostics ? videoLine(diagnostics.source) : UNKNOWN} />
      <Fact label="Audio" value={diagnostics ? audioLine(diagnostics.source) : UNKNOWN} />
      <Fact label="Runtime" value={clock(diagnostics?.source.durationSec ?? props.session.durationSec)} />
      <Fact label="File" value={bytes(diagnostics?.source.sizeBytes)} />
      <Fact label="Segments" value={diagnostics ? segmentLine(diagnostics.segmenting) : UNKNOWN} />
      <Fact label="Session" value={props.session.sessionId} />
      <Fact
        label="Running for"
        value={Number.isNaN(startedAt) ? UNKNOWN : uptime((props.now - startedAt) / 1000)}
        // A session the server has stopped listing is one whose next segment request is a 404
        // -- the failure that once looked like an empty console and nothing else.
        hint={props.report && !mine ? "The server is no longer listing this session." : undefined}
      />
      <Fact
        label="Sessions"
        value={props.report ? spent(props.report.budgets.sessions) : UNKNOWN}
        hint={
          isExpensivePlan(plan) ? "This one re-encodes video, so it spends an expensive slot too." : undefined
        }
        tone="info"
      />
      <Fact label="Re-encoding" value={props.report ? spent(props.report.budgets.expensive) : UNKNOWN} />
    </Facts>
  );
}

/** The browser half, which is the one no server log can answer. */
function BrowserFacts(props: { stats: BrowserStats | null }) {
  const s = props.stats;
  return (
    <Facts>
      <Fact
        label="Ready state"
        value={s ? readyStateLabel(s.readyState) : UNKNOWN}
        hint={
          s?.readyState === 0
            ? "The element has no data at all: either nothing was requested or every request failed."
            : undefined
        }
      />
      <Fact
        label="Buffer ahead"
        value={s ? `${s.bufferedAheadSec.toFixed(1)}s` : UNKNOWN}
        hint={
          s && s.readyState > 0 && s.bufferedAheadSec === 0
            ? "Nothing is buffered ahead of the playhead, which is what a stall looks like."
            : undefined
        }
      />
      <Fact label="Position" value={clock(s?.positionSec)} />
      <Fact
        label="Dropped frames"
        value={
          s?.droppedFrames === null || s?.droppedFrames === undefined
            ? UNKNOWN
            : `${s.droppedFrames} of ${s.totalFrames ?? 0}`
        }
      />
      <Fact label="Throughput" value={bitrate(s?.bandwidthBps ?? null)} />
      <Fact label="Last segment" value={fragmentLine(s)} />
      <Fact label="Last error" value={s?.lastError ? "yes" : "none"} hint={s?.lastError ?? undefined} />
    </Facts>
  );
}

/**
 * The plan's own sentences, which the server already writes in plain English for exactly this.
 *
 * Below the columns rather than beside them: they are prose of unpredictable length, and a
 * paragraph in a right-aligned tabular column is the one shape `Facts` is wrong for.
 */
function PlanReasons(props: { reasons: string[] }) {
  if (props.reasons.length === 0) return null;
  return (
    <ul className="mt-2 list-disc space-y-0.5 border-t border-line/60 pt-2 pl-4 text-xs text-muted">
      {props.reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  );
}

/**
 * The panel.
 *
 * **It is MOUNTED only while it is open**, which is what makes "closing it stops whatever it
 * was polling" a property of the structure rather than a flag somebody has to remember to
 * check: both timers live in effects, so unmounting clears them and there is no closed state
 * for a poll to leak out of.
 *
 * `readBrowserStats` is INJECTED rather than reached for: the player owns the `<video>` element
 * and the hls.js instance, and handing this component a function that returns a plain object is
 * what lets the whole panel render in a test with no media, no MSE and no network. It returns
 * null when there is nothing to read yet, which is a real state -- the element exists for a
 * frame before anything is attached to it.
 */
export function PlayerStats(props: {
  session: PlaybackSession;
  readBrowserStats: () => BrowserStats | null;
}) {
  const [browser, setBrowser] = useState<BrowserStats | null>(null);
  const [report, setReport] = useState<SessionsReport | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { readBrowserStats } = props;
  useEffect(() => {
    const sample = () => {
      setBrowser(readBrowserStats());
      setNow(Date.now());
    };
    sample();
    const timer = setInterval(sample, BROWSER_TICK_MS);
    return () => clearInterval(timer);
  }, [readBrowserStats]);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const next = await fetchSessions();
      // A panel closed mid-flight must not set state on the way out, and a failed poll keeps
      // the last good answer rather than blanking the server column on one bad tick.
      if (live && next) setReport(next);
    };
    void poll();
    const timer = setInterval(() => void poll(), SERVER_TICK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="rounded-lg border border-line bg-black/60 px-3 py-2 text-left">
      <div className="grid gap-x-6 sm:grid-cols-2">
        <ServerFacts session={props.session} report={report} now={now} />
        <BrowserFacts stats={browser} />
      </div>
      <PlanReasons reasons={props.session.plan.reasons} />
    </div>
  );
}
