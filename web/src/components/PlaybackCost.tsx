/**
 * What playback has cost this box, drawn: two charts over one window, and who spent it.
 *
 * A RENDERER over `/api/admin/playback/cost` and it must stay one -- the same rule
 * `ServerHealth` follows. Every number here was computed on the server, where the counters are;
 * a fact worth showing that the report does not carry belongs in `src/lib/transcode-meter.ts`.
 *
 * ## Why two charts rather than one with two axes
 *
 * Bytes per second and cores are different units. Sharing an axis would put them on a scale
 * where one of them is always a flat line, and a second axis on the right is the classic way to
 * make two unrelated series look correlated. They are stacked instead, on IDENTICAL x geometry,
 * so a reader can still line up "the spike in bandwidth is the spike in CPU" by looking down --
 * which is the honest version of the same comparison.
 *
 * ## A chart is a control, not decoration
 *
 * Each `<svg>` is one `role="img"` with a sentence for a name, following the precedent
 * `EpisodeScores`'s timeline set: an SVG shape cannot be a real button, so a focusable bar would
 * be a tab stop promising keyboard semantics it has no way to keep. **Nothing here is drawn ONLY
 * in the chart** -- the peak and the total are `Fact` rows beside it, and the per-session table
 * is the whole breakdown in real markup, so a reader who cannot see the picture has lost the
 * shape and none of the data.
 */

import { Link } from "@tanstack/react-router";
import {
  bars,
  barsPath,
  bytesPerSecond,
  coresUsed,
  formatCores,
  formatCpuTime,
  formatRate,
  peak,
  windowLength,
} from "../lib/cost-chart";
import type { PlaybackCostReport, PlayedMedia, SessionCost } from "../lib/playback-cost-api";
import { formatAge } from "../lib/timestamps";
import { formatBytes } from "../lib/units";
import { InertChip } from "./Chip";
import { Fact, Facts } from "./Facts";
import { Empty, Panel } from "./settings/Panel";
import { Button } from "./ui/button";

/**
 * The SVG's coordinate space. `viewBox` scales it to whatever width the card has.
 *
 * Short and wide because it is read as a shape over time rather than for individual values --
 * the values are the `Fact` rows beside it.
 */
const CHART = { width: 720, height: 96 };

/**
 * `-1` in both fields means a film. The sentinel is `NOT_AN_EPISODE` on the server.
 *
 * Compared rather than re-derived from a name, and stated here once so the two places that ask
 * (the label and the link) cannot disagree.
 */
const NOT_AN_EPISODE = -1;

/** `Season 6, episode 3`, or nothing at all for a film. */
function episodeOf(media: PlayedMedia): string | null {
  if (media.season === NOT_AN_EPISODE && media.episode === NOT_AN_EPISODE) return null;
  return `Season ${media.season}, episode ${media.episode}`;
}

/**
 * One series, as a filled shape.
 *
 * `fill-accent/70` rather than a solid: several hundred adjacent bars at full strength is a
 * block of green that hides its own shape, and the softer fill lets the peaks read.
 *
 * `preserveAspectRatio="none"` because the x axis is TIME and the y axis is a rate -- there is
 * no aspect to preserve between two units, and letting the box squash is what lets one card hold
 * two hours at whatever width the screen is.
 */
function Chart({ values, max, label }: { values: number[]; max: number; label: string }) {
  const drawn = bars(values, { width: CHART.width, height: CHART.height, max });
  return (
    <svg
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      className="h-24 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {/*
        THE PLOT AREA IS SHADED, and a hairline floor was not enough -- read off a real page
        2026-09-08, a 1px rule under two hours of mostly-idle window was invisible and both
        charts looked like empty boxes with a spike at the right edge. A filled ground says
        "this is the chart, and it is quiet" where a missing line says nothing at all.
      */}
      <rect x={0} y={0} width={CHART.width} height={CHART.height} className="fill-surface-2/60" />
      <path d={barsPath(drawn, CHART.height)} className="fill-accent/70" />
    </svg>
  );
}

/** A chart with the two numbers that make it readable: what the tallest bar is, and the axis. */
function Series({
  title,
  values,
  format,
  window: windowSeconds,
}: {
  title: string;
  values: number[];
  format: (v: number) => string;
  window: number;
}) {
  const most = peak(values);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span className="font-medium text-ink">{title}</span>
        <span className="tabular-nums text-muted">peak {format(most)}</span>
      </div>
      <Chart
        values={values}
        max={most}
        label={`${title} over the last ${windowLength(windowSeconds)}, oldest at the left. Peak ${format(most)}.`}
      />
      <div className="flex justify-between text-[10px] text-muted">
        <span>{windowLength(windowSeconds)} ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

/**
 * One session's row: what it played, what it cost, and whether it is still going.
 *
 * The title is a LINK, which is the rule every figure on these screens follows -- an operator
 * looking at a session that is eating the box is on their way to the title it is playing.
 */
function SessionRow({ session }: { session: SessionCost }) {
  const episode = episodeOf(session.media);
  return (
    <li className="flex items-start justify-between gap-4 py-2 not-last:border-b not-last:border-line/60">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Link
            to="/title/$tconst"
            params={{ tconst: session.media.tconst }}
            className="truncate text-sm text-ink hover:text-accent"
          >
            {session.media.tconst}
          </Link>
          {/*
            `warn` for a live session and the quiet default for a finished one, which is the
            ladder rule this product already follows: the settled end is the quiet end, and
            everything unfinished wears amber.
          */}
          <InertChip
            label={session.running ? "Playing" : "Finished"}
            tone={session.running ? "warn" : "neutral"}
          />
        </div>
        <p className="text-xs text-muted">
          {episode ? `${episode} · ` : ""}
          {formatCpuTime(session.cpuMs)} ·{" "}
          {/* A session that stopped an hour ago and one that stopped a second ago look the same
              in a byte count, and only one of them explains a quiet chart. */}
          last served {formatAge(session.lastAt) ?? "at an unknown time"}
        </p>
      </div>
      <span className="shrink-0 text-sm tabular-nums text-ink">{formatBytes(session.bytes)}</span>
    </li>
  );
}

/**
 * The empty state, which states the CONSEQUENCE rather than the absence.
 *
 * Two of them, because they are two different situations that look identical on a chart: nothing
 * has ever played in this process, or nothing has played recently. Drawing a flat line for
 * either would imply a measurement that was taken and came back zero.
 */
function NothingYet({ measured, windowSeconds }: { measured: boolean; windowSeconds: number }) {
  return (
    <Empty>
      {measured
        ? `Nothing has played in the last ${windowLength(windowSeconds)}. Earlier sessions are below, for as long as this server has been up.`
        : "Nothing has played since this server started, so there is nothing to measure yet. Press play on a title and this fills in."}
    </Empty>
  );
}

export function PlaybackCost({ report, refresh }: { report: PlaybackCostReport; refresh?: () => void }) {
  const { slices, sliceSeconds, windowSeconds } = report;
  const rates = slices.map((s) => bytesPerSecond(s.bytes, sliceSeconds));
  const cores = slices.map((s) => coresUsed(s.cpuMs, sliceSeconds));
  const busy = report.window.bytes > 0 || report.window.cpuMs > 0;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="What playback is costing this box"
        description={`Bytes handed out and the CPU the ffmpeg children burned, over the last ${windowLength(windowSeconds)}.`}
        /*
          A BUTTON RATHER THAN A POLL. `useAsyncData` states the rule these screens follow --
          nothing is polled, and every one of them is opened deliberately by somebody who wants
          the state as of now. A 30-second slice does not finish often enough for a poll to show
          anything a click would not, and a page that refetched itself would be the one admin
          screen that does.
        */
        action={
          refresh && (
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
          )
        }
      >
        {busy ? (
          <div className="flex flex-col gap-5">
            <Series title="Bandwidth served" values={rates} format={formatRate} window={windowSeconds} />
            <Series title="Transcode CPU" values={cores} format={formatCores} window={windowSeconds} />
            <Facts>
              {/*
                HANDED OUT, never "watched". A viewer who seeks away discards segments this
                already counted, and the label must not claim otherwise.
              */}
              <Fact
                label="Handed out"
                value={formatBytes(report.window.bytes)}
                hint="Bytes this box pushed, not bytes anybody watched -- a seek discards segments already counted."
                tone="info"
              />
              <Fact
                label="Transcode CPU, averaged over the window"
                value={formatCores(coresUsed(report.window.cpuMs, windowSeconds))}
              />
            </Facts>
          </div>
        ) : (
          <NothingYet measured={report.measured} windowSeconds={windowSeconds} />
        )}
      </Panel>

      <Panel
        title="By session"
        description="Everything each playback has cost since it started, for as long as this server has been up."
      >
        {report.sessions.length === 0 ? (
          <Empty>No session has been measured yet.</Empty>
        ) : (
          <>
            <ul className="flex flex-col">
              {report.sessions.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </ul>
            {report.evicted > 0 && (
              <p className="mt-3 text-xs text-muted">
                {report.evicted} older session{report.evicted === 1 ? "" : "s"} dropped to keep this list
                bounded. What they served is still in the totals above, so the rows can add up to less.
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
