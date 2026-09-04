/**
 * Per-episode scores, in the three shapes a reader asks for them in.
 *
 * GRID is the default and it is the reason this pane exists: a whole series' quality on
 * one screen, seasons across and episode numbers down, so the shape of a show -- the
 * strong second season, the collapse in the seventh -- is visible without reading a single
 * number. LIST is the same data for one season with the titles and air dates a reader
 * needs to actually pick an episode. TIMELINE is the trend, for the question the other two
 * cannot answer: is this show getting better or worse.
 *
 * ## Why this is its own pane and not part of `SeriesPane`
 *
 * `SeriesPane` owns seasons and episodes for a different purpose -- air dates and what
 * Sonarr holds, which is request state. This pane owns quality. They share the `seasons`
 * and `episodes` facets and nothing else: no state, no selection, no controls. Folding
 * them together would give one component two reasons to change and put a request button
 * next to a rating, which are not the same decision.
 *
 * ## The card is the only place a still is drawn
 *
 * `Episode.image` has been fetched, proxied and cached since the facet image proxy landed
 * and nothing has ever drawn it -- `SeriesPane` deliberately does not, because one still
 * per row over 73 rows is a different screen from the one air dates are for. A card that
 * appears for ONE episode at a time is what that asset was waiting for.
 *
 * Every rule about what the data MEANS lives in `../lib/episode-scores`; this file decides
 * only what it looks like.
 */

import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  BAND_LABEL,
  BAND_ORDER,
  bandFor,
  type EpisodeScore,
  episodeGrid,
  formatVotes,
  type ScoreBand,
  type ScoredEpisode,
  timeline,
  trendline,
} from "../lib/episode-scores";
import { formatCalendarDate, localImageUrl } from "../lib/facet-panes";
import type { Episode, Season } from "../lib/facets";
import { Skeleton } from "./FacetPane";

/**
 * The band colours, as whole literal class strings.
 *
 * Written out rather than composed, because Tailwind scans source text: a class built by
 * interpolation is a class that is not in the stylesheet. The pairs are chosen for
 * CONTRAST on the cell rather than for prettiness -- a grid is read at a glance and a
 * mid-tone number on a mid-tone fill is unreadable at the size these cells are.
 */
const BAND_CELL: Record<ScoreBand, string> = {
  cinema: "bg-sky-500 text-sky-950",
  awesome: "bg-emerald-600 text-emerald-50",
  great: "bg-emerald-500 text-emerald-950",
  good: "bg-yellow-400 text-yellow-950",
  average: "bg-orange-500 text-orange-950",
  bad: "bg-red-500 text-red-950",
  garbage: "bg-purple-500 text-purple-50",
};

/** The legend dot. Same hues, no text colour -- nothing is written on top of these. */
const BAND_DOT: Record<ScoreBand, string> = {
  cinema: "bg-sky-500",
  awesome: "bg-emerald-600",
  great: "bg-emerald-500",
  good: "bg-yellow-400",
  average: "bg-orange-500",
  bad: "bg-red-500",
  garbage: "bg-purple-500",
};

/**
 * The same bands as SVG FILLS.
 *
 * A separate map rather than a clever reuse of `BAND_DOT`, because `bg-emerald-500` sets
 * `background-color` and an SVG shape is painted by `fill`. The chart rendered in
 * greyscale until this existed: the `bg-*` class applied cleanly, did nothing visible, and
 * `[fill:currentColor]` then picked up the inherited TEXT colour. Two properties, two
 * tables, and Tailwind needs both spelled out literally to emit either.
 */
const BAND_FILL: Record<ScoreBand, string> = {
  cinema: "fill-sky-500",
  awesome: "fill-emerald-600",
  great: "fill-emerald-500",
  good: "fill-yellow-400",
  average: "fill-orange-500",
  bad: "fill-red-500",
  garbage: "fill-purple-500",
};

/** A cell with no score. Muted rather than coloured -- absence is not a seventh quality. */
const EMPTY_CELL = "bg-surface-2 text-muted";

type ViewName = "grid" | "list" | "timeline";

const _VIEWS: readonly { name: ViewName; label: string }[] = [
  { name: "grid", label: "Grid" },
  { name: "list", label: "Episodes" },
  { name: "timeline", label: "Timeline" },
];

export function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {BAND_ORDER.map((band) => (
        <li key={band} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-2 rounded-full ${BAND_DOT[band]}`} />
          {BAND_LABEL[band]}
        </li>
      ))}
    </ul>
  );
}

// --- the hover card ---------------------------------------------------------

export interface CardState {
  episode: ScoredEpisode;
  /** Viewport coordinates of the thing that opened it, so the card can sit beside it. */
  anchor: DOMRect;
}

export interface HoverCard {
  state: CardState | null;
  open: (episode: ScoredEpisode, target: Element) => void;
  close: () => void;
}

/**
 * One card for the whole pane, positioned against whichever cell asked for it.
 *
 * Rendered at the pane level and positioned `fixed` rather than nested inside the cell,
 * because the grid scrolls horizontally and therefore clips: a card drawn inside the
 * scroller would be cut off at exactly the edges where the grid is most crowded.
 *
 * Opened by hover AND by focus. A grid of a hundred and thirty cells reachable only by
 * mouse is a hundred and thirty facts a keyboard reader cannot have, so every cell is a
 * real button and focusing one shows the same card.
 */
export function useHoverCard(): HoverCard {
  const [state, setState] = useState<CardState | null>(null);
  const open = useCallback((episode: ScoredEpisode, target: Element) => {
    setState({ episode, anchor: target.getBoundingClientRect() });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { state, open, close };
}

export function EpisodeCard({ state }: { state: CardState | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  // Measured after paint: the card's own size decides whether it fits to the right of the
  // cell and above the fold, and nothing knows that size until it is on screen.
  useLayoutEffect(() => {
    if (!state || !ref.current) {
      setPlacement(null);
      return;
    }
    const card = ref.current.getBoundingClientRect();
    const gap = 8;
    const { anchor } = state;
    const left = Math.min(
      Math.max(gap, anchor.left + anchor.width / 2 - card.width / 2),
      window.innerWidth - card.width - gap,
    );
    const above = anchor.top - card.height - gap;
    const top = above >= gap ? above : Math.min(anchor.bottom + gap, window.innerHeight - card.height - gap);
    setPlacement({ left, top });
  }, [state]);

  if (!state) return null;
  const { episode } = state;
  const still = localImageUrl(episode.image);

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-72 overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        // Invisible for the one frame between mount and measurement, so the card never
        // flashes at the top-left corner on its way to where it belongs.
        visibility: placement ? "visible" : "hidden",
      }}
    >
      {still && (
        <img src={still} alt="" loading="lazy" className="aspect-video w-full bg-surface-2 object-cover" />
      )}
      <div className="flex flex-col gap-1.5 p-3">
        <div className="flex items-start gap-2">
          <ScoreBadge episode={episode} className="shrink-0 px-1.5 py-0.5 text-sm" />
          <p className="text-sm leading-tight font-medium text-ink">{episode.label}</p>
        </div>
        <p className="text-xs text-muted">
          Season {episode.season} Episode {episode.number}
          {episode.airDate && <> · {formatCalendarDate(episode.airDate)}</>}
          {episode.rating !== null && <> · {formatVotes(episode.votes)}</>}
        </p>
        {episode.overview && (
          <p className="line-clamp-4 text-xs leading-relaxed text-muted">{episode.overview}</p>
        )}
      </div>
    </div>
  );
}

/** The number in its band's colours, or a dash. Shared by every view. */
export function ScoreBadge({ episode, className = "" }: { episode: ScoredEpisode; className?: string }) {
  const band = episode.band;
  return (
    <span
      className={`rounded font-semibold tabular-nums ${band ? BAND_CELL[band] : EMPTY_CELL} ${className}`}
    >
      {episode.rating !== null ? episode.rating.toFixed(1) : "?"}
    </span>
  );
}

/**
 * The accessible name of a cell, which is the only thing a screen reader gets.
 *
 * Built as one sentence rather than assembled from the visual parts, because the visual
 * parts are a bare number in a coloured box -- meaningless read aloud on their own.
 */
function cellLabel(episode: ScoredEpisode): string {
  const where = `Season ${episode.season} episode ${episode.number}, ${episode.label}`;
  if (episode.rating === null) return `${where}, no score yet`;
  return `${where}, ${episode.rating.toFixed(1)} out of 10 from ${formatVotes(episode.votes)}`;
}

// --- grid -------------------------------------------------------------------

export function GridView({
  seasons,
  episodes,
  scores,
  card,
}: {
  seasons: readonly Season[];
  episodes: readonly Episode[];
  scores: readonly EpisodeScore[] | undefined;
  card: HoverCard;
}) {
  const grid = episodeGrid(seasons, episodes, scores);
  if (grid.rows.length === 0) return <Empty />;

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <table className="border-separate border-spacing-1">
        <caption className="sr-only">Episode scores by season</caption>
        <thead>
          <tr>
            <th className="w-8" />
            {grid.columns.map((c) => (
              <th key={c.season} scope="col" className="text-center text-xs font-medium text-muted">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((n, row) => (
            <tr key={n}>
              <th scope="row" className="pr-1 text-right text-xs font-medium text-muted">
                E{n}
              </th>
              {grid.columns.map((c) => {
                const episode = c.cells[row];
                return (
                  <td key={c.season}>
                    {episode ? (
                      <button
                        type="button"
                        aria-label={cellLabel(episode)}
                        onMouseEnter={(e) => card.open(episode, e.currentTarget)}
                        onMouseLeave={card.close}
                        onFocus={(e) => card.open(episode, e.currentTarget)}
                        onBlur={card.close}
                        className={[
                          "block w-12 rounded px-1 py-1 text-center text-sm font-semibold tabular-nums",
                          "transition-transform hover:scale-110 focus-visible:scale-110",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                          episode.band ? BAND_CELL[episode.band] : EMPTY_CELL,
                        ].join(" ")}
                      >
                        {episode.rating !== null ? episode.rating.toFixed(1) : "?"}
                      </button>
                    ) : (
                      <span className="block w-12" />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="pt-1 pr-1 text-right text-[10px] font-medium tracking-wide text-muted">
              AVG
            </th>
            {grid.columns.map((c) => (
              <td key={c.season} className="pt-1">
                <div
                  className={[
                    "w-12 rounded px-1 py-0.5 text-center text-xs font-semibold tabular-nums",
                    c.averageBand ? BAND_CELL[c.averageBand] : EMPTY_CELL,
                  ].join(" ")}
                >
                  {c.average !== null ? c.average.toFixed(1) : "–"}
                </div>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// --- timeline ---------------------------------------------------------------

const CHART = { width: 720, height: 260, padLeft: 28, padRight: 8, padTop: 8, padBottom: 22 };

export function TimelineView({
  seasons,
  episodes,
  scores,
  card,
}: {
  seasons: readonly Season[];
  episodes: readonly Episode[];
  scores: readonly EpisodeScore[] | undefined;
  card: HoverCard;
}) {
  const [trend, setTrend] = useState(true);
  const t = timeline(seasons, episodes, scores);
  if (t.points.length === 0) return <Empty>No episode has a score yet.</Empty>;

  const plotW = CHART.width - CHART.padLeft - CHART.padRight;
  const plotH = CHART.height - CHART.padTop - CHART.padBottom;
  // A single plotted point would divide by zero; it sits in the middle instead.
  const span = Math.max(1, t.points.length - 1);
  const x = (i: number) => CHART.padLeft + (t.points.length === 1 ? plotW / 2 : (i / span) * plotW);
  const y = (v: number) => CHART.padTop + plotH - ((v - t.min) / (t.max - t.min)) * plotH;

  const ticks = Array.from({ length: t.max - t.min + 1 }, (_, i) => t.min + i);
  const line = trendline(t.points);

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={trend}
          onChange={(e) => setTrend(e.target.checked)}
          className="accent-accent"
        />
        Trendline
      </label>

      <div className="-mx-1 overflow-x-auto px-1">
        <svg
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          className="h-64 w-full min-w-[32rem]"
          role="img"
          aria-label={`Every rated episode in order, from ${t.min} to ${t.max} out of 10`}
        >
          <title>Episode scores over time</title>

          {/* Alternating season bands: the x axis has no units of its own, so these are
              the only thing telling a reader where they are in the run. */}
          {t.bands.map((b, i) =>
            b.to > b.from && i % 2 === 1 ? (
              <rect
                key={b.season}
                x={x(b.from) - 2}
                y={CHART.padTop}
                width={Math.max(4, x(b.to - 1) - x(b.from) + 4)}
                height={plotH}
                className="fill-surface-2/60"
              />
            ) : null,
          )}

          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={CHART.padLeft}
                x2={CHART.width - CHART.padRight}
                y1={y(v)}
                y2={y(v)}
                className="stroke-line"
                strokeDasharray="2 4"
              />
              <text x={0} y={y(v) + 4} className="fill-muted text-[10px]">
                {v.toFixed(1)}
              </text>
            </g>
          ))}

          <polyline
            points={t.points.map((p, i) => `${x(i)},${y(p.rating as number)}`).join(" ")}
            className="fill-none stroke-line"
            strokeWidth={1}
          />

          {trend && (
            <polyline
              points={line.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              className="fill-none stroke-muted"
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          )}

          {t.points.map((p, i) => (
            /*
              A chart dot cannot be an interactive element: an SVG `circle` is not a
              `<button>`, and making it a tab stop would promise keyboard semantics it has
              no way to honour. The hover is a mouse AFFORDANCE over a labelled image, and
              the same episode data is fully keyboard-reachable in the Grid and Episodes
              views of this same pane.
            */
            // biome-ignore lint/a11y/noStaticElementInteractions: chart dot, see above
            <circle
              key={`${p.season}-${p.number}`}
              cx={x(i)}
              cy={y(p.rating as number)}
              r={4}
              /*
                A transparent stroke widens the HIT AREA without changing a pixel of what
                is drawn. A 4px target on a chart several hundred episodes wide is a dot
                you chase rather than one you point at.
              */
              stroke="transparent"
              strokeWidth={10}
              /*
                DELIBERATELY NOT FOCUSABLE, and this is an accessibility decision rather
                than a shortcut. An SVG `circle` cannot be a real `<button>`, and a
                focusable shape wearing `role="button"` is a promise the element cannot
                keep -- no activation behaviour, no keyboard semantics, just a tab stop
                that traps a keyboard reader in a hundred and thirty of them.

                So the chart is one labelled image, and the SAME data is reachable by
                keyboard in the two other views: every grid cell is a real button and the
                episode list is a real list. A visualisation whose content has an
                accessible equivalent elsewhere on the page is allowed to be a picture.

                No `aria-hidden` either: the parent `<svg>` already carries `role="img"`
                with a label, which makes every child presentational. Repeating it on each
                dot adds nothing and trips the focusable-hidden rule.
              */
              onMouseEnter={(e) => card.open(p, e.currentTarget)}
              onMouseLeave={card.close}
              className={`${BAND_FILL[p.band as ScoreBand]} cursor-pointer`}
            />
          ))}

          {t.bands.map((b) =>
            b.to > b.from ? (
              <text
                key={b.season}
                x={(x(b.from) + x(b.to - 1)) / 2}
                y={CHART.height - 6}
                textAnchor="middle"
                className="fill-muted text-[10px]"
              >
                {b.label}
              </text>
            ) : null,
          )}
        </svg>
      </div>
    </div>
  );
}

// --- shared bits ------------------------------------------------------------

function Empty({ children }: { children?: ReactNode }) {
  return <p className="text-sm text-muted">{children ?? "No episodes to score yet."}</p>;
}

/**
 * Stable cell ids for the placeholder grid, six seasons by eight episodes.
 *
 * Built once at module level rather than from a loop index at render: a skeleton is
 * replaced wholesale by real content, so an index key would be a key that means a
 * different thing on the next render for no benefit at all.
 */
const SKELETON_COLUMNS = Array.from({ length: 6 }, (_, s) =>
  Array.from({ length: 8 }, (_, e) => `s${s}e${e}`),
);

function _GridSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-48" />
      <div className="flex gap-1">
        {SKELETON_COLUMNS.map((column) => (
          <div key={column[0]} className="flex flex-col gap-1">
            {column.map((cell) => (
              <Skeleton key={cell} className="h-7 w-12" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Re-exported so a caller can colour something else the same way without importing two modules. */
export { BAND_CELL, bandFor };
