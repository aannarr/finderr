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
 * never `undefined`, and never a confident zero. The words themselves come from
 * `playback-report.ts`, which the Copy button reads too, so a pasted report says what the
 * screen said.
 */

import { useEffect, useRef, useState } from "react";
import {
  type Budget,
  detectCapabilities,
  fetchSessions,
  type PlaybackSession,
  type SessionsReport,
} from "../lib/playback-api";
import {
  audioLine,
  bitrate,
  bytes,
  clock,
  fragmentLine,
  lastErrorLine,
  playbackReport,
  segmentLine,
  text,
  UNKNOWN,
  videoLine,
} from "../lib/playback-report";
import { type BrowserStats, readyStateLabel } from "../lib/playback-telemetry";
import { isExpensivePlan, planSummary } from "../lib/playback-types";
import { uptime } from "../lib/units";
import { Fact, Facts } from "./Facts";

/** The browser half is a property read; a second is fast enough to watch a stall develop. */
const BROWSER_TICK_MS = 1_000;

/** The server half is a request. Five seconds is a session table that cannot go stale unseen. */
const SERVER_TICK_MS = 5_000;

/** How long "Copied" stays up before the button reads "Copy" again. */
const COPIED_MS = 2_000;

/** `2 of 3` -- the shape both limits are read in. */
const spent = (budget: Budget): string => `${budget.used} of ${budget.max}`;

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
      <Fact
        label="Last error"
        value={lastErrorLine(s) ? "yes" : "none"}
        hint={lastErrorLine(s) ?? undefined}
      />
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

type CopyState = "idle" | "copied" | "failed";

/**
 * Put the whole panel on the clipboard as text, so a failure can be pasted rather than
 * screenshotted -- a screenshot cannot be searched, and it crops the plan's reasons.
 *
 * It says what happened in its own label and keeps focus, the same shape the share button
 * uses. A failure is named rather than swallowed: the clipboard API needs a secure context, so a
 * plain-http LAN address has none, and a button that silently does nothing there reads as broken.
 */
export function CopyReport(props: { build: () => string; className?: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    let next: CopyState = "failed";
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(props.build());
        next = "copied";
      }
    } catch {
      // Refused by the browser; "failed" says so.
    }
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={props.className ?? "text-xs text-muted hover:text-ink"}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy diagnostics"}
    </button>
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
  className?: string;
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

  // Built at the moment of the click, from a FRESH browser read rather than the last tick:
  // the second between ticks is exactly when a stall or an error lands.
  const build = () =>
    playbackReport({
      session: props.session,
      browser: readBrowserStats() ?? browser,
      report,
      capabilities: detectCapabilities(),
      userAgent: navigator.userAgent,
      page: window.location.href,
      now: Date.now(),
    });

  return (
    <div className={props.className ?? "rounded-lg border border-line bg-black/60 px-3 py-2 text-left"}>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <ServerFacts session={props.session} report={report} now={now} />
        <BrowserFacts stats={browser} />
      </div>
      <PlanReasons reasons={props.session.plan.reasons} />
      <div className="mt-2 flex justify-end border-t border-line/60 pt-2">
        <CopyReport build={build} />
      </div>
    </div>
  );
}
