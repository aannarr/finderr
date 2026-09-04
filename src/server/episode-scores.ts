/**
 * Per-episode IMDb scores for one series, read from our own index.
 *
 * Sent beside the facets rather than inside them, for the same reason `people` is: the
 * `episodes` facet is skyhook's answer to "what exists", and this is OUR index answering
 * "what did the world think of it". Writing scores into the facet would make a cached
 * provider payload depend on which index built it.
 *
 * ## This module exists to hold ONE capability check, in one place
 *
 * The `episode` table is an ADDITIVE index stage, so three separate indexes are all valid
 * inputs here: one built before the stage existed, one built by a deployment whose dumps
 * never included it, and one that has it. The first two must serve a title page rather
 * than throw `no such table: episode`, which is the same rule `hasPeople`, `hasRank` and
 * `hasIds` already follow.
 *
 * > [!NOTE] The accessor is reached STRUCTURALLY, and that is deliberate rather than lazy
 * > `SearchEngine.episodesOf` is owned by another worktree and lands separately. Declaring
 * > the shape we need and probing for it means this file compiles, ships and DEGRADES
 * > correctly either side of that landing -- a series simply has no scores until the
 * > accessor and the stage are both present, which is exactly the behaviour an index
 * > without the stage needs anyway. Nothing here has to be revisited when it lands; when
 * > `episodesOf` becomes a real method the probe simply always succeeds.
 */

/** What the browser is sent per episode. A structural subset of the index's own row. */
export interface EpisodeScoreRow {
  season: number;
  number: number;
  /** `null` means nobody has rated it. NEVER 0 -- an unrated episode is not a bad one. */
  rating: number | null;
  votes: number;
}

/** The slice of `SearchEngine` this needs, and nothing more. */
interface EpisodeCapable {
  hasEpisodes?: boolean;
  episodesOf?: (
    parent: string,
    opts?: { season?: number; minRating?: number; minVotes?: number; limit?: number },
  ) => readonly EpisodeScoreRow[];
}

/**
 * Every scored episode of a series, or `[]`.
 *
 * `[]` covers every honest absence at once and the client draws them identically: not a
 * series, an index without the stage, a series IMDb lists no episodes for. The pane still
 * renders its grid from the skyhook skeleton with every cell blank, which is a worse page
 * and never a broken one.
 *
 * Synchronous by design -- it reads local SQLite and nothing else, so it can be called
 * inline in a handler. Note that it takes the ENGINE rather than the holder: a caller must
 * pass `live.current` at the moment of use and must not keep the result of that read
 * across an `await`, because a promoted index leaves the previous engine unusable.
 */
export function episodeScoresFor(engine: unknown, parent: string, isSeries: boolean): EpisodeScoreRow[] {
  if (!isSeries) return [];
  const capable = engine as EpisodeCapable | null;
  if (!capable || capable.hasEpisodes === false || typeof capable.episodesOf !== "function") return [];
  try {
    return [...capable.episodesOf(parent)];
  } catch {
    // An index whose stage is half-present is a broken index, not a broken title page.
    return [];
  }
}
