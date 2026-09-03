/**
 * What OUR Sonarr knows about one episode, and how to read it.
 *
 * The shape below is the wire contract; everything under it is the ONE rule for turning
 * that shape into "do we have this, and may we ask for it". Both tiers read the rule from
 * here: the browser draws a dot or a Request button per row, and the server picks which
 * episodes of a season a season-grain request actually enqueues. Those two must agree --
 * a button offering four episodes that the server then declines to fetch is the exact
 * disagreement one owner prevents.
 *
 * > [!IMPORTANT] A LIST keyed on two integers, never a pre-joined string key
 * > The `episodes` facet is skyhook's answer to "what exists" and this is Sonarr's answer
 * > to "which of those do we hold". They agree on the (season, episode) pair and on nothing
 * > else, so that pair IS the join -- and sending it as two numbers means the client builds
 * > whatever lookup it likes without server and browser having to agree on a key format.
 * > The `personNameKey` duplication one boundary over is the cost of getting that wrong:
 * > two copies of a string rule that silently unlink everything when they drift.
 *
 * `airDate` is Sonarr's, not skyhook's, deliberately: the request button asks "has this
 * aired yet", and that answer must come from the same document as `hasFile` or the two can
 * contradict each other on the same row.
 */
export interface EpisodeState {
  season: number;
  episode: number;
  /**
   * Sonarr's own episode id.
   *
   * It travels to the browser because the single-episode request needs it and nothing else
   * identifies an episode to Sonarr -- neither its monitor nor its search endpoint takes a
   * season and number. It is an integer in the operator's own Sonarr, not an address and
   * not a credential, so it does not engage the no-upstream-URL rule.
   */
  arrEpisodeId: number;
  hasFile: boolean;
  monitored: boolean;
  /** YYYY-MM-DD, or null when Sonarr has no date for it. */
  airDate: string | null;
}

/**
 * Season 0 is the specials, and every series has one.
 *
 * Named here because the SERVER now has to know it too: the header's "is there a hole"
 * question and `seriesGap` in the browser must agree about whether 55 behind-the-scenes
 * clips make a complete show incomplete. `web/src/lib/facet-panes.ts` keeps its own copy
 * for the same bundle-boundary reason `decadeOf` and `personNameKey` do -- importing a
 * value across that line pulls a server module into the browser.
 */
export const SPECIALS_SEASON = 0;

/** Today as a plain UTC date, matching how every date in this product is stored. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Where one episode stands, in the only four states a row can be drawn in.
 *
 * - `unknown` -- Sonarr does not list it, so we know nothing and say nothing.
 * - `owned` -- the file is there.
 * - `wanted` -- aired, monitored, no file. Sonarr is already looking; asking again adds
 *   nothing, so the row says so instead of offering a button that repeats a search.
 * - `missing` -- aired, not monitored, no file. The one state a per-row request button
 *   belongs in.
 *
 * An episode that has NOT aired is `unknown` whatever else is true of it. It is the state
 * every future episode of every show is in, and marking a row that cannot exist yet is
 * noise on the one screen whose job is air dates -- the date is already right there saying
 * the same thing better.
 */
export type EpisodeStanding = "unknown" | "owned" | "wanted" | "missing";

export function episodeStanding(
  state: { hasFile: boolean; monitored: boolean; airDate: string | null } | undefined,
  today: string,
): EpisodeStanding {
  if (!state) return "unknown";
  if (state.hasFile) return "owned";
  // Sonarr's own airDate, not skyhook's, so "has it aired" and "do we have it" cannot come
  // from two documents that disagree. No date at all reads as not yet aired: a dateless
  // episode is one nobody can have, and offering to fetch it would be a dead button.
  if (!state.airDate || state.airDate > today) return "unknown";
  return state.monitored ? "wanted" : "missing";
}

/**
 * Whether a standing means "it aired and we do not have it".
 *
 * `wanted` and `missing` differ only in whether Sonarr is already looking, and that
 * distinction decides whether ONE row gets a button -- it does not decide whether the
 * episode counts as a hole in the season. Every caller that asks "how short are we" reads
 * this rather than spelling the pair out again.
 */
export function airedWithoutFile(standing: EpisodeStanding): boolean {
  return standing === "wanted" || standing === "missing";
}

/**
 * Sonarr's ids for every aired episode of the given seasons we hold no file for.
 *
 * THIS INCLUDES THE EPISODES SONARR IS ALREADY SEARCHING FOR (`wanted`), and that is the
 * whole difference between the season grain and the per-row one. A row offers a button only
 * where a fresh search is new information; a season button answers "get me the rest of
 * this", and a season summary that says four while the request fetches two is a worse lie
 * than one redundant indexer search. Sonarr's own "search season" does the same thing.
 *
 * Ordered by season and then by episode, so a batch reaches Sonarr in broadcast order across
 * the whole selection rather than in whichever order the seasons were ticked. A reader who
 * picks 5, 3, 4 gets season 3 searched first, because that is the order the show exists in
 * and the order the episode list they were looking at fills in.
 *
 * A season in the list with nothing to fetch contributes nothing rather than refusing the
 * whole selection -- ticking a complete season alongside two empty ones is a reader saying
 * "these three", and the honest answer is to fetch what is missing from them. The caller
 * decides what an EMPTY total means; here it is just an empty list.
 */
export function missingEpisodeIdsIn(
  states: readonly EpisodeState[],
  seasons: readonly number[],
  today: string,
): number[] {
  const wanted = new Set(seasons);
  return states
    .filter((s) => wanted.has(s.season) && airedWithoutFile(episodeStanding(s, today)))
    .sort((a, b) => (a.season === b.season ? a.episode - b.episode : a.season - b.season))
    .map((s) => s.arrEpisodeId);
}

/**
 * Which of the given seasons actually had something to fetch.
 *
 * The response says what was queued, and "you asked for 3-7, seasons 3, 4 and 5 had holes"
 * is a different sentence from "you asked for 3-7". Derived from the same filter as the ids
 * so the two can never disagree.
 */
export function seasonsWithMissing(
  states: readonly EpisodeState[],
  seasons: readonly number[],
  today: string,
): number[] {
  const wanted = new Set(seasons);
  const found = new Set<number>();
  for (const s of states) {
    if (wanted.has(s.season) && airedWithoutFile(episodeStanding(s, today))) found.add(s.season);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Does this series have ANY aired episode we hold no file for, specials aside?
 *
 * Read straight off the mirror, with no facet in it -- which is what lets the title header
 * decide whether to offer a "request the rest" control without waiting on skyhook. The
 * seasons pane needs the `episodes` facet because it draws season names and air dates; the
 * header only needs to know whether there is a hole at all.
 *
 * SPECIALS DO NOT COUNT, and that is not a detail. `seriesGap` skips season 0 for the stated
 * reason that counting 55 behind-the-scenes clips as missing content tells every reader of
 * every complete series that they are short of it. If this said otherwise, a series held in
 * full would grow a Request button whose dialog then had nothing to pre-tick.
 */
export function hasMissingEpisodes(states: readonly EpisodeState[], today: string): boolean {
  return states.some((s) => s.season !== SPECIALS_SEASON && airedWithoutFile(episodeStanding(s, today)));
}
