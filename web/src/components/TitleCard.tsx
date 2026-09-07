import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { todayUtc } from "../../../src/lib/episodes";
import { prefetchTitle, type Title } from "../lib/api";
import { cardSubtitle, foreignLanguage, shelfDateLabel } from "../lib/facet-panes";
import { jumpAriaKeyShortcut } from "../lib/jump-keys";
import { browserLocales } from "../lib/reader-locale";
import { AwardChip } from "./AwardChip";
import { BrowseChip } from "./BrowseChip";
import { JumpBadge, useJumpKey } from "./JumpKeys";
import { Poster } from "./Poster";
import { RequestAction } from "./RequestAction";
import { SaveToWatchlist } from "./SaveToWatchlist";

/**
 * What KIND of date this is, spelt for a reader.
 *
 * Without it "Releasing soon" showed The Golden Child (1986) with no hint that what
 * releases on 2 September is a STREAMING edition of a forty-year-old film, and the card
 * read as a bug. `airDate` maps to nothing because the shelf it appears on already says
 * "Airing", and repeating it in every row is noise.
 *
 * There is no `physical` entry because a disc date is never tracked -- see
 * `radarrUpcomingRows`. Two kinds remain and both answer "when can I watch this".
 */
const DATE_KIND_LABEL: Record<string, string> = {
  cinemas: "in cinemas",
  digital: "streaming",
};

// `initials` and `hue` moved to `./Poster` with the drawing they belong to. They were
// only ever the fallback tile's business, and the tile is that component's job now.

const KIND_LABEL: Record<string, string> = {
  movie: "Film",
  tvSeries: "Series",
  tvMiniSeries: "Mini",
  tvMovie: "TV film",
};

/**
 * One line of context a SURFACE adds to a card, that the title itself does not carry.
 *
 * The award mark below is a fact about the TITLE, so it rides on the row from `decorate()`
 * and every grid in the product draws it without asking. This is the other kind: a fact
 * about why this card is on THIS page. The filmography's "Ellen Ripley" is true of a
 * (person, title) pair and means nothing in a search grid, so it cannot be a field on
 * `Title` -- it arrives from the route that knows the pairing.
 *
 * **`full` is the whole truth and `text` is what fits.** The card is about 150px wide, so
 * the line is clamped and `full` goes in the `title` attribute -- the same hover idiom the
 * original-title line and the episode title already use here. Pass them equal when there is
 * nothing more to reveal; the tooltip is then merely the untruncated text, which is still
 * worth having at that width.
 *
 * Deliberately a STRING rather than a `ReactNode`: a slot that takes arbitrary markup is a
 * slot that will eventually carry a link, a button and a second image, and this card's
 * layout is already the thing three comments below are defending. A note that needs to be
 * more than a line of text is a different component.
 */
export interface CardNote {
  /** The one line drawn under the card, clamped to a single line. */
  text: string;
  /** Everything `text` was chosen from, revealed on hover. */
  full: string;
}

export const TitleCard = memo(function TitleCard({
  title: t,
  onRequest,
  onOpen,
  requestShortcut,
  note,
}: {
  title: Title;
  onRequest: (t: Title) => void;
  /**
   * What this card means HERE -- a role on a filmography, and nothing anywhere else yet.
   *
   * Absent is the ordinary case, exactly like `onOpen` above: a surface with nothing extra
   * to say passes nothing and draws nothing, so no grid pays a line it did not ask for.
   */
  note?: CardNote | null;
  /**
   * The enclosing grid answers `⌘⏎` for whichever card has focus, so this card's request
   * button may say so.
   *
   * A prop rather than something the card assumes, because `TitleCard` is also drawn in the
   * related-titles row on the title page, where `⌘⏎` is bound to the page's own title
   * instead. Announcing it there would teach a key that requests the wrong film.
   */
  requestShortcut?: string;
  /**
   * The card was OPENED -- both links, one meaning.
   *
   * A prop rather than a second kind of card, because only the search grid has anything to
   * say about a click (which query, at what rank) and every other grid in the product draws
   * the same component with nothing to report. Absent is the ordinary case.
   */
  onOpen?: () => void;
}) {
  const owned = t.inLibrary;
  const up = t.upcoming;
  const today = todayUtc();
  // `hasFile` only means something once the episode exists. Today counts as aired: an
  // episode airing tonight may already have been grabbed, which is exactly worth showing.
  const aired = up ? up.date <= today : false;
  // Null on every page with no `JumpKeysProvider`, and on any card not currently on
  // screen -- so this costs nothing and draws nothing outside the grid routes.
  const jump = useJumpKey();
  const jumpLabel = jump.active ? jump.label : null;
  /*
    What language this is in, when that is not one the reader already reads.

    `null` for the overwhelming majority of cards -- a title in the reader's own language,
    a title nothing knows the language of, and every title on an index built before the
    `lang` column existed all land here. `foreignLanguage` owns the whole rule; this line
    only decides WHO is asking, and it asks the browser rather than `config.languages`
    for the reason stated there.

    Read per card rather than lifted to the grid: `browserLocales()` reads two properties
    off `navigator` and this is not a hook, so a shelf of thirty pays nothing measurable
    for it, and the alternative is a prop threaded through every grid, shelf and row in
    the product to hand each card a value it can ask for itself.
  */
  const subtitle = cardSubtitle(t.title, t.orig, foreignLanguage(t.lang, browserLocales()));

  return (
    // h-full so the card fills its grid row or shelf slot -- without it a card with a
    // one-line title is shorter than its neighbours and the Request buttons sit at
    // different heights across the row.
    <article
      ref={jump.ref}
      // The handle every keyboard feature addresses a card by; `lib/card-dom.ts` says why
      // the three markers are named there rather than being guessed at by selector.
      data-card=""
      className="group flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface"
    >
      {/*
        The badges sit INSIDE the poster's frame, so this stays a positioned box of its own
        rather than being folded into `<Poster>`. The component owns the artwork and its
        fallback; what is overlaid on top is the card's business and no other screen's.
      */}
      <div className="relative aspect-2/3 shrink-0">
        <Poster title={t} fallback="tile" className="absolute inset-0 size-full overflow-hidden" />

        <span className="absolute top-2 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/80">
          {KIND_LABEL[t.kind] ?? t.kind}
        </span>

        {t.rating > 0 && (
          <span className="absolute top-2 right-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] tabular-nums text-white/85">
            ★ {t.rating.toFixed(1)}
          </span>
        )}

        {/*
          The WHOLE poster is the link.

          It sits above the image and below the badges so the badges stay readable,
          and it carries no children, so there is no interactive element nested inside
          a link -- the Request button lives outside the poster entirely. A title-only
          link was undiscoverable: nothing on a poster suggested it was clickable.
        */}
        <Link
          to="/title/$tconst"
          params={{ tconst: t.tconst }}
          aria-label={`Details for ${t.title}`}
          /*
            Warm the title on intent, so the click paints from cache and the server's
            facet resolver has already been kicked. `onFocus` as well as hover, or the
            whole optimisation would be mouse-only -- this app is meant to be driveable
            from the keyboard.

            No debounce: `prefetchTitle` already no-ops for anything cached or in
            flight, so dragging the pointer across a grid costs one request per card at
            most and none for cards you have seen. Putting a timer here would be a
            second owner of "is this worth fetching".
          */
          onMouseEnter={() => prefetchTitle(t.tconst)}
          onFocus={() => prefetchTitle(t.tconst)}
          // Both links report, because both go to the same place and a reader who clicks
          // the title text opened the card exactly as much as one who clicked the poster.
          onClick={onOpen}
          /*
            THE CARD'S PRIMARY LINK: what `JumpKeysProvider` clicks and what the grid's
            arrow keys focus, marked rather than found by position so neither feature has
            its own idea of which link a card's is. See `lib/card-dom.ts`.
            It is also the one a reader focusing this card lands on, so the shortcut is
            announced on the element that answers to it.
          */
          data-card-link=""
          aria-keyshortcuts={jumpLabel ? jumpAriaKeyShortcut(jumpLabel) : undefined}
          className="absolute inset-0 z-10 cursor-pointer outline-none
                     focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        />

        {/* Over the poster, above the link, only while navigation mode is open. */}
        {jumpLabel && <JumpBadge label={jumpLabel} />}

        {/*
          The badge answers ONE question -- is the file here -- and the colour is what
          answers it. The footer's `RequestAction` answers the other one (what is happening
          about it), so the two never restate each other.

          Both states wore `bg-accent/85` until 2026-09-07, which made "Monitored" as loud
          and as green as "In library" and left the words as the only difference between
          having a film and not having it. aannarr, from a live shelf. Amber is the same
          "keep waiting" this product already uses for a download in flight
          (`TONE_SHELL.working`), so the badge and the chip under it agree by construction.
        */}
        {owned && (
          <span
            className={[
              "pointer-events-none absolute bottom-2 left-2 z-20 rounded px-1.5 py-0.5",
              "text-[10px] font-medium text-black",
              t.hasFile ? "bg-accent/85" : "bg-warn/85",
            ].join(" ")}
          >
            {t.hasFile ? "In library" : "Monitored"}
          </span>
        )}

        {/*
          Bottom-right is the one free corner (kind top-left, rating top-right,
          library state bottom-left).

          The chip is NOT decoration: most Kometa marks are white or near-white on
          transparent, so without a dark backing they vanish on a pale poster.
          Height is fixed and width runs auto because the marks are not a uniform
          aspect -- Warner Bros is 285x85, FX is 152x85 -- and max-w stops the wide
          ones from spanning the card.
        */}
        {t.studioLogo && (
          <span className="pointer-events-none absolute right-2 bottom-2 z-20 flex items-center rounded bg-black/55 px-1.5 py-1">
            <img
              src={t.studioLogo}
              alt={t.studio ?? ""}
              title={t.studio ?? undefined}
              loading="lazy"
              decoding="async"
              className="h-3.5 w-auto max-w-18 object-contain opacity-90"
            />
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-2.5">
        {/*
          Always reserve two lines. Clamping alone still lets a one-line title make a
          shorter block, so a row of cards would end up ragged and the grid's own row
          height would depend on whichever title happened to wrap. Reserving the space
          makes every card the same height by construction.
        */}
        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm leading-snug font-medium" title={t.title}>
          {/* Also a link, so the destination is reachable from the text as well as
              the poster overlay above. */}
          <Link
            to="/title/$tconst"
            params={{ tconst: t.tconst }}
            onClick={onOpen}
            className="outline-none hover:underline focus-visible:underline"
          >
            {t.title}
          </Link>
        </h3>

        <div className="flex items-center gap-1.5 text-xs text-muted">
          {/*
            The year is an exit here too, but `inline` rather than a pill: a card
            already spends its weight on the poster and the title, and a third pill
            in this line would compete with both. No decade chip on a card for the
            same reason -- the detail page is where that belongs.
          */}
          {t.year && (
            <span className="tabular-nums">
              <BrowseChip filters={{ year: t.year, kind: t.kind }} label={String(t.year)} tone="inline" />
            </span>
          )}
          {/*
            THE VOTE COUNT IS DROPPED ON AN UPCOMING CARD, not shown beside the date.

            An upcoming title has few votes or none -- that is the whole reason the old
            shelf could not rank these and had to be replaced by a dated mirror. Printing
            "2k" next to a release date spends the line's remaining width on the one number
            here that is guaranteed to be meaningless.
          */}
          {!up && t.votes > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {t.votes >= 1_000_000
                  ? `${(t.votes / 1e6).toFixed(1)}M`
                  : t.votes >= 1000
                    ? `${Math.round(t.votes / 1000)}k`
                    : t.votes}
              </span>
            </>
          )}
        </div>

        {/*
          What the SURFACE has to say about this card, ABOVE the award.

          Ordering is not taste. A note is present on every card of the page that supplies
          one, and an award is on almost none -- so putting the note first gives it a fixed
          position a reader's eye can settle on, and the rare award line appears below it
          rather than shoving it down a row on the two cards that won something.

          It reads as the ANSWER to the page: on a filmography the reader arrived asking
          "what did they do", so the character or the job outranks a prize the film won.

          `line-clamp-1` rather than `truncate`, matching the original-title line below: both
          are prose that may be long, and both put the whole of it in `title` for the hover.
        */}
        {note && (
          <p className="line-clamp-1 text-xs text-muted" title={note.full}>
            {note.text}
          </p>
        )}

        {/*
          The award mark gets its OWN line, for the reason the date below does: `1994 ·
          2.1M · Best Picture` is four elements on a card about 150px wide, and the phrase
          that loses the race breaks mid-word. `truncate` on the chip means a long prize name
          ends in an ellipsis rather than pushing the card wider.

          Only ever a WIN of the award's top prize -- `award` is null for everything else,
          including a title on an index with no awards imported, so this line does not exist
          on the overwhelming majority of cards.
        */}
        {t.award && (
          <p className="min-w-0 text-xs">
            <AwardChip mark={t.award} />
          </p>
        )}

        {/*
          The date gets its OWN line, and never wraps.

          It shared the year's line until aannarr caught "Wed," and "Sep 2" broken across
          two lines on the live shelf: `year · Wed, Sep 2 · streaming` is four elements in
          a card about 150px wide and the flex row had nowhere to put them. A date split
          mid-phrase is harder to read than one given its own line, so the break moves to
          where it was always going to happen and the date is `nowrap` on the near side.

          `truncate` sits on the KIND, not the date: if something has to be lost at a
          narrow width it should be the word "streaming", never which day it lands.
        */}
        {up && (
          <p className="flex items-baseline gap-1.5 text-xs">
            <span className="shrink-0 font-medium whitespace-nowrap text-ink">
              {shelfDateLabel(up.date, today)}
            </span>
            {DATE_KIND_LABEL[up.dateKind] && (
              <>
                <span aria-hidden="true" className="shrink-0 text-muted">
                  ·
                </span>
                <span className="truncate text-muted">{DATE_KIND_LABEL[up.dateKind]}</span>
              </>
            )}
          </p>
        )}

        {/*
          The episode line: which one, and whether we HOLD it.

          "Do I have that episode" is the question this shelf was built to answer, and it
          is only answerable once the episode has aired -- `hasFile` on something airing
          next Tuesday is false for everybody. So the badge is drawn only for an episode
          that is already out, and a future one shows the episode without a verdict.
        */}
        {up?.detail && (
          <p className="flex items-baseline gap-1.5 text-xs">
            <span className="shrink-0 font-medium text-muted">{up.detail}</span>
            {up.episodeTitle && (
              <span className="line-clamp-1 text-muted/70 italic" title={up.episodeTitle}>
                {up.episodeTitle}
              </span>
            )}
          </p>
        )}
        {up?.detail && aired && up.hasFile !== null && (
          <p className={["text-xs font-medium", up.hasFile ? "text-muted" : "text-warn"].join(" ")}>
            {up.hasFile ? "Episode downloaded" : "Episode not downloaded"}
          </p>
        )}

        {/*
          What this is called at home, and what language that is. ONE line, either half
          optional, and the reason they share a line rather than taking two:

          The original title is often the one a non-English speaker searched for, and the
          language is what says whether a reader could watch it at all -- but they answer
          the same question ("what am I actually looking at"), and a card 150px wide has
          already spent a line each on the year and on an award. So `Colisión · Spanish`
          when we have both, and either one alone when we do not.

          NEITHER HALF IMPLIES THE OTHER, which is why this is not nested. `La Cible` is a
          French series whose original title IS its title, so it draws a language and no
          italic; a Swedish film with an English release title draws both; `SWAT Exiles`
          draws neither and this element does not exist. Hiding the language behind
          `t.orig` -- the shape the first draft had -- silently drops it for every title
          whose two titles happen to match.

          The italic is on the TITLE only: a title in another script or language is being
          quoted, and the language beside it is a label rather than a name.
        */}
        {(subtitle.original || subtitle.language) && (
          <p className="line-clamp-1 text-xs text-muted/80" title={subtitle.original ?? undefined}>
            {subtitle.original && <span className="italic">{subtitle.original}</span>}
            {subtitle.original && subtitle.language && <span aria-hidden="true"> · </span>}
            {subtitle.language}
          </p>
        )}

        {/*
          Request and Save, side by side, at deliberately different weights.

          Request keeps the whole accent-filled button and the width it always had; saving is
          a bordered square beside it. They are not alternatives -- you can ask for a film and
          also keep a note of one you are not asking for -- and only one of them spends the
          household's disk, which is why the cheaper one looks cheaper.
        */}
        <div className="mt-auto flex items-stretch gap-1.5 pt-2">
          <div className="min-w-0 flex-1">
            <RequestAction title={t} onRequest={onRequest} shortcut={requestShortcut} />
          </div>
          <SaveToWatchlist title={t} />
        </div>
      </div>
    </article>
  );
});
