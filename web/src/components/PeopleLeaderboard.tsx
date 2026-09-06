/**
 * A ranked column of people, whatever they are ranked on.
 *
 * The board KNOWS nothing about awards: it draws a heading, an optional caveat, and a numbered
 * list of names each carrying a count and a second fact. What the count means arrives in the
 * payload -- `unit` names it, `note` phrases the fact beside it -- which is what lets a second
 * ranking source (most-credited directors, say) reuse this instead of growing its own page.
 *
 * A component rather than markup inside the route, for exactly that reason: the ranking is
 * the parameter and the page is not.
 */

import type { PersonLeaderboard } from "../../../src/lib/people-leaderboard";
import { AwardNomineeLink } from "./Awards";

export function PeopleLeaderboard({ board }: { board: PersonLeaderboard }) {
  return (
    <section className="mt-8">
      <div className="mb-1 border-b border-line pb-1">
        <h3 className="text-sm font-medium text-ink">{board.title}</h3>
      </div>
      {/*
        The caveat sits UNDER the heading and above the names, where somebody about to
        screenshot the list has already read it. A footnote at the bottom of twenty-five rows
        is a footnote nobody screenshots.
      */}
      {board.blurb && <p className="mb-2 max-w-prose text-xs text-muted">{board.blurb}</p>}

      {/* A real `ol`: the position IS the content here, so the browser should number it. */}
      <ol className="mt-2">
        {board.entries.map((entry, i) => (
          <li key={entry.nconst} className="flex items-baseline gap-3 py-1.5 text-sm">
            {/*
              The rank, drawn rather than left to the list marker so it can be tabular and
              right-aligned -- a ragged "1." over "25." is what makes a leaderboard look
              hand-made. `aria-hidden` because the `ol` already tells a screen reader the
              position, and hearing it twice is worse than not seeing it once.
            */}
            <span className="w-6 shrink-0 text-right text-xs text-muted tabular-nums" aria-hidden="true">
              {i + 1}
            </span>

            <span className="min-w-0 flex-1">
              {/*
                The same link the ceremony page and the title pane draw, on the same terms:
                an nconst goes to a person page and anything without one is plain text. Every
                row here has an id -- `award_nominee` only ever held people -- so the fallback
                is unreachable from this board and present because the contract is shared.
              */}
              <AwardNomineeLink nominee={{ name: entry.name, nconst: entry.nconst }} className="text-ink" />
              {entry.note && <span className="text-muted"> · {entry.note}</span>}
            </span>

            <span className="shrink-0 text-xs text-muted tabular-nums">
              {entry.value} {entry.value === 1 ? board.unit.one : board.unit.many}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
