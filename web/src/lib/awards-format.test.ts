import { describe, expect, test } from "bun:test";
import {
  ceremonyYear,
  type EditionNaming,
  editionHeading,
  editionLabel,
  isPersonLed,
  ordinal,
  prettyCategory,
} from "./awards-format";

const OSCARS: EditionNaming = {
  title: "The Academy Awards",
  editionKey: "ordinal",
  editionOne: "ceremony",
};

const PALME: EditionNaming = { title: "The Palme d'Or", editionKey: "year", editionOne: "festival" };

describe("editionLabel", () => {
  test("a numbered award prints its ordinal beside the year it is about", () => {
    // The Academy's `Year` is a separate fact from its ceremony number -- and reads `1927/28`
    // for the first six -- so both are worth printing and neither is derivable from the other.
    expect(editionLabel(OSCARS, 96, "2023")).toBe("96th · 2023");
    expect(editionLabel(OSCARS, 1, "1927/28")).toBe("1st · 1927/28");
  });

  test("a dated award prints the year alone, because there is no ordinal to print", () => {
    // Wikidata records a point in time and nothing else. `1994th` would be an invention, and
    // it is the one an unguarded `ordinal()` would have made.
    expect(editionLabel(PALME, 1994, "1994")).toBe("1994");
  });

  test("without a year, a step link still names its neighbour", () => {
    // The step links know only the neighbour's KEY, which for a dated award is its year.
    expect(editionLabel(OSCARS, 95)).toBe("95th");
    expect(editionLabel(PALME, 1993)).toBe("1993");
  });
});

describe("editionHeading", () => {
  test("a numbered award names what is being counted", () => {
    expect(editionHeading(OSCARS, 96, "2023")).toBe("96th ceremony · 2023");
  });

  test("a dated award leads with the award, because the year alone is not a heading", () => {
    expect(editionHeading(PALME, 1994, "1994")).toBe("The Palme d'Or 1994");
  });
});

describe("ordinal", () => {
  test("the ordinary endings", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(98)).toBe("98th");
  });

  test("the teens, which a naive n % 10 table gets wrong", () => {
    // All three are real ceremony numbers this page renders, so they are not an edge case
    // somebody imagined -- 11th, 12th and 13th are on screen the first time you scroll.
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
  });

  test("the twenties resume the ordinary endings", () => {
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(23)).toBe("23rd");
  });
});

describe("ceremonyYear", () => {
  test("a plain year", () => {
    expect(ceremonyYear("2025")).toBe(2025);
  });

  test("a split year yields the FIRST of the two", () => {
    // The first six ceremonies carry this shape. Parsing the whole string is what would
    // put "NaN" in a header.
    expect(ceremonyYear("1927/28")).toBe(1927);
    expect(ceremonyYear("1932/33")).toBe(1932);
  });

  test("nonsense is null, never a guess", () => {
    expect(ceremonyYear("")).toBeNull();
    expect(ceremonyYear("unknown")).toBeNull();
  });
});

describe("prettyCategory", () => {
  test("titlecases the source's shouting without rewriting it", () => {
    expect(prettyCategory("BEST PICTURE")).toBe("Best Picture");
    expect(prettyCategory("ACTOR IN A LEADING ROLE")).toBe("Actor In A Leading Role");
  });

  test("keeps a parenthetical intact", () => {
    // The category is still recognisably the one the ceremony page prints in full, which
    // is the whole constraint: only the case may change.
    expect(prettyCategory("WRITING (Adapted Screenplay)")).toBe("Writing (Adapted Screenplay)");
    expect(prettyCategory("MUSIC (Original Score)")).toBe("Music (Original Score)");
  });

  test("an apostrophe does not start a new word", () => {
    // Without the apostrophe inside the word class this reads "Women'S", which is the kind
    // of thing that ships because nobody scrolled to the category it happens in.
    expect(prettyCategory("WOMEN'S PICTURE")).toBe("Women's Picture");
  });

  test("leaves digits and punctuation alone", () => {
    expect(prettyCategory("SHORT SUBJECT (Cartoon)")).toBe("Short Subject (Cartoon)");
    expect(prettyCategory("SOUND RECORDING - 1935")).toBe("Sound Recording - 1935");
  });
});

/**
 * The regression this function exists for.
 *
 * Observed on `/awards/oscars/96` before the fix: Best Picture drew eight rows film-first
 * and two person-first, because `The Holdovers` and `The Zone of Interest` each credited
 * ONE producer while the other eight credited several. The rule was counting nominees, so
 * one category read two ways and nothing on screen explained why.
 */
describe("isPersonLed", () => {
  test("acting leads with the person -- they ARE the nomination", () => {
    expect(isPersonLed("Acting")).toBe(true);
  });

  test("Best Picture leads with the FILM however many producers are credited", () => {
    /*
      Best Picture's class is `Title`, and this assertion said `Production` until it was
      checked against the pinned file. Both answer `false`, so the SCREEN was right either
      way -- which is exactly why it is worth pinning: a fixture that is wrong about the
      data still passes, and goes on being cited as if it were a measurement.

      `Title` is the class for an award to a whole WORK; `Production` is the crafts.
    */
    expect(isPersonLed("Title")).toBe(false);
  });

  test("every other class leads with the film", () => {
    // The source's full vocabulary, measured from the pinned file rather than remembered.
    // Naming them all is what makes a class ADDED upstream visibly unhandled here rather
    // than silently changing how a category reads.
    for (const cls of ["Title", "Production", "Directing", "Writing", "Music", "Special", "SciTech"]) {
      expect(isPersonLed(cls)).toBe(false);
    }
  });

  test("an unknown class leads with the film rather than guessing", () => {
    // A class we have never seen is far more likely to be about a work than about a
    // person, and the film-led shape degrades better: it still names everybody.
    expect(isPersonLed("SomethingNew")).toBe(false);
    expect(isPersonLed("")).toBe(false);
  });
});
