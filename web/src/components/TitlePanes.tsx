/**
 * The title page's facet panes, in three regions the route mounts separately:
 * `TitleMainPanes` (the reading flow beside the poster rail), `TitleFactsCard` (the
 * compact lookup facts, in the rail on desktop and a collapsed `<details>` on
 * mobile), and `TitleLowerPanes` (the full-width rows below the grid).
 *
 * Nine panes of one facet each, plus `SeriesPane`, which needs two that resolve
 * independently. All of them are built on `FacetPane`, so every one draws content,
 * reserves space, or disappears by the same rule. They are ordinary components on
 * purpose: the pane-registry card gives plugins slots to author their own, and it
 * refactors these into that shape once there is a plugin asking for one.
 *
 * Nothing here checks whether the title is a film or a series. `seasons` and `episodes`
 * are declared `entities: ["series"]`, so a film is served no such facet and the series
 * pane hides itself -- the same path an unanswered facet takes on any other title.
 *
 * Every skeleton here is sized to the content it replaces, which is why the geometry of
 * a cast tile or a chip lives in a constant used by BOTH the real thing and its
 * placeholder. Two hand-matched sizes are two sizes that drift, and the drift shows up
 * as the layout shift this whole card exists to avoid.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { EpisodeState, RenderedPane, Title, TitleAwards } from "../lib/api";
import { useApp } from "../lib/app-context";
import { prettyCategory } from "../lib/awards-format";
import {
  byBillingOrder,
  entityKindOf,
  externalHref,
  formatCalendarDate,
  formatRatingValue,
  formatVotes,
  groupCrewByJob,
  imdbUrl,
  initialsOf,
  languageNames,
  localImageUrl,
  localImdbRating,
  mergeRatings,
  paneView,
  personNameKey,
  pickCertification,
  pickWatchProviders,
  preferredCountries,
  ratingKindLabel,
  ratingLogo,
  releaseRows,
  sourceName,
  titleLinks,
  trailerLinks,
  type WatchService,
  watchServices,
} from "../lib/facet-panes";
import type {
  CastMember,
  Certification,
  CrewMember,
  FacetName,
  Keyword,
  Language,
  Rating,
  ReleaseDates,
  ResolvedFacets,
  Synopsis,
  Trailer,
  WatchProviders,
} from "../lib/facets";
import { NominationRow, NomineeList } from "./Awards";
import { InertChip } from "./Chip";
import { FacetPane, Pane, Skeleton, SkeletonLines, SkeletonRepeat } from "./FacetPane";
import { PluginPanes, panesForSlot } from "./PluginPane";
import { SeriesPane } from "./SeriesPane";
import { TitleCard } from "./TitleCard";

export interface TitlePanesProps {
  title: Title;
  facets: ResolvedFacets | undefined;
  working: readonly FacetName[] | undefined;
  /**
   * Our own person ids for this title's credited names, keyed by folded name.
   *
   * Comes from the index rather than from a provider, so it is a separate prop rather
   * than another facet. Absent or empty means every name renders as plain text -- which
   * is the correct output for an index built before the cast tables existed, and for a
   * name we cannot resolve unambiguously.
   */
  people?: Record<string, string>;
  /**
   * The rest of this title's collection, already decorated and already filtered to what
   * we hold. Separate from `facets` for the same reason `people` is: the facet is the
   * provider's answer, these are our rows.
   */
  collectionTitles?: Title[];
  /** "More like this", already decorated and already filtered to what we can link. */
  relatedTitles?: Title[];
  /**
   * Panes a plugin declared, already rendered to blocks by the server.
   *
   * They render at NAMED SLOTS between core's panes rather than at an index, so core
   * adding or reordering a pane cannot move somebody's addon. See `src/lib/panes.ts` for
   * the slot vocabulary and `PluginPane.tsx` for what a block draws as.
   */
  panes?: RenderedPane[];
  /**
   * Our own Sonarr's per-episode state, for the seasons pane. Ours rather than a
   * provider's, so it travels beside the facets like `people` and `collectionTitles`.
   */
  episodeState?: readonly EpisodeState[];
  /** Ask Sonarr for one episode. Absent means the per-episode control is not offered. */
  onRequestEpisode?: (season: number, episode: number) => void;
  /**
   * What the Academy gave this film, from our own imported tables.
   *
   * NOT a facet, so it is not in `facets` and never reaches `paneView`: no provider owes
   * it an answer, so it is complete when the payload lands and has no pending state. Null
   * or absent for nearly every title, which draws nothing.
   */
  awards?: TitleAwards | null;
}

/*
  A slot is a NAMED position, not an index. Core can add, remove or reorder its own panes
  without moving a plugin's, which is the whole reason the vocabulary is names -- and it
  renders nothing at all when no plugin claimed the slot, so an unclaimed one leaves no
  gap in the page.
*/
function slotFor(panes: RenderedPane[] | undefined) {
  return (name: string) => <PluginPanes panes={panesForSlot(panes, name)} />;
}

/**
 * The reading-flow panes, in the main column beside the poster rail.
 *
 * Below the header rather than inside it: the header is the local half and renders at
 * t=0, and nothing that arrives late is allowed to push it around.
 */
export function TitleMainPanes({
  title,
  facets,
  working,
  panes,
}: Pick<TitlePanesProps, "title" | "facets" | "working" | "panes">) {
  const shared = { facets, working };
  const slot = slotFor(panes);
  return (
    <>
      <FacetPane
        {...shared}
        facet="synopsis"
        heading="Synopsis"
        skeleton={<SkeletonLines widths={["w-full", "w-11/12", "w-full", "w-2/3"]} />}
        render={(s: Synopsis) => <SynopsisBody synopsis={s} />}
      />
      {/*
        Directly under the synopsis, and deliberately not a pane. A reader reaching for the
        IMDb page reaches for it having just read what the thing IS, so this is where the
        row costs the least attention; below the fold it was a heading-sized section for a
        handful of bookmarks. It renders at t=0 from the local row, so it never moves.
      */}
      <LinksRow title={title} facets={facets} />
      {slot("title.after-synopsis")}

      <FacetPane
        {...shared}
        facet="ratings"
        heading="Ratings"
        skeleton={
          <div className="flex flex-wrap gap-2">
            <SkeletonRepeat count={3}>
              <Skeleton className={RATING_TILE_SIZE} />
            </SkeletonRepeat>
          </div>
        }
        render={(ratings: Rating[]) => <RatingsRow title={title} ratings={ratings} />}
      />
      {slot("title.after-ratings")}

      <FacetPane
        {...shared}
        facet="trailer"
        heading="Trailer"
        skeleton={<Skeleton className={TRAILER_LINK_SIZE} />}
        render={(trailers: Trailer[]) => <TrailerLinks trailers={trailers} />}
      />
    </>
  );
}

/**
 * The facets the facts card holds, named once so the card's emptiness check and the
 * panes it draws cannot disagree. Adding a fact to the card is one entry here and one
 * `<FacetPane>` in `TitleFactsPanes`.
 */
const FACT_FACETS = ["certification", "language", "releaseDates", "watchProviders", "keywords"] as const;

/**
 * Whether the facts card has anything to say at all, by the same `paneView` rule each
 * pane follows -- a skeleton counts, because reserved space is a statement too. Without
 * this, a title every fact provider came back empty for wears an empty bordered box.
 */
function factsVisible(facets: ResolvedFacets | undefined, working: readonly FacetName[] | undefined) {
  return FACT_FACETS.some((f) => paneView(facets, f, working).state !== "hidden");
}

/**
 * The lookup-facts card: certificate, release windows, where to watch, keywords.
 *
 * One pane set serving TWO mounts -- this card under the desktop poster, and the
 * collapsed mobile `<details>` in `TitleLowerPanes` -- so the set of facts cannot drift
 * between the two. These are answers a reader looks UP rather than reads, which is why
 * they left the reading flow, where each one spent a full-width section on a single
 * badge or a row of chips.
 */
export function TitleFactsCard({
  facets,
  working,
  className = "",
}: Pick<TitlePanesProps, "facets" | "working"> & { className?: string }) {
  if (!factsVisible(facets, working)) return null;
  return (
    <div className={`rounded-xl border border-line bg-surface p-4 ${className}`}>
      <TitleFactsPanes facets={facets} working={working} />
    </div>
  );
}

function TitleFactsPanes({ facets, working }: Pick<TitlePanesProps, "facets" | "working">) {
  const shared = { facets, working, variant: "rail" as const };
  return (
    <>
      <FacetPane
        {...shared}
        facet="certification"
        heading="Certification"
        skeleton={<Skeleton className="h-6 w-20" />}
        render={(certs: Certification[]) => <CertificationBadge certs={certs} />}
      />

      {/*
        PLAIN TEXT, not a chip, and that is a decision rather than an omission.
        `.claude/CLAUDE.md`'s dead-end rule: a term becomes a link only once it has
        somewhere real to go, and `/browse` cannot filter on language -- the IMDb dumps the
        index is built from carry no language column at all, so there is nothing to
        populate 1.27M rows with. A chip that looks like the year and decade chips beside
        it and does nothing when clicked is worse than a word.
      */}
      <FacetPane
        {...shared}
        facet="language"
        heading="Language"
        skeleton={<Skeleton className="h-4 w-24" />}
        render={(langs: Language[]) => <LanguageNames langs={langs} />}
      />

      <FacetPane
        {...shared}
        facet="releaseDates"
        heading="Release dates"
        skeleton={<SkeletonLines widths={["w-full", "w-5/6", "w-2/3"]} />}
        render={(dates: ReleaseDates) => <ReleaseDateList dates={dates} compact />}
      />

      {/*
        In the rail by the same reasoning that made this the LAST core pane (aannarr,
        2026-08-31): it answers a question asked only after deciding you want the thing,
        and for a self-hosted library the answer is usually "you already have it". The
        rail is where it costs the least attention without leaving the screen.
      */}
      <FacetPane
        {...shared}
        facet="watchProviders"
        heading="Where to watch"
        skeleton={
          <div className="flex flex-wrap gap-1.5">
            <SkeletonRepeat count={3}>
              <Skeleton className={`${WATCH_TILE_SIZE} w-16`} />
            </SkeletonRepeat>
          </div>
        }
        render={(entries: WatchProviders[]) => <WatchProviderRows entries={entries} />}
      />

      <FacetPane
        {...shared}
        facet="keywords"
        heading="Keywords"
        skeleton={
          <div className="flex flex-wrap gap-1.5">
            <SkeletonRepeat count={6}>
              <Skeleton className="h-5 w-20 rounded-full" />
            </SkeletonRepeat>
          </div>
        }
        render={(keywords: Keyword[]) => <KeywordChips keywords={keywords} />}
      />
    </>
  );
}

/**
 * The full-width lower half: the blocks whose content is a ROW that deserves the whole
 * viewport -- seasons and episodes, cast, crew, the collection, more-like-this. They sit
 * below the two-column grid because a horizontal scroll row squeezed beside the poster
 * rail wastes the rail's width.
 *
 * The mobile facts `<details>` renders here too, after crew: on a phone there is no
 * rail, and the lookup facts belong behind one tap rather than between the reader and
 * the cast.
 */
export function TitleLowerPanes({
  title,
  facets,
  working,
  people,
  collectionTitles,
  relatedTitles,
  panes,
  episodeState,
  awards,
  onRequestEpisode,
}: TitlePanesProps) {
  const shared = { facets, working };
  const slot = slotFor(panes);
  return (
    <>
      {/*
        Keyed by title, because the chosen season is component state and this element
        keeps its position when the router swaps one title for another -- without the
        key, opening a second series would land on whatever season the last one was on.
      */}
      <SeriesPane
        key={title.tconst}
        {...shared}
        variant="panel"
        episodeState={episodeState}
        onRequestEpisode={onRequestEpisode}
      />
      {slot("title.after-seasons")}

      <FacetPane
        {...shared}
        facet="cast"
        heading="Cast"
        skeleton={
          <div className={CAST_ROW_CLASS}>
            <SkeletonRepeat count={8}>
              <CastTileSkeleton />
            </SkeletonRepeat>
          </div>
        }
        render={(cast: CastMember[]) => <CastRow cast={cast} people={people} />}
      />
      {slot("title.after-cast")}

      <FacetPane
        {...shared}
        facet="crew"
        heading="Crew"
        skeleton={<SkeletonLines widths={["w-64", "w-52", "w-72", "w-44"]} />}
        render={(crew: CrewMember[]) => <CrewList crew={crew} people={people} />}
      />

      {/*
        What the Academy gave it. AFTER the people, because every line in it names one of
        them, and BEFORE the collection and more-like-this, because those are the exits
        from this page and awards are still about the film itself.

        Not a `FacetPane`, and the reason is on `Pane`'s doc comment: awards are our own
        imported rows rather than a provider's answer, so they are complete at t=0 and have
        no pending state to reserve space for. Null for nearly every title, and null draws
        nothing at all.
      */}
      <AwardsPane awards={awards} />

      {/*
        The same facts the desktop rail shows, behind one tap. `sm:hidden` and the rail
        card's `hidden sm:block` are two halves of one rule: exactly one mount is ever
        visible. Gated on the same emptiness check as the card, so neither mount ever
        draws chrome over nothing.
      */}
      {factsVisible(facets, working) && (
        <details className="mt-8 rounded-xl border border-line bg-surface p-4 sm:hidden">
          <summary className="cursor-pointer text-sm font-medium text-ink">Details</summary>
          <div className="mt-3">
            <TitleFactsPanes facets={facets} working={working} />
          </div>
        </details>
      )}

      {/*
        The collection, as full cards.

        `render` is handed the FACET so the pane follows the same skeleton/empty/hidden
        rule as every other one -- but it draws `collectionTitles`, because a card needs a
        poster, library state and a request button that no provider knows.

        So the facet can be `ready` and non-empty while there is nothing to draw, and
        `drawing` is how the pane tells `FacetPane` that. This comment used to claim the
        pane disappeared in that case; it did not -- it drew "Other movies in X" over an
        empty row, which is the bug this prop exists to fix.
      */}
      <FacetPane
        {...shared}
        facet="collection"
        heading={collectionHeading(facets)}
        skeleton={
          <div className={POSTER_ROW_CLASS}>
            <SkeletonRepeat count={3}>
              <Skeleton className="aspect-[2/3] w-32 shrink-0 rounded-lg" />
            </SkeletonRepeat>
          </div>
        }
        render={() => <PosterRow titles={collectionTitles ?? []} />}
        drawing={{
          count: collectionTitles?.length ?? 0,
          whenNone: <NothingHeld what="None of the other titles in this collection" />,
        }}
      />

      {/*
        "More like this", last: it is the exit from this page, so it belongs after
        everything the page is actually about.
      */}
      <FacetPane
        {...shared}
        facet="related"
        heading="More like this"
        skeleton={
          <div className={POSTER_ROW_CLASS}>
            <SkeletonRepeat count={5}>
              <Skeleton className="aspect-[2/3] w-32 shrink-0 rounded-lg" />
            </SkeletonRepeat>
          </div>
        }
        render={() => <PosterRow titles={relatedTitles ?? []} />}
        drawing={{
          count: relatedTitles?.length ?? 0,
          whenNone: <NothingHeld what="None of the titles this one is related to" />,
        }}
      />

      {/* Last, so a plugin with something to add after everything core drew has
          somewhere to put it without claiming a position between two core panes. */}
      {slot("title.end")}
    </>
  );
}

// --- awards -----------------------------------------------------------------

/**
 * What the Academy gave this film.
 *
 * The heading carries the RECORD -- "11 nominations, 3 wins" -- because that is the fact a
 * reader wants and the list under it is the evidence. Every ceremony links to its year
 * page and every nominee to their filmography, so the pane is a junction rather than a
 * dead end.
 *
 * Null draws nothing at all. That is the overwhelming majority of the index, and it is the
 * same disappearance an empty facet pane makes -- reached down a different path, because
 * nothing here was ever pending.
 */
function AwardsPane({ awards }: { awards: TitleAwards | null | undefined }) {
  if (!awards || awards.entries.length === 0) return null;

  // Every entry for one film is nearly always one ceremony, so the year is stated once in
  // the heading rather than repeated down every line.
  const ceremonies = [...new Set(awards.entries.map((e) => e.year))];

  return (
    <Pane
      heading={
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>Academy Awards</span>
          <span className="text-xs font-normal text-muted tabular-nums">
            {awards.nominations} nomination{awards.nominations === 1 ? "" : "s"}
            {awards.wins > 0 && `, ${awards.wins} win${awards.wins === 1 ? "" : "s"}`}
            {ceremonies.length === 1 && ` · ${ceremonies[0]}`}
          </span>
        </span>
      }
    >
      <ol>
        {awards.entries.map((e) => (
          <NominationRow
            // Category alone is not unique -- two songs from one film compete in the same
            // category -- so the nominees join the key.
            key={`${e.ceremony}-${e.category}-${e.nominees.map((n) => n.nconst ?? n.name).join("|")}`}
            won={e.won}
            detail={e.detail}
            subject={
              <Link
                to="/awards/oscars/$ceremony"
                params={{ ceremony: String(e.ceremony) }}
                className={PERSON_LINK_CLASS}
              >
                {prettyCategory(e.category)}
              </Link>
            }
            credit={e.nominees.length > 0 ? <NomineeList nominees={e.nominees} /> : undefined}
          />
        ))}
      </ol>
    </Pane>
  );
}

// --- rows of titles: collection, and more-like-this -------------------------

/**
 * A scrolling row, like `Shelf` -- these are handfuls of films, not grids.
 *
 * Shared by the collection pane and "more like this" because they are the same object on
 * screen and differ only in which titles they hold. A second copy would drift the first
 * time either is restyled.
 */
const POSTER_ROW_CLASS = "flex gap-3 overflow-x-auto pb-1 snap-x [scrollbar-width:none]";

/**
 * "Other movies in The Matrix Collection", with the name linking to the collection node.
 *
 * TMDB's collection names already end in "Collection", so appending the word would
 * produce "The Matrix Collection Collection". The name is printed verbatim and the
 * sentence is built around it.
 *
 * The name becomes a LINK only once the facet has resolved an id -- which is also the
 * moment `/collection/:id` has a cached row to serve, since both read the same
 * contribution. That is the dead-end rule holding exactly: plain text until there is
 * somewhere real to go, and never a link that lands on "we hold nothing for that".
 */
function collectionHeading(facets: ResolvedFacets | undefined): ReactNode {
  const resolved = facets?.collection;
  const collection = resolved?.status === "ready" ? resolved.data : undefined;
  if (!collection?.name) return "In this collection";
  return (
    <>
      Other movies in{" "}
      <Link
        to="/collection/$id"
        params={{ id: collection.id }}
        className="underline decoration-line underline-offset-2 hover:text-ink"
      >
        {collection.name}
      </Link>
    </>
  );
}

/**
 * A row of films, as the very same card the search grid draws.
 *
 * `TitleCard` rather than a bespoke tile: "full title cards with all the overlays" is
 * literally the ask, and reusing the component means a change to the card shows up here
 * for free instead of drifting into a second implementation.
 *
 * Empty renders nothing. That is NOT what makes an empty pane disappear -- returning null
 * here is invisible to `FacetPane`, which is exactly how "Other movies in X" came to be
 * drawn over an empty row. The pane says so through its `drawing` prop instead.
 */
/**
 * "We know they exist, we just do not hold them."
 *
 * The alternative was hiding the pane, and it was rejected: the reader learns nothing
 * from an absence, and `CollectionPage` already says "3 of 4" rather than leaving the
 * shortfall unexplained. Same product, same sentence.
 *
 * "yet" is doing real work -- the index is rebuilt daily and a title under the vote floor
 * can cross it, so this is a statement about our corpus today, not about the film.
 */
function NothingHeld({ what }: { what: string }) {
  return <p className="text-sm text-muted">{what} are in the index yet.</p>;
}

function PosterRow({ titles }: { titles: Title[] }) {
  const { request } = useApp();
  if (titles.length === 0) return null;
  return (
    <div className={POSTER_ROW_CLASS}>
      {titles.map((t) => (
        <div key={t.tconst} className="w-32 shrink-0 snap-start">
          <TitleCard title={t} onRequest={request} />
        </div>
      ))}
    </div>
  );
}

// --- synopsis --------------------------------------------------------------

// Exported for the ceremony page's winner hero, which draws the same paragraph and the same
// attribution under a much larger poster. A second renderer there would be a second answer
// to "whose summary is this?", and only one of them would get fixed.
export function SynopsisBody({ synopsis }: { synopsis: Synopsis }) {
  return (
    <>
      <p className="max-w-prose text-sm leading-relaxed text-ink">{synopsis.text}</p>
      {/*
        Attribution, not decoration: the reader can tell whose summary this is. Through
        `sourceName` because the facet carries the provider's own id -- `tmdb` on a film,
        `tvdb` on a series -- and a lowercase slug under a paragraph of prose reads as a
        debug string rather than as credit.
      */}
      <p className="mt-2 text-xs text-muted">{sourceName(synopsis.source)}</p>
    </>
  );
}

// --- ratings ---------------------------------------------------------------

/**
 * One tile's footprint, shared by the real tile and its skeleton so nothing shifts when a
 * late score lands. `min-w` rather than `w`: the mark replaced the wrapped text label, so
 * a tile is now one line tall and wide enough for whichever of "94%" or "8.4" it holds.
 */
export const RATING_TILE_SIZE = "h-12 min-w-28";

/**
 * The caption slot under a tile -- present in every one, filled in only some.
 *
 * Spans the tile's full width, under the mark as well as the score, because it describes
 * the whole tile rather than the number alone. Its own constant, and exported, so the test
 * that counts one slot per tile reads the same string the component writes. A caption that
 * appeared only where there was a count would put the scores in one row at two different
 * heights; see `RatingTile`.
 */
export const RATING_CAPTION_SLOT = "h-3 text-[0.65rem] leading-3 text-muted tabular-nums";

/**
 * One row across every source, including the IMDb score we already hold.
 *
 * This is the pane the whole facet-list design exists for: RT critics, RT audience,
 * Metacritic and Trakt can arrive from three different plugins at three different times
 * and still land in one row. A source that never answers leaves a gap, not a hole -- the
 * row is never gated on everybody having reported.
 */
function RatingsRow({ title, ratings }: { title: Title; ratings: Rating[] }) {
  const local = localImdbRating(title.rating, title.votes, imdbUrl(title.tconst));
  const merged = mergeRatings(local, ratings);

  return (
    <ul className="flex flex-wrap gap-2">
      {merged.map((r) => (
        <li key={`${r.source}|${r.kind}`}>
          <RatingTile rating={r} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One source's score, as two stacked rows:
 *
 *     [mark] 95%
 *     123k votes
 *
 * The mark and the number are one line and one thought -- who scored it, and what they
 * scored. The vote count is a different weight of information, so it sits under the pair
 * rather than beside either, spanning the tile and set small and muted.
 *
 * The mark carries the identity, which is what makes this layout work. The previous tile
 * printed `source · kind` as text inside a fixed width and truncated it, so RT's two
 * halves both rendered `RottenTomat…` -- two different numbers under one indistinguishable
 * label. A tomato and a popcorn bucket say it in the space available.
 *
 * The text label survives as the fallback for a source we have no art for, and as the
 * accessible name in every case: the mark is `alt=""` and the label is only visually
 * hidden, so a screen reader still hears "Metacritic critics 94%".
 */
function RatingTile({ rating }: { rating: Rating }) {
  const logo = ratingLogo(rating);
  const kind = ratingKindLabel(rating.kind);
  // Through the same table the synopsis attribution uses, so one provider is called one
  // thing everywhere on the page. This is the tile's visible label when we have no mark
  // for the source, and its accessible name in every case -- `servarr-metadata` emits
  // `Imdb`, so a screen reader used to hear a spelling nothing on screen ever showed.
  const label = [sourceName(rating.source), kind].filter(Boolean).join(" · ");

  const body = (
    <>
      {/* The headline: mark and score on ONE line, centred against each other. */}
      <span className="flex min-w-0 items-center gap-2 leading-5">
        {logo ? (
          // Height-constrained, width auto: the marks are not a uniform aspect ratio.
          <img src={logo} alt="" aria-hidden className="h-5 w-auto shrink-0 object-contain" />
        ) : null}
        <span className="text-base font-medium tabular-nums text-ink">{formatRatingValue(rating)}</span>
        {/* Without a mark the source has to be readable, so it stays visible. */}
        {!logo && <span className="truncate text-xs text-muted">{label}</span>}
      </span>
      {/*
        The caption, a SIBLING of the headline rather than nested beside the score, so it
        spans the tile's full width and starts flush at its left edge -- under the mark as
        well as the number. Nested inside the score's own column it began after the mark,
        which reads as a caption belonging to the number alone rather than to the tile.

        ALWAYS rendered, blank when the source sent no count, and that is what keeps every
        score in the row on one line. The tile is a fixed-height column centred vertically,
        so dropping this line does not merely remove a caption, it MOVES THE SCORE: a
        one-line tile centres it and a two-line tile pushes it up. IMDb carries a vote count
        and Rotten Tomatoes carries none, so the row as first shipped had its numbers at two
        different heights. Fixed `h-3`/`leading-3` rather than `min-h`, because an empty span
        has to occupy exactly what a full one does.
      */}
      <span className={RATING_CAPTION_SLOT}>
        {rating.count === undefined ? "" : `${formatVotes(rating.count)} votes`}
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
  const shell = `${RATING_TILE_SIZE} flex flex-col justify-center rounded-lg border border-line bg-surface px-3`;

  // Through the same guard the links row uses. `rating.url` is plugin-fed and went into the
  // `href` raw, so a provider that sent a `javascript:` string -- sloppily, not maliciously;
  // a plugin already runs with the server's privileges -- put script in the reader's page.
  // A refused URL renders the tile without a link, which is the shape a source with no URL
  // already takes.
  const href = externalHref(rating.url);
  if (!href) return <div className={shell}>{body}</div>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`${shell} hover:border-muted`}>
      {body}
    </a>
  );
}

// --- where to watch --------------------------------------------------------

/**
 * One service's footprint, shared by the real tile and its placeholder.
 *
 * Small on purpose. This pane sits at the very bottom of the page and answers a yes/no
 * question -- a row of chips the eye can take in at once beats a row of buttons competing
 * with the cast for weight.
 */
const WATCH_TILE_SIZE = "h-7";

/**
 * Where this title STREAMS in the reader's own country, and nothing for anywhere else.
 *
 * The facet carries every country TMDB knows -- one cached answer serves every reader --
 * so the region is picked here, from the same rule the certificate uses. A title with no
 * offers where this reader is renders nothing, down the same path as an empty facet: a
 * German subscription is not an answer to the question asked from Bangkok. `watchServices`
 * owns the other two rules: streaming only, and one tile per SERVICE rather than per name.
 */
function WatchProviderRows({ entries }: { entries: WatchProviders[] }) {
  const here = pickWatchProviders(entries, preferredCountries(browserLocales()));
  if (!here) return null;
  const services = watchServices(here);
  if (services.length === 0) return null;
  /*
    The one address availability data comes with: TMDB's watch page for this country,
    which fronts JustWatch. There is no per-offer URL in the payload, so every tile in
    the row shares it -- a tile is a shortcut to the answer, not a claim about where it
    lands. Guarded like any other outbound href; absent, the tiles are plain chips.
  */
  const href = externalHref(here.link ?? "");

  return (
    <>
      <ul className="flex flex-wrap items-center gap-1.5">
        {services.map((service) => (
          <li key={service.name}>
            <ServiceTile service={service} href={href} />
          </li>
        ))}
      </ul>
      {/*
        Required, not decorative: TMDB's terms ask for this wording for any API use, and the
        availability catalogue is JustWatch's, which they ask be credited by name. It sits
        beside the data it is for rather than in a page footer, so deleting this pane takes
        the obligation with it.
      */}
      <p className="mt-3 text-xs text-muted">
        This product uses the TMDB API but is not endorsed or certified by TMDB. Availability data from
        JustWatch.
      </p>
    </>
  );
}

/**
 * One service: its mark where Kometa has one, its name where it does not.
 *
 * Same bargain the rating tile strikes -- the mark carries the identity in the space
 * available, and the name survives as the fallback and as the accessible name in every
 * case, so a screen reader hears "Netflix" either way. The accessible name says where the
 * link goes rather than just naming the service, because every tile in the row goes to the
 * same page and "Netflix, link" would promise otherwise.
 */
function ServiceTile({ service, href }: { service: WatchService; href: string | null }) {
  const shell = `${WATCH_TILE_SIZE} flex items-center justify-center rounded-md border border-line
                 bg-surface px-2`;
  const body = service.logo ? (
    <>
      {/* Height-constrained, width auto: the marks are not a uniform aspect ratio. */}
      <img src={service.logo} alt="" aria-hidden className="h-3.5 w-auto object-contain" />
      <span className="sr-only">{service.name}</span>
    </>
  ) : (
    // Already the accessible name -- a second sr-only copy would be read twice.
    <span className="text-[11px] leading-none text-ink">{service.name}</span>
  );

  if (!href) return <div className={shell}>{body}</div>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`${service.name} -- see every way to watch`}
      className={`${shell} transition-colors hover:border-muted`}
    >
      {body}
    </a>
  );
}

// --- trailers --------------------------------------------------------------

/** One link's footprint, shared by the real link and its placeholder. */
const TRAILER_LINK_SIZE = "h-9 w-32";

/**
 * A link out to where the trailer plays, and deliberately nothing more.
 *
 * No iframe and no proxy: finderr is internet-facing, an embed would put a third party's
 * player and its tracking on our page, and proxying video is a different weight class
 * from proxying a poster. Embedding and hover-autoplay are their own cards.
 *
 * Null when nothing is playable -- every entry named a site we have no address for --
 * which is the same "nothing to show" the empty list takes, one step later.
 */
function TrailerLinks({ trailers }: { trailers: Trailer[] }) {
  const links = trailerLinks(trailers);
  if (links.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2">
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className={`${TRAILER_LINK_SIZE} inline-flex items-center justify-center rounded-lg
                        border border-line bg-surface px-3 text-sm text-ink hover:border-muted`}
          >
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

// --- cast ------------------------------------------------------------------

/**
 * A row, not a wrapping grid: a grid of thirty headshots pushes every later pane off the
 * screen. `shelf-row` is the same hidden-scrollbar treatment the discovery shelves use.
 */
const CAST_ROW_CLASS = "shelf-row flex snap-x gap-3 overflow-x-auto pb-2";
const CAST_TILE_CLASS = "w-24 shrink-0 snap-start";
const CAST_IMAGE_CLASS = "aspect-2/3 w-full rounded-lg";

/**
 * Beyond about thirty nobody is scrolling, and every entry past that is another image
 * request for a face the reader will never reach.
 */
const MAX_CAST = 30;

function CastRow({ cast, people }: { cast: CastMember[]; people?: Record<string, string> }) {
  const billed = byBillingOrder(cast).slice(0, MAX_CAST);
  return (
    <ul className={CAST_ROW_CLASS}>
      {billed.map((member) => (
        <li key={`${member.personId ?? member.name}|${member.order}`} className={CAST_TILE_CLASS}>
          {/* The portrait is part of the link when there is one -- a face is the most
              clickable thing on the tile, and a name that navigates beside a picture
              that does not is the kind of inconsistency people notice by feel. */}
          <PersonLink name={member.name} people={people} className="block">
            <PersonPortrait name={member.name} image={member.image} />
            <p className="mt-1.5 text-xs font-medium leading-tight text-ink">{member.name}</p>
          </PersonLink>
          {member.character && <p className="text-xs leading-tight text-muted">{member.character}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * A person's name, as a link when we can say WHICH person it is.
 *
 * The single owner of that decision, used by the cast tiles and the crew list alike --
 * two copies would drift on the first restyle, and this one carries a rule rather than
 * just a class list.
 *
 * **Plain text is the correct output, not a fallback.** A name goes unlinked when the
 * index predates the cast tables, when the person is below the vote floor, or when two
 * different people share that name on this title. In every case there is no page worth
 * sending anyone to, and the dead-end rule says do not make it look like there is.
 *
 * **Nothing at rest, underline on hover.** A crew list is a wall of names and underlining
 * them all turns a readable block into noise -- but with no affordance at all the reader
 * has no way to learn the names are live except by accident. Hover carries both: it is
 * invisible until asked, and the underline lands on the ONE name under the pointer, which
 * is also how it stays legible that some names in a line are links and some are not.
 */
/**
 * `underline-offset-2` because a descender -- and names are full of them -- collides with
 * a rule sitting on the baseline. `focus-visible` carries the same signal for a keyboard,
 * which matters more here than usual: Tailwind puts `hover:` behind `@media (hover:hover)`,
 * so on a touch screen the hover half never fires at all.
 */
export const PERSON_LINK_CLASS =
  "underline-offset-2 hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline";

function PersonLink({
  name,
  people,
  className = "",
  children,
}: {
  name: string;
  people?: Record<string, string>;
  className?: string;
  children?: React.ReactNode;
}) {
  const nconst = people?.[personNameKey(name)];
  const body = children ?? name;
  if (!nconst) return <span className={className}>{body}</span>;
  return (
    <Link
      to="/person/$nconst"
      params={{ nconst }}
      search={{}}
      className={`${className} ${PERSON_LINK_CLASS}`}
    >
      {body}
    </Link>
  );
}

function CastTileSkeleton() {
  return (
    <div className={CAST_TILE_CLASS}>
      <Skeleton className={CAST_IMAGE_CLASS} />
      <Skeleton className="mt-1.5 h-3 w-full" />
      <Skeleton className="mt-1 h-3 w-2/3" />
    </div>
  );
}

/**
 * A headshot, or the person's initials.
 *
 * `localImageUrl` is what keeps an upstream provider URL out of the browser: finderr is
 * internet-facing while its providers are an implementation detail. The server rewrites
 * headshots to its own `/img/f/<key>`, so this normally draws a face; initials remain the
 * fallback for a person the provider had no picture of.
 */
function PersonPortrait({ name, image }: { name: string; image: string | null }) {
  const src = localImageUrl(image);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className={`${CAST_IMAGE_CLASS} border border-line object-cover`}
      />
    );
  }
  return (
    <div
      className={`${CAST_IMAGE_CLASS} flex items-center justify-center border border-line bg-surface text-sm text-muted`}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </div>
  );
}

// --- crew ------------------------------------------------------------------

/**
 * Director and writer first, everybody else after.
 *
 * A definition list because that is what this is: a job, and the people who did it.
 */
function CrewList({ crew, people }: { crew: CrewMember[]; people?: Record<string, string> }) {
  const { leads, rest } = groupCrewByJob(crew);
  if (leads.length === 0 && rest.length === 0) return null;

  return (
    <>
      <CrewGroups groups={leads} className="text-sm" people={people} />
      {rest.length > 0 && <CrewGroups groups={rest} className="mt-3 text-xs text-muted" people={people} />}
    </>
  );
}

function CrewGroups({
  groups,
  className,
  people,
}: {
  groups: { job: string; members: CrewMember[] }[];
  className: string;
  people?: Record<string, string>;
}) {
  if (groups.length === 0) return null;
  return (
    <dl className={`grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr] ${className}`}>
      {groups.map((group) => (
        <div key={group.job} className="contents">
          <dt className="text-muted">{group.job}</dt>
          {/*
            Joined with a rendered separator rather than `.join(", ")`, because each name
            is now its own element. The comma stays OUTSIDE the link so a click near it
            does not navigate.
          */}
          <dd className="text-ink">
            {group.members.map((m, i) => (
              <span key={`${m.name}|${m.job}`}>
                {i > 0 && ", "}
                <PersonLink name={m.name} people={people} />
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// --- certification ---------------------------------------------------------

/**
 * One certificate, picked for the reader's own country where we have it.
 *
 * The locale list is read here and passed down, so the rule that turns locales into a
 * country preference stays pure and a user setting can replace this line later.
 */
function CertificationBadge({ certs }: { certs: Certification[] }) {
  const preferred = preferredCountries(browserLocales());
  const cert = pickCertification(certs, preferred);
  if (!cert) return null;

  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-line px-2.5 py-1 text-sm">
      <span className="font-medium text-ink">{cert.rating}</span>
      <span className="text-xs text-muted">{cert.country.toUpperCase()}</span>
    </span>
  );
}

function browserLocales(): string[] {
  if (typeof navigator === "undefined") return [];
  return [...(navigator.languages ?? [navigator.language])];
}

// --- language --------------------------------------------------------------

/**
 * What the title was made in, named in the reader's own language.
 *
 * The locale list is read here and passed down, exactly as `CertificationBadge` does it,
 * so the rule stays pure and a user setting can replace this one line later.
 *
 * `null` when nothing can name any of the codes -- see `languageNames`. The pane's heading
 * is drawn by `FacetPane` before this runs, so that case leaves an empty "Language" label
 * behind. It takes a plugin contributing a code no CLDR knows to reach it, which is a
 * plugin bug and worth being visible rather than a mechanism in the shared pane frame.
 */
function LanguageNames({ langs }: { langs: Language[] }) {
  const names = languageNames(langs, browserLocales());
  if (names.length === 0) return null;
  // Plain text and no chip: `/browse` has no language filter and the index cannot grow one
  // -- see the comment where this pane is mounted.
  return <p className="text-sm text-ink">{names.join(", ")}</p>;
}

// --- keywords --------------------------------------------------------------

function KeywordChips({ keywords }: { keywords: Keyword[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {keywords.map((k) => (
        <InertChip key={k.id || k.name} label={k.name} />
      ))}
    </div>
  );
}

// --- links out -------------------------------------------------------------

/**
 * Everywhere else this title lives, as a quiet row under the synopsis.
 *
 * This replaces the line of small print that used to sit under the request button reading
 * "tt1375666 on IMDb" -- one hard-coded destination, printing an internal id at the reader
 * as if it were a label. A row of named links says the same thing about IMDb and has room
 * for the other eight.
 *
 * NOT A PANE, and it used to be one. It sat second-to-last behind a "Links" heading and in
 * tile chrome the size of the trailer button, which gave a row of bookmarks the same visual
 * weight as the cast. Moved to directly under the synopsis, where a reader who wants the
 * IMDb page wants it -- and made small and muted, because a link out is an ESCAPE from this
 * page and nothing on the way down should compete with the page itself. No section heading:
 * the destinations are their own labels.
 *
 * It is also the one part of the page with no `paneView` decision behind it, which is what
 * made it a pane-shaped exception in the first place. Every other pane exists only if a
 * facet answered. This is built from the `tconst` in the local row -- IMDb, Trakt and
 * Letterboxd are on screen at t=0 with no provider involved, and `externalIds` and `links`
 * only ever ADD to a row that is already there. So it reads the two facets directly:
 * `ready`-with-data is the only status that changes what it draws, and `pending`, `empty`
 * and `failed` are all just "nothing extra yet".
 */
function LinksRow({ title, facets }: { title: Title; facets: ResolvedFacets | undefined }) {
  const ids = facets?.externalIds;
  const provided = facets?.links;
  const links = titleLinks(
    title.tconst,
    entityKindOf(title),
    ids?.status === "ready" ? ids.data : undefined,
    provided?.status === "ready" ? provided.data : undefined,
  );
  if (links.length === 0) return null;

  return (
    <ul aria-label="Links" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {links.map((link) => (
        <li key={link.url}>
          {/*
            `noreferrer` on every one of these, not just for the usual `opener` reason:
            the referrer would tell IMDb, Trakt and whoever a plugin names that a finderr
            exists at this address, which is the same "our providers are an implementation
            detail" rule the image proxy enforces from the other direction.
          */}
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted underline decoration-line underline-offset-4 transition-colors
                       hover:text-ink hover:decoration-muted"
          >
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

// --- release dates ---------------------------------------------------------

/** `compact` is the rail fit -- same rows, tighter type, a label column sized to "Physical". */
function ReleaseDateList({ dates, compact }: { dates: ReleaseDates; compact?: boolean }) {
  const rows = releaseRows(dates);
  if (rows.length === 0) return null;
  const shape = compact
    ? "grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 text-xs"
    : "grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]";
  return (
    <dl className={shape}>
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted">{row.label}</dt>
          <dd className="text-ink tabular-nums">{formatCalendarDate(row.date)}</dd>
        </div>
      ))}
    </dl>
  );
}
