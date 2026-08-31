/**
 * What OUR Sonarr knows about one episode, as the wire carries it.
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
