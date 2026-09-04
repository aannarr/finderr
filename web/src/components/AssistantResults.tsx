/**
 * What an assistant answer draws BESIDE its prose.
 *
 * The rule this file exists to hold: an answer that names things must draw the things. A
 * paragraph saying "The Wire, seasons 2 and 3" is a dead end -- the reader has to go and
 * search for what they were just told about -- so a named title becomes a poster card that
 * links to its page, and a named episode becomes a row that does. That is the same
 * "every noun on screen is a destination" rule the rest of the product follows; the panel
 * is not exempt from it because the text came from a model.
 *
 * Every block here is EMPTY-SAFE and returns `null` for an empty list. The answer decides
 * what it has to show, and a heading over nothing is the shape `FacetPane` refuses too.
 */

import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Download } from "lucide-react";
import type { AgentEpisode, AgentRequested, AgentTitle, AgentToolCall } from "../lib/agent-api";
import {
  declinedOf,
  declinedPhrase,
  episodeCode,
  episodeScore,
  formatDuration,
  formatToolArgs,
  hasScore,
  queuedOf,
  requestedDetail,
  requestedHeading,
  requestedNoun,
} from "../lib/assistant-view";
import { localImageUrl, problemNote } from "../lib/facet-panes";
import type { FacetProblem } from "../lib/facets";
import { Poster } from "./Poster";

/**
 * The small uppercase label over each block.
 *
 * The SAME chrome `Pane variant="rail"` wears, because these are the same thing: a tight
 * heading over a compact block in a narrow column. It is spelt out rather than imported
 * because `Pane` draws a `<section><h3>` and these are subsections of one message -- an
 * `<h3>` per block would put four headings inside every answer's outline.
 */
const BLOCK_LABEL = "mb-1.5 text-[0.7rem] font-medium uppercase tracking-wider text-muted";

/**
 * Titles the answer named, as cards.
 *
 * THREE ACROSS, and the poster is the whole card. The panel is about 400px wide, which is
 * roughly one grid row of `TitleGrid` -- so this is `TitleCard`'s shape at a smaller size
 * rather than a new one. It is NOT `TitleCard` itself, and cannot be: that component draws
 * a Request button, a library badge and a vote count from a decorated index row, and an
 * `AgentTitle` carries none of those. Drawing it with faked fields would put "Request" on a
 * card that has no idea whether we already hold the film.
 */
export function AgentTitles({ titles }: { titles: readonly AgentTitle[] }) {
  if (titles.length === 0) return null;
  return (
    <div>
      <p className={BLOCK_LABEL}>{titles.length === 1 ? "Title" : "Titles"}</p>
      <ul className="grid grid-cols-3 gap-2">
        {titles.map((t) => (
          <li key={t.tconst}>
            <Poster
              // `localImageUrl` even though the server says this is already same-origin.
              // The guard is not conditional on trusting the sender: it is what stops an
              // upstream URL reaching an `<img>`, and this payload is assembled from what a
              // MODEL referred to, which is the least trustworthy path into this app.
              // Refused here means `posterUrl` sees null and the fallback tile draws.
              title={{ tconst: t.tconst, title: t.title, posterUrl: localImageUrl(t.poster) }}
              size="w185"
              fallback="tile"
              link
              alt={`Details for ${t.title}`}
              className="aspect-2/3 w-full overflow-hidden rounded-lg bg-surface-2"
            />
            <p className="mt-1 line-clamp-2 text-xs leading-snug" title={t.title}>
              <Link
                to="/title/$tconst"
                params={{ tconst: t.tconst }}
                className="outline-none hover:underline focus-visible:underline"
              >
                {t.title}
              </Link>
            </p>
            {t.year !== null && <p className="text-[0.7rem] tabular-nums text-muted">{t.year}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Episodes the answer named.
 *
 * Rows rather than cards, and no still: the same call `SeriesPane` makes for the same
 * reason -- one image per row over a list is a different screen from the one episode
 * numbers and scores are for.
 *
 * The row links to the SERIES, because that is the page finderr has. An episode has no
 * destination of its own, and inventing `/title/<parent>#s2e9` would be a link to an anchor
 * nothing renders.
 */
export function AgentEpisodes({ episodes }: { episodes: readonly AgentEpisode[] }) {
  if (episodes.length === 0) return null;
  return (
    <div>
      <p className={BLOCK_LABEL}>{episodes.length === 1 ? "Episode" : "Episodes"}</p>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {episodes.map((e) => (
          <li key={e.tconst} className="flex items-baseline gap-2 px-2.5 py-1.5 text-xs">
            <Link
              to="/title/$tconst"
              params={{ tconst: e.parent }}
              className="shrink-0 font-medium tabular-nums text-muted outline-none hover:text-ink hover:underline focus-visible:underline"
            >
              {episodeCode(e.season, e.number)}
            </Link>
            <span className="line-clamp-1 flex-1" title={e.title ?? undefined}>
              {e.title ?? <span className="text-muted italic">Untitled</span>}
            </span>
            {/*
              A missing score is MUTED AND ITALIC and a real one is tabular ink, so the two
              never read as the same kind of value at a glance. See `episodeScore`: the
              whole point is that a blank or a zero here would be a claim we made up.
            */}
            <span
              className={
                hasScore(e.rating)
                  ? "shrink-0 tabular-nums text-ink"
                  : "shrink-0 text-[0.7rem] text-muted italic"
              }
            >
              {episodeScore(e.rating)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the assistant ASKED FOR -- the one block that reports a side effect.
 *
 * > [!IMPORTANT] This is the loudest thing in the panel, deliberately
 * > Everything else here is a read. This one spent disk and bandwidth on somebody's server
 * > and cannot be undone from this screen, so it is drawn as an accent-tinted panel with a
 * > verb rather than as another muted list: "Started downloading 1 film", not "Requested".
 * > The failure this avoids is a reader skimming an answer, missing a line that reads like
 * > every other line, and finding out from the queue badge.
 *
 * It draws no Undo, and that is honest rather than lazy: cancelling means deleting from the
 * arr, which is `/requests` and an admin's job, not a chat panel's.
 */
export function AgentRequests({ requested }: { requested: readonly AgentRequested[] }) {
  const queued = queuedOf(requested);
  const declined = declinedOf(requested);
  if (queued.length === 0 && declined.length === 0) return null;
  return (
    <>
      {/*
        THE LOUD HALF: things that actually went out. `queuedOf` is what keeps this honest --
        see its note. A refusal drawn in this panel would be a claim that disk and bandwidth
        were spent, which is the one thing on this screen a reader cannot check for
        themselves.
      */}
      {queued.length > 0 && (
        <div className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
            <Download className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
            {requestedHeading(queued)}
          </p>
          <ul className="mt-1 space-y-0.5">
            {queued.map((r) => (
              <li key={requestKey(r)} className="text-xs">
                <Link
                  to="/title/$tconst"
                  params={{ tconst: r.tconst }}
                  className="outline-none hover:underline focus-visible:underline"
                >
                  {r.title}
                </Link>
                <span className="text-muted">
                  {" · "}
                  {requestedDetail(r) ?? requestedNoun(r.kind)}
                </span>
              </li>
            ))}
          </ul>
          {/* Where the outcome actually shows up. A request is asynchronous -- the arr may
              refuse it minutes later -- and this panel never hears about that. */}
          <p className="mt-1.5 text-[0.7rem] text-muted">
            <Link to="/requests" className="underline underline-offset-2 hover:text-ink">
              Requests
            </Link>{" "}
            has the progress and the outcome.
          </p>
        </div>
      )}

      {/*
        THE QUIET HALF: things it tried and did not do. Shown rather than dropped, because
        "I asked for Heat" with nothing on screen leaves a reader believing a download
        started. It is muted and unpanelled precisely so it cannot be mistaken for the block
        above at a glance.
      */}
      {declined.length > 0 && (
        <ul className="space-y-0.5">
          {declined.map((r) => (
            <li key={requestKey(r)} className="text-[0.7rem] text-muted">
              <Link
                to="/title/$tconst"
                params={{ tconst: r.tconst }}
                className="outline-none hover:text-ink hover:underline focus-visible:underline"
              >
                {r.title}
              </Link>
              {requestedDetail(r) && <span> {requestedDetail(r)}</span>}
              {` · not requested, ${declinedPhrase(r.status)}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * A stable key for one outcome.
 *
 * The tconst alone is not unique: asking for two episodes of one series produces two
 * entries under the same id, which React renders as a duplicate key and then reuses the
 * wrong row when the list changes.
 */
function requestKey(r: AgentRequested): string {
  return `${r.kind}:${r.tconst}:${r.season ?? ""}:${r.episode ?? ""}`;
}

/**
 * What the assistant did to answer, COLLAPSED.
 *
 * A `<details>` rather than a state flag: it is the browser's own disclosure, it is
 * keyboard-operable for free, and `summary` is in the accessibility tree as a button
 * without anything here saying so. The same reason `TitleFactsCard` uses one on mobile.
 *
 * Closed by default because it is diagnostics. It exists so a reader can tell an answer
 * that consulted the index from one the model recited from memory, which is the difference
 * between a fact about this library and a plausible sentence.
 */
export function AgentToolCalls({ calls, summary }: { calls: readonly AgentToolCall[]; summary: string }) {
  if (calls.length === 0) return null;
  return (
    <details className="group rounded-lg border border-line bg-surface/60">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-1.5 text-[0.7rem] text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
        <ChevronRight
          className="size-3 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        {summary}
      </summary>
      <ul className="space-y-1 border-t border-line px-2.5 py-1.5">
        {calls.map((c, i) => (
          <li
            // An index key is correct here for the same reason it is in `SkeletonRepeat`:
            // the list is rendered once from a frozen answer, never reorders, never grows
            // and never has an item removed -- and the same tool called twice is a real and
            // ordinary thing, so the name is not a name.
            // biome-ignore lint/suspicious/noArrayIndexKey: a settled answer's calls never reorder
            key={i}
            className="text-[0.7rem] leading-relaxed"
          >
            <span className="font-medium text-ink">{c.name}</span>
            <span className="text-muted"> · {formatDuration(c.ms)}</span>
            <code className="ml-1 break-all text-muted/80">{formatToolArgs(c.args)}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * An addon broke while the assistant was working.
 *
 * `problemNote` is the owner of the sentence, so this says the same words in the same
 * order that a failed pane on the title page says -- one vocabulary for "an addon is
 * broken" rather than a second one invented for the panel.
 */
export function AgentProblems({ problems }: { problems: readonly FacetProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <p className="flex items-start gap-1.5 text-[0.7rem] text-muted">
      <AlertTriangle className="mt-px size-3 shrink-0 text-warn" aria-hidden="true" />
      {problemNote(problems)}
    </p>
  );
}
