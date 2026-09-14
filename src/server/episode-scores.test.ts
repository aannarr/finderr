/**
 * `episodePlacesFor` -- where each episode was filmed, keyed like the scores.
 *
 * The engine is a fake shaped like `SearchEngine`'s two accessors, so what is under test is the
 * keying: the place must land on the PROVIDER's coordinate through the same alignment the
 * scores use, or a row shows another episode's location.
 */

import { describe, expect, test } from "bun:test";
import type { IndexEpisode, SkeletonEpisode } from "../lib/episode-align";
import type { EpisodePlaces, Place } from "../lib/filming-locations";
import { episodePlacesFor, episodeScoresFor } from "./episode-scores";

const place = (id: string, label: string): Place => ({
  id,
  label,
  kind: "site",
  studio: false,
  country: null,
  lat: null,
  lon: null,
  titles: 3,
});

/*
  Star Trek: The Next Generation, season 1, as the alignment's own tests use it: TVDB numbers
  the pilot as two slots and IMDb as one, so every later index episode sits ONE slot earlier
  than the provider's.
*/
const skeleton: SkeletonEpisode[] = [
  { season: 1, number: 1, title: "Encounter at Farpoint (1)" },
  { season: 1, number: 2, title: "Encounter at Farpoint (2)" },
  { season: 1, number: 3, title: "The Naked Now" },
];
const index: IndexEpisode[] = [
  { season: 1, number: 1, title: "Encounter at Farpoint", rating: 7.6, votes: 100 },
  { season: 1, number: 2, title: "The Naked Now", rating: 6.6, votes: 100 },
];
const stage9 = [place("Q56255706", "Paramount Stage 9")];
const byIndex: EpisodePlaces[] = [{ season: 1, number: 2, places: stage9 }];

const engine = { hasEpisodes: true, episodePlacesOf: () => byIndex, episodesOf: () => index };

describe("episodePlacesFor", () => {
  test("a place lands on the provider's coordinate, the same row as that episode's score", () => {
    const places = episodePlacesFor(engine, "tt0092455", true, skeleton);
    expect(places).toEqual([{ season: 1, number: 3, places: stage9 }]);
    // The score for "The Naked Now" is at the same coordinate -- one mapping, not two.
    const score = episodeScoresFor(engine, "tt0092455", true, skeleton).find((s) => s.rating === 6.6);
    expect([score?.season, score?.number]).toEqual([1, 3]);
  });

  test("with no skeleton the index's own coordinates go out, as the scores do", () => {
    expect(episodePlacesFor(engine, "tt0092455", true, undefined)).toEqual(byIndex);
  });

  test("a film, an engine without the accessor, a series with no places and a broken index are all empty", () => {
    expect(episodePlacesFor(engine, "tt1", false, skeleton)).toEqual([]);
    expect(episodePlacesFor({ episodesOf: () => index }, "tt1", true, skeleton)).toEqual([]);
    expect(episodePlacesFor({ ...engine, episodePlacesOf: () => [] }, "tt1", true, skeleton)).toEqual([]);
    const broken = {
      ...engine,
      episodePlacesOf: () => {
        throw new Error("no such table: episode_place");
      },
    };
    expect(episodePlacesFor(broken, "tt1", true, skeleton)).toEqual([]);
  });
});
