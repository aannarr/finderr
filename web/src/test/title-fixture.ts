/**
 * One title, for a test that needs a whole one to change three fields of.
 *
 * `Title` has twenty-odd required fields and almost none of them are what any given test is
 * about, so four files had written the same literal out character for character -- and the
 * copies were already drifting on the name ("Inception" in one, "The Inception" in the rest).
 * The cost of that shape is the day a field is added to `Title`: every copy goes red at once
 * and each gets fixed slightly differently.
 *
 * A FUNCTION rather than a shared constant, so a test cannot mutate the fixture out from
 * under the file that runs after it. Everything is at its emptiest resting value -- nothing
 * requested, nothing in the library, no artwork, no Plex -- because that is the state a test
 * asserts AGAINST, and a fixture with interesting defaults hides which field a test is
 * actually about.
 *
 * Test-only, and in `web/src/test/` rather than `web/src/lib/` to say so.
 */

import type { Title } from "../lib/api";

export function makeTitle(over: Partial<Title> = {}): Title {
  return {
    tconst: "tt1375666",
    title: "The Inception",
    orig: null,
    year: 2010,
    kind: "movie",
    votes: 2_400_000,
    rating: 8.4,
    genres: "Action,Sci-Fi",
    runtime: 148,
    lang: null,
    inLibrary: false,
    hasFile: false,
    progress: null,
    requestStatus: null,
    requestError: null,
    requestVerdict: null,
    requestProgress: null,
    requestEtaAt: null,
    requestEvidence: null,
    service: "radarr",
    // `null` means we hold no artwork for this title -- `posterUrl` returns null for it,
    // which is the "no image" branch a fallback test is about.
    posterUrl: null,
    studio: null,
    studioLogo: null,
    plex: null,
    award: null,
    ...over,
  };
}
