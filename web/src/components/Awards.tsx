/**
 * The pieces every award screen is built from.
 *
 * Four screens read this file -- the timeline, the ceremony page, the title pane and the
 * person page -- and they all draw the same three things: a nomination line, a link to a
 * person or a film that may not exist, and a completion count. One owner each, because a
 * second copy of "is this name a link?" is exactly how one screen ends up linking a studio.
 *
 * > [!IMPORTANT] Nothing here is a facet, so nothing here goes through `paneView`
 * > The award tables are OURS -- imported by a job, read from local SQLite, complete the
 * > moment the response lands. There is no provider owing an answer, so there is no
 * > `pending` state, no skeleton to reserve and nothing for `FacetPane` to decide. This is
 * > the same footing `LinksRow` is on, and for the same reason.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { NominationView, Title } from "../lib/api";
import { PERSON_LINK_CLASS } from "./TitlePanes";

/**
 * A film's name, linked only when we hold a row for it.
 *
 * `titles` is the payload's map of decorated index rows. A film missing from it is one we
 * do not index -- about 1,281 of 12,137 nominations name no film id at all, and plenty
 * more name one we never ingested -- so it prints as plain text. **Navigable does not
 * outrank honest**: a link to a page that 404s is worse than a name that is merely a name.
 */
export function AwardFilmLink({
  film,
  titles,
  className = "",
}: {
  film: { title: string; tconst: string | null };
  titles: Record<string, Title>;
  className?: string;
}) {
  const row = film.tconst ? titles[film.tconst] : undefined;
  if (!row) return <span className={className}>{film.title}</span>;
  return (
    <Link to="/title/$tconst" params={{ tconst: row.tconst }} className={`${className} ${PERSON_LINK_CLASS}`}>
      {film.title}
    </Link>
  );
}

/**
 * A nominee's name, linked only when the source gave us a PERSON id.
 *
 * The source mixes company ids into the same column, and the import already dropped those
 * to `null` -- so a studio arrives here with no id and prints as text, which is correct: a
 * studio has no person page and never will.
 *
 * Unlike `AwardFilmLink` this does NOT check that we hold the person, because a person
 * page is served straight off the index's own tables and an nconst we were given is
 * overwhelmingly one we have. The cost of being wrong is one 404 on a click rather than a
 * wrong destination, which is the trade the film side cannot make -- there, the map is
 * already in hand, so checking is free.
 */
export function AwardNomineeLink({
  nominee,
  className = "",
}: {
  nominee: { name: string; nconst: string | null };
  className?: string;
}) {
  if (!nominee.nconst) return <span className={className}>{nominee.name}</span>;
  return (
    <Link
      to="/person/$nconst"
      params={{ nconst: nominee.nconst }}
      search={{}}
      className={`${className} ${PERSON_LINK_CLASS}`}
    >
      {nominee.name}
    </Link>
  );
}

/**
 * The winner's mark, and the space it holds when there is no winner.
 *
 * A fixed-width slot rather than a badge that appears and disappears: every row in a
 * category starts at the same x, so the eye reads the column of names rather than a ragged
 * left edge with one row pushed right.
 */
export function WinnerMark({ won }: { won: boolean }) {
  return (
    <span
      className={`w-10 shrink-0 pt-0.5 text-[0.65rem] font-semibold uppercase tracking-wider tabular-nums ${
        won ? "text-accent" : "text-transparent"
      }`}
      aria-hidden={!won}
    >
      {won ? "Won" : "—"}
    </span>
  );
}

/**
 * "you own 14 of 38 films", with the bar that makes the ratio readable at a glance.
 *
 * The one number Seerr structurally cannot answer, which is why it is worth a component
 * rather than a sentence. A zero denominator renders NOTHING rather than "0 of 0": a
 * ceremony whose films we cannot identify has no completion to report, and printing 0%
 * would read as a failure of the library rather than of the data.
 */
export function Completion({
  owned,
  total,
  noun,
  className = "",
}: {
  owned: number;
  total: number;
  noun: string;
  className?: string;
}) {
  if (total === 0) return null;
  const pct = Math.round((owned / total) * 100);
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="tabular-nums">
        you own {owned.toLocaleString()} of {total.toLocaleString()} {noun}
      </span>
      <span
        className="h-1 w-16 overflow-hidden rounded-full bg-surface-2"
        role="img"
        aria-label={`${pct}% of ${noun} in your library`}
      >
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/**
 * One nomination line: winner mark, what it was for, and who or what it names.
 *
 * `subject` and `credit` are given by the caller rather than derived, because the two
 * screens read the row from opposite ends. A ceremony page leads with the FILM and puts
 * the people behind it; a person page already knows who you are looking at and leads with
 * the film. Same row, same order on screen, different subject -- which is a prop, not a
 * fork.
 */
export function NominationRow({
  subject,
  credit,
  won,
  detail,
  leading,
  trailing,
}: {
  subject: ReactNode;
  credit?: ReactNode;
  won: boolean;
  detail?: string | null;
  /**
   * Drawn between the winner mark and the text -- a poster, on the screens that want one.
   *
   * A SLOT rather than a `poster` prop, and the ceremony page is the only caller filling it
   * today. A person page already knows whose page it is and lists that person's own films;
   * a column of posters there is a second, weaker answer to a question the title beside it
   * already answers. So the row does not decide, the screen does.
   */
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 py-1.5 text-sm">
      <WinnerMark won={won} />
      {leading}
      <span className="min-w-0 flex-1">
        <span className={won ? "text-ink" : "text-ink/85"}>{subject}</span>
        {credit && <span className="text-muted"> · {credit}</span>}
        {/*
          The source's own qualifier -- a song title, a character name. Quoted rather than
          italicised: it is a title within a line, and italics at this size on a dark
          surface is closer to invisible than to emphasis.
        */}
        {detail && <span className="text-muted"> “{detail}”</span>}
      </span>
      {trailing}
    </li>
  );
}

/** Join nominee names into one line, each linked where it can be. */
export function NomineeList({ nominees }: { nominees: NominationView["nominees"] }) {
  return (
    <>
      {nominees.map((n, i) => (
        // The name is not unique within a row (a person can be credited twice) and there is
        // no id to key on for a studio, so position is the only stable key available. The
        // list never reorders -- it is the source's own order, rendered once.
        // biome-ignore lint/suspicious/noArrayIndexKey: source order, never reordered, names not unique
        <span key={`${n.nconst ?? n.name}-${i}`}>
          {i > 0 && ", "}
          <AwardNomineeLink nominee={n} />
        </span>
      ))}
    </>
  );
}

/**
 * Where the data came from, and under what licence.
 *
 * A page that states a fact about 98 years of history should be able to say where it read
 * it. The COMMIT is what makes that truthful -- `oscar_data` is a living repo, so a date
 * alone cannot identify what we parsed -- and a null sha says so out loud rather than
 * quietly printing the import date as if it were provenance.
 */
export function AwardSourceLine({
  source,
  className = "",
}: {
  source: { sha: string | null; licence: string; attribution: string; importedAt: string } | null;
  className?: string;
}) {
  if (!source) return null;
  const when = new Date(source.importedAt);
  return (
    <p className={`text-xs text-muted ${className}`}>
      Data from {source.attribution} ({source.licence}),{" "}
      {source.sha ? (
        <>
          commit <span className="font-mono">{source.sha.slice(0, 7)}</span>
        </>
      ) : (
        "revision unknown"
      )}
      , imported {Number.isNaN(when.getTime()) ? "at an unknown time" : when.toLocaleDateString()}.
    </p>
  );
}
