import { Link } from "@tanstack/react-router";
import { memo, useState } from "react";
import { posterUrl, prefetchTitle, type Title } from "../lib/api";
import { shelfDateLabel } from "../lib/facet-panes";
import { BrowseChip } from "./BrowseChip";

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

/** Today as a plain UTC date, matching how the mirror stores one. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The fallback tile's monogram.
 *
 * Posters resolve through the arr metadata proxies, but not every title has one --
 * the long tail of the IMDb index is full of things nobody has ever made art for.
 * The tile is the permanent background, not a loading state, so those cards look
 * deliberate rather than broken.
 */
function initials(t: string): string {
  return t
    .replace(/^(the|a|an) /i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** Deterministic hue per title so the grid is varied but stable across renders. */
function hue(tconst: string): number {
  let h = 0;
  for (let i = 0; i < tconst.length; i++) h = (h * 31 + tconst.charCodeAt(i)) % 360;
  return h;
}

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
  const requested = t.requestStatus !== null;
  const owned = t.inLibrary;
  const up = t.upcoming;
  const today = todayUtc();
  // `hasFile` only means something once the episode exists. Today counts as aired: an
  // episode airing tonight may already have been grabbed, which is exactly worth showing.
  const aired = up ? up.date <= today : false;

  const poster = posterUrl(t);
  // The tile is not a "loading" state -- it is the permanent background. The poster
  // fades in over it, so a title with no artwork simply keeps the tile and a slow
  // fetch never shows a hole.
  const [posterFailed, setPosterFailed] = useState(false);
  const [posterLoaded, setPosterLoaded] = useState(false);

  return (
    // h-full so the card fills its grid row or shelf slot -- without it a card with a
    // one-line title is shorter than its neighbours and the Request buttons sit at
    // different heights across the row.
    <article className="group flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div
        className="relative flex aspect-2/3 shrink-0 items-center justify-center"
        style={{
          background: `linear-gradient(155deg, oklch(0.32 0.07 ${hue(t.tconst)}), oklch(0.20 0.03 ${hue(t.tconst)}))`,
        }}
      >
        <span className="text-3xl font-bold tracking-tight text-white/25 select-none">
          {initials(t.title)}
        </span>

        {poster && !posterFailed && (
          <img
            src={poster}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setPosterLoaded(true)}
            onError={() => setPosterFailed(true)}
            className={[
              "absolute inset-0 size-full object-cover transition-opacity duration-300",
              posterLoaded ? "opacity-100" : "opacity-0",
            ].join(" ")}
          />
        )}

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
            THE DATE REPLACES THE VOTE COUNT, it does not sit beside it.

            An upcoming title has few votes or none -- that is the whole reason the old
            shelf could not rank these and had to be replaced by a dated mirror. Printing
            "2k" next to a release date spends the line's remaining width on the one number
            here that is guaranteed to be meaningless.
          */}
          {up ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-ink">{shelfDateLabel(up.date, today)}</span>
              {DATE_KIND_LABEL[up.dateKind] && (
                <span className="text-muted/80">{DATE_KIND_LABEL[up.dateKind]}</span>
              )}
            </>
          ) : (
            t.votes > 0 && (
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
            )
          )}
        </div>

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
          {owned ? (
            <span className="block rounded-lg border border-line px-2 py-1.5 text-center text-xs text-muted">
              {t.hasFile ? "Available" : "Monitored"}
            </span>
          ) : requested ? (
            <span
              className={[
                "block rounded-lg px-2 py-1.5 text-center text-xs",
                t.requestStatus === "failed" || t.requestStatus === "no_release"
                  ? "border border-danger/50 bg-danger/10 text-ink"
                  : "border border-warn/40 bg-warn/10 text-ink",
              ].join(" ")}
            >
              {t.requestStatus === "no_release" ? "No release found" : t.requestStatus}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onRequest(t)}
              className="w-full rounded-lg bg-accent px-2 py-1.5 text-xs font-medium text-black
                         transition-opacity hover:opacity-90 active:opacity-75"
            >
              Request
            </button>
          )}
        </div>
      </div>
    </article>
  );
});
