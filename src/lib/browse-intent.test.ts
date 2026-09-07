/**
 * The accounting rule is what these mostly test.
 *
 * Recognising "swedish" and "crime" is the easy half; the half that decides whether this
 * feature is an improvement or a nuisance is refusing to fire on "True Romance", and
 * refusing to quietly drop a word it cannot honour.
 */

import { describe, expect, test } from "bun:test";
import { browseIntentOf } from "./browse-intent";

/** Fixed so the recency cases assert a decade rather than whatever today happens to be. */
const NOW = new Date("2026-09-08T00:00:00Z");

const intent = (q: string) => browseIntentOf(q, NOW);

describe("browseIntentOf", () => {
  test("the query that started this: a language and a genre, no title", () => {
    expect(intent("swedish crime drama")).toEqual({ genre: "Crime", lang: "sv" });
  });

  test("a language on its own is a shelf", () => {
    expect(intent("korean")).toEqual({ lang: "ko" });
  });

  test("a genre on its own is a shelf", () => {
    expect(intent("horror")).toEqual({ genre: "Horror" });
  });

  test("the first genre wins, because English puts the qualifier first", () => {
    expect(intent("action comedy")?.genre).toBe("Action");
    expect(intent("crime drama")?.genre).toBe("Crime");
  });

  test("plurals are the same word", () => {
    expect(intent("thrillers")?.genre).toBe("Thriller");
    expect(intent("comedies")?.genre).toBe("Comedy");
    expect(intent("documentaries")?.genre).toBe("Documentary");
    expect(intent("mysteries")?.genre).toBe("Mystery");
  });

  test("Sci-Fi answers to every spelling of itself", () => {
    for (const q of ["sci-fi", "sci fi", "scifi", "science fiction"]) {
      expect(intent(q)?.genre).toBe("Sci-Fi");
    }
  });

  test("a two-word language name is one word", () => {
    expect(intent("serbo-croatian")).toEqual({ lang: "sh" });
  });

  test("the kind, the decade and the year come from parseQuery", () => {
    expect(intent("swedish crime series")).toEqual({ genre: "Crime", lang: "sv", kind: "tvSeries" });
    expect(intent("1980s horror films")).toEqual({ genre: "Horror", kind: "movie", decade: 1980 });
    expect(intent("japanese animation 1988")).toEqual({ genre: "Animation", lang: "ja", year: 1988 });
  });

  test("asking for the best of something asks for the list we already offer", () => {
    expect(intent("the best of swedish crime")).toEqual({ genre: "Crime", lang: "sv" });
    expect(intent("top korean thrillers")).toEqual({ genre: "Thriller", lang: "ko" });
  });

  /**
   * "new" has no sort to map onto -- `/browse` orders by rank or by votes and nothing else --
   * so it becomes the decade we are in, which the suggestion then prints.
   */
  test("new means the current decade", () => {
    expect(intent("new swedish crime drama")).toEqual({ genre: "Crime", lang: "sv", decade: 2020 });
    expect(intent("latest korean horror")).toEqual({ genre: "Horror", lang: "ko", decade: 2020 });
  });

  test("an explicit period beats 'new', which is vaguer", () => {
    expect(intent("new 1970s horror")?.decade).toBe(1970);
    expect(intent("recent horror 1988")?.year).toBe(1988);
  });

  /**
   * THE RULE THAT KEEPS IT QUIET. Every one of these names a genre or a language and leaves a
   * word over, so none of them is a shelf question -- they are titles.
   */
  test("a leftover word means it was a title all along", () => {
    expect(intent("true romance")).toBeNull();
    expect(intent("action jackson")).toBeNull();
    expect(intent("the french connection")).toBeNull();
    expect(intent("horror express")).toBeNull();
    expect(intent("the italian job")).toBeNull();
  });

  test("a word we cannot honour blocks it rather than being dropped", () => {
    // "old" names a period `/browse` has no filter for. Answering with every decade of
    // Swedish crime is the "nearest plausible thing" this whole feature exists to stop.
    expect(intent("old swedish crime")).toBeNull();
    expect(intent("classic horror")).toBeNull();
  });

  test("no genre and no language is not a shelf, however well we understood it", () => {
    expect(intent("1980s films")).toBeNull();
    expect(intent("new series")).toBeNull();
    expect(intent("best movies")).toBeNull();
  });

  test("an ordinary title search says nothing", () => {
    expect(intent("the matrix")).toBeNull();
    expect(intent("interstellar")).toBeNull();
    expect(intent("")).toBeNull();
  });

  test("the clock is injected, so the answer does not drift with the calendar", () => {
    expect(browseIntentOf("new horror", new Date("2019-12-31T00:00:00Z"))?.decade).toBe(2010);
    expect(browseIntentOf("new horror", new Date("2020-01-01T00:00:00Z"))?.decade).toBe(2020);
  });
});
