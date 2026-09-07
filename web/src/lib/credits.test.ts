/**
 * How IMDb's categories become the words a reader sees -- the chips on a person page, and
 * the roles printed beside a frequent collaborator.
 *
 * Both are pure, so they are tested directly. The last suite is the one that matters over
 * time -- it binds the label table to the builder's own category list, in the same spirit
 * as `ratingLogo`'s binding to `src/logos.json`: widen what the index ingests and forget
 * the label, and the suite goes red instead of a chip reading `production_designer`
 * reaching the browser.
 */

import { describe, expect, test } from "bun:test";
import { characterNote, creditLabels, creditNote, mergedCategories, noteForFilmography } from "./credits";

describe("mergedCategories", () => {
  test("actor and actress are one chip carrying both IMDb values", () => {
    const roles = mergedCategories([
      { category: "actor", count: 30 },
      { category: "actress", count: 11 },
    ]);
    expect(roles).toEqual([{ label: "Acting", values: ["actor", "actress"], count: 41 }]);
  });

  test("chips are ordered by how much of the filmography they are", () => {
    const roles = mergedCategories([
      { category: "composer", count: 2 },
      { category: "director", count: 9 },
      { category: "producer", count: 4 },
    ]);
    expect(roles.map((r) => r.label)).toEqual(["Directing", "Production", "Music"]);
  });

  test("an unmapped category keeps its raw name rather than vanishing", () => {
    // A dropped chip would hide credits the page is holding; a chip that reads like a
    // database column is ugly and self-reporting, which is the better failure.
    const roles = mergedCategories([{ category: "archive_footage", count: 3 }]);
    expect(roles).toEqual([{ label: "archive_footage", values: ["archive_footage"], count: 3 }]);
  });
});

describe("creditLabels", () => {
  test("actor and actress read as one job, not two", () => {
    // A collaborator billed under both across several films is one job. Printing
    // "Acting · Acting" beside their name would be the tell that nothing merged them.
    expect(creditLabels(["actor", "actress"])).toEqual(["Acting"]);
  });

  test("keeps the given order, so the roles read as they were ranked", () => {
    expect(creditLabels(["director", "writer"])).toEqual(["Directing", "Writing"]);
  });

  test("an unmapped category keeps its raw name here too", () => {
    expect(creditLabels(["archive_footage"])).toEqual(["archive_footage"]);
  });

  test("no categories is no labels, never a stray separator", () => {
    expect(creditLabels([])).toEqual([]);
  });
});

describe("creditNote", () => {
  test("an acting credit reads as the CHARACTER, not as the job", () => {
    // "Acting" is what the reader already knew from the chip they pressed. The name is the
    // fact the card can add.
    expect(creditNote({ tconst: "tt0", categories: ["actor"], characters: "Dom Cobb" })).toEqual({
      text: "Dom Cobb",
      full: "Dom Cobb · Acting",
    });
  });

  test("a credit with no character falls back to the job", () => {
    expect(creditNote({ tconst: "tt0", categories: ["director"], characters: null })).toEqual({
      text: "Directing",
      full: "Directing",
    });
  });

  test("several characters draw the first and reveal all of them on hover", () => {
    // Billed under two aliases on one film. The card has room for one; the tooltip is
    // where the other lives.
    expect(creditNote({ tconst: "tt0", categories: ["actor"], characters: "Hank Hall, Hawk" })).toEqual({
      text: "Hank Hall",
      full: "Hank Hall · Hawk · Acting",
    });
  });

  test("several jobs draw the first and reveal all of them on hover", () => {
    expect(creditNote({ tconst: "tt0", categories: ["director", "writer"], characters: null })).toEqual({
      text: "Directing",
      full: "Directing · Writing",
    });
  });

  test("acting AND directing leads with the character, and the hover holds both jobs", () => {
    expect(creditNote({ tconst: "tt0", categories: ["actor", "director"], characters: "Vincent" })).toEqual({
      text: "Vincent",
      full: "Vincent · Acting · Directing",
    });
  });

  test("actor and actress collapse to one job in the hover, never two", () => {
    // The same merge the chips do. "Acting · Acting" would be the tell that this reached
    // for the raw categories instead of `creditLabels`.
    expect(creditNote({ tconst: "tt0", categories: ["actor", "actress"], characters: null })).toEqual({
      text: "Acting",
      full: "Acting",
    });
  });

  test("a row carrying neither draws NO line rather than an empty one", () => {
    // What a plain `Title` from a search grid looks like: the fields are simply absent, and
    // `TitleGrid` hands every row to this function whatever page it is on.
    expect(creditNote({ tconst: "tt0" })).toBeNull();
    expect(creditNote({ tconst: "tt0", categories: [], characters: null })).toBeNull();
  });

  test("a character list that is only separators is no character at all", () => {
    // `group_concat` skips nulls, so this shape should not arise -- but an empty string
    // here would draw a blank line that looks like a rendering bug rather than an absence.
    expect(creditNote({ tconst: "tt0", categories: ["actor"], characters: " , " })).toEqual({
      text: "Acting",
      full: "Acting",
    });
  });
});

describe("characterNote", () => {
  test("names who they played and never what the job was called", () => {
    expect(characterNote({ tconst: "tt0", categories: ["actor"], characters: "Philip J. Fry" })).toEqual({
      text: "Philip J. Fry",
      full: "Philip J. Fry",
    });
  });

  test("the job is withheld from the HOVER too, not merely from the line", () => {
    // Half-suppressing it would put "Acting" back on screen the moment anybody hovered,
    // which is the repetition this variant exists to remove.
    expect(characterNote({ tconst: "tt0", categories: ["actor"], characters: "Hank Hall, Hawk" })).toEqual({
      text: "Hank Hall",
      full: "Hank Hall · Hawk",
    });
  });

  test("no character means NO LINE, where creditNote would have printed the job", () => {
    // An Inconvenient Truth on Billy West's page: a real acting credit we hold no character
    // for. The card simply says nothing rather than repeating the chip above the grid.
    const credit = { tconst: "tt0", categories: ["actor"], characters: null };
    expect(characterNote(credit)).toBeNull();
    expect(creditNote(credit)).toEqual({ text: "Acting", full: "Acting" });
  });
});

describe("noteForFilmography", () => {
  const credit = (categories: string[], characters: string | null = null) => ({
    tconst: `tt${categories.join("")}${characters ?? ""}`,
    categories,
    characters,
  });

  test("a person who only ever does one job never has it printed", () => {
    // Billy West: nineteen acting credits. "Acting" under every card buries the names.
    const west = [credit(["actor"], "Philip J. Fry"), credit(["actor"], "Sorcerio"), credit(["actor"])];
    expect(noteForFilmography(west)).toBe(characterNote);
  });

  test("THE CASE A ROLE COUNT CANNOT SEE: three roles, one job on every card", () => {
    // Nolan holds Directing, Production and Writing, so counting his DISTINCT roles calls
    // the job informative -- and all fourteen cards still print "Directing", because he
    // directs every one of them. Measured on the live page 2026-09-07; it is the reason
    // this function takes the rows rather than `PersonPage.categories`.
    const nolan = Array.from({ length: 4 }, () => credit(["director", "producer", "writer"]));
    expect(noteForFilmography(nolan)).toBe(characterNote);
  });

  test("a job that genuinely differs between two cards IS printed", () => {
    const mixed = [credit(["actor"], "Vincent"), credit(["director"])];
    expect(noteForFilmography(mixed)).toBe(creditNote);
  });

  test("a role filter needs no special case -- one label everywhere suppresses itself", () => {
    // `personPage` strips the other categories under a filter, so every row arrives as the
    // filtered role alone. The uniformity test catches it with no flag to pass.
    const filtered = [credit(["director"]), credit(["director"]), credit(["director"])];
    expect(noteForFilmography(filtered)).toBe(characterNote);
  });

  test("a credit with NO job is skipped, not counted as a second opinion", () => {
    // Otherwise one row missing its categories would flip a uniform page to "varied" and
    // put the repeated word back under every card.
    expect(noteForFilmography([credit(["actor"], "Fry"), credit([], "Bender")])).toBe(characterNote);
  });

  test("an empty filmography is not a crash and prints no job", () => {
    expect(noteForFilmography([])).toBe(characterNote);
  });

  test("returns a STABLE reference, which is what keeps TitleGrid's memo working", () => {
    // Not an implementation detail: `noteFor` is a prop on a `memo`'d component, so a fresh
    // closure per render would re-render every card in the grid on every keystroke.
    const mixed = [credit(["actor"], "Vincent"), credit(["director"])];
    expect(noteForFilmography(mixed)).toBe(noteForFilmography(mixed));
    expect(noteForFilmography([])).toBe(noteForFilmography([]));
  });

  test("growing the page can only ADD the job, never take it away", () => {
    // The one-way instability the docstring accepts: notes appear when a genuinely
    // different job arrives, and no amount of loading can make them vanish again.
    const first = [credit(["director"]), credit(["director"])];
    expect(noteForFilmography(first)).toBe(characterNote);
    expect(noteForFilmography([...first, credit(["actor"], "Cameo")])).toBe(creditNote);
  });
});

describe("every category the index ingests has a human label", () => {
  test("no configured castCategory falls through to its raw IMDb name", async () => {
    // Read at runtime rather than imported at the top, for the same reason `decadeOf` is
    // duplicated instead of imported: nothing under web/ pulls a server module into a
    // value position. A test file is never bundled, so this is the cheap way to keep the
    // two lists honest with each other.
    const { loadConfig } = await import("../../../src/lib/config");
    const categories = loadConfig().index.castCategories;
    expect(categories.length).toBeGreaterThan(0);

    const unlabelled = mergedCategories(categories.map((category) => ({ category, count: 1 })))
      .map((r) => r.label)
      .filter((label) => categories.includes(label));
    expect(unlabelled).toEqual([]);
  });
});
