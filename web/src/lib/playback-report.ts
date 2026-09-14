/**
 * The stats panel's facts in words, once -- for the panel to draw and for the Copy button to put
 * on the clipboard.
 *
 * > [!IMPORTANT] ONE FORMATTER, TWO READERS
 * > The copied text is what somebody pastes into a bug report, so it must say exactly what the
 * > panel said. Two sets of helpers would drift, and the drift would be invisible until a pasted
 * > report disagreed with the screenshot beside it.
 *
 * The report carries two things the panel does not draw: the user agent and the codec list this
 * browser CLAIMED. Both are the first question about any playback failure -- tt2209764 died
 * because Safari claimed HEVC in a form the server did not send -- and neither is worth a row on
 * screen, where a human already knows which browser they are holding.
 */

import type {
  ClientCapabilities,
  PlaybackDiagnostics,
  PlaybackSession,
  SessionsReport,
} from "./playback-api";
import { type BrowserStats, readyStateLabel } from "./playback-telemetry";
import { planSummary } from "./playback-types";
import { count, formatBytes, uptime } from "./units";

/** What a value nobody knows reads as. */
export const UNKNOWN = "—";

export const text = (value: string | null | undefined): string => value ?? UNKNOWN;

export const bytes = (n: number | null | undefined): string =>
  n === null || n === undefined ? UNKNOWN : formatBytes(n);

/** A number of seconds as a clock -- `2:28:00`, `9:41`. */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN;
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

/** Bits per second, as a person reads throughput. */
export function bitrate(bps: number | null): string {
  if (bps === null) return UNKNOWN;
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

/**
 * A line assembled from the parts that are PRESENT.
 *
 * Not a fixed template with dashes in the gaps: an arr row imported before it was scanned has
 * no bit depth and no dynamic range, and four dashes in a row say nothing except that this
 * panel does not know what it is looking at.
 */
const line = (parts: (string | null | undefined)[]): string => parts.filter(Boolean).join(" · ") || UNKNOWN;

export const videoLine = (source: PlaybackDiagnostics["source"]): string =>
  line([
    source.videoCodec,
    source.resolution,
    source.bitDepth ? `${source.bitDepth}-bit` : null,
    source.dynamicRange,
  ]);

export const audioLine = (source: PlaybackDiagnostics["source"]): string =>
  line([source.audioCodec, source.audioChannels === null ? null : count(source.audioChannels, "channel")]);

/**
 * How the film was cut up, with the fallback said out loud.
 *
 * `uniform` means neither the container's own index nor the keyframe probe found anything
 * usable, so every boundary is a guess. That is the difference between "this title stutters"
 * and "this title fell back to a grid", and until this line existed it was only answerable by
 * reading a log on the box. The two real sources are named apart for the same reason the
 * server's own `videoGridNote` names them apart: a container index that works and a probe that
 * works are indistinguishable on screen otherwise, and only one of them is cheap.
 */
export function segmentLine(segmenting: PlaybackDiagnostics["segmenting"]): string {
  const cut =
    segmenting.source === "container"
      ? "on the container's own index"
      : segmenting.source === "probe"
        ? "on probed keyframes"
        : segmenting.source === "uniform"
          ? "on a uniform grid"
          : "no video timeline";
  return `${count(segmenting.count, "segment")}, ~${segmenting.targetSec}s, ${cut}`;
}

/** What the last segment fetch was, as one line. */
export function fragmentLine(stats: BrowserStats | null): string {
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

export interface ReportInput {
  session: PlaybackSession;
  browser: BrowserStats | null;
  report: SessionsReport | null;
  /** What this browser told the server it can decode. */
  capabilities: ClientCapabilities;
  userAgent: string;
  /** The page, so a pasted report names the title without anybody retyping it. */
  page: string;
  now: number;
}

/**
 * The whole panel as plain text, one fact per line.
 *
 * Plain text rather than JSON because it is read by a person first: pasted into a chat, it has
 * to be scannable at a glance, and a JSON blob of the same facts is three times as tall.
 */
export function playbackReport(input: ReportInput): string {
  const { session, browser: b, report } = input;
  const d = session.diagnostics;
  const mine = report?.sessions.find((s) => s.id === session.sessionId);
  const startedAt = mine ? Date.parse(mine.startedAt) : Number.NaN;
  const spent = (x: { used: number; max: number } | undefined) => (x ? `${x.used} of ${x.max}` : UNKNOWN);

  const rows: [string, string][] = [
    ["Page", input.page],
    ["Browser", input.userAgent],
    ["Claims video", input.capabilities.video.join(", ") || "nothing"],
    ["Claims audio", input.capabilities.audio.join(", ") || "nothing"],
    ["Plan", planSummary(session.plan)],
    ["Encoder", d?.encoder ? `${d.encoder.name} (${d.encoder.reason})` : UNKNOWN],
    ["Container", text(d?.source.container)],
    ["Video", d ? videoLine(d.source) : UNKNOWN],
    ["Audio", d ? audioLine(d.source) : UNKNOWN],
    ["Runtime", clock(d?.source.durationSec ?? session.durationSec)],
    ["File", bytes(d?.source.sizeBytes)],
    ["Segments", d ? segmentLine(d.segmenting) : UNKNOWN],
    ["Session", session.sessionId],
    ["Running for", Number.isNaN(startedAt) ? UNKNOWN : uptime((input.now - startedAt) / 1000)],
    ["Server lists it", report ? (mine ? "yes" : "no") : UNKNOWN],
    ["Sessions", spent(report?.budgets.sessions)],
    ["Re-encoding", spent(report?.budgets.expensive)],
    ["Ready state", b ? readyStateLabel(b.readyState) : UNKNOWN],
    ["Buffer ahead", b ? `${b.bufferedAheadSec.toFixed(1)}s` : UNKNOWN],
    ["Position", clock(b?.positionSec)],
    [
      "Dropped frames",
      b?.droppedFrames === null || b?.droppedFrames === undefined
        ? UNKNOWN
        : `${b.droppedFrames} of ${b.totalFrames ?? 0}`,
    ],
    ["Throughput", bitrate(b?.bandwidthBps ?? null)],
    ["Last segment", fragmentLine(b)],
    ["Last error", b?.lastError ?? "none"],
  ];

  const reasons = session.plan.reasons.map((r) => `- ${r}`);
  return [
    "finderr playback diagnostics",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(reasons.length > 0 ? ["Plan reasons:", ...reasons] : []),
  ].join("\n");
}
