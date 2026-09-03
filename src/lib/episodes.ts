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
 * Sonarr's ids for every aired episode of one season we hold no file for.
 *
 * THIS INCLUDES THE EPISODES SONARR IS ALREADY SEARCHING FOR (`wanted`), and that is the
 * whole difference between the season grain and the per-row one. A row offers a button only
 * where a fresh search is new information; a season button answers "get me the rest of
 * this", and a season summary that says four while the request fetches two is a worse lie
 * than one redundant indexer search. Sonarr's own "search season" does the same thing.
 *
 * Sorted by episode number so a queued batch reaches Sonarr in broadcast order, which is
 * also the order a reader watching the list expects things to fill in.
 */
export function missingEpisodeIds(states: readonly EpisodeState[], season: number, today: string): number[] {
  return states
    .filter((s) => s.season === season && airedWithoutFile(episodeStanding(s, today)))
    .sort((a, b) => a.episode - b.episode)
    .map((s) => s.arrEpisodeId);
}
