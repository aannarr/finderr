import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { prefetchTitle, type Title } from "../lib/api";
import { shelfDateLabel, todayUtc } from "../lib/facet-panes";
import { BrowseChip } from "./BrowseChip";
import { Poster } from "./Poster";
import { RequestAction } from "./RequestAction";

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

export const TitleCard = memo(function TitleCard({
  title: t,
  onRequest,
}: {
  title: Title;
  onRequest: (t: Title) => void;
}) {
  const owned = t.inLibrary;
  const up = t.upcoming;
  const today = todayUtc();
  // `hasFile` only means something once the episode exists. Today counts as aired: an
  // episode airing tonight may already have been grabbed, which is exactly worth showing.
  const aired = up ? up.date <= today : false;

  return (
    // h-full so the card fills its grid row or shelf slot -- without it a card with a
    // one-line title is shorter than its neighbours and the Request buttons sit at
    // different heights across the row.
    <article className="group flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface">
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
          className="absolute inset-0 z-10 cursor-pointer outline-none
                     focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        />

        {owned && (
          <span className="pointer-events-none absolute bottom-2 left-2 z-20 rounded bg-accent/85 px-1.5 py-0.5 text-[10px] font-medium text-black">
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
          shorter block, and relying on the grid to stretch is fragile here because
          `.card-grid` uses content-visibility, which skips layout for offscreen rows.
          Reserving the space makes every card the same height by construction.
        */}
        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm leading-snug font-medium" title={t.title}>
          {/* Also a link, so the destination is reachable from the text as well as
              the poster overlay above. */}
          <Link
            to="/title/$tconst"
            params={{ tconst: t.tconst }}
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

        {/* The original title is often the one a non-English speaker searched for. */}
        {t.orig && t.orig !== t.title && (
          <p className="line-clamp-1 text-xs text-muted/80 italic" title={t.orig}>
            {t.orig}
          </p>
        )}

        <div className="mt-auto pt-2">
          <RequestAction title={t} onRequest={onRequest} />
        </div>
      </div>
    </article>
  );
});
