/**
 * The one rule the person page owns that is not a render: how IMDb's categories become
 * the chips a reader picks from.
 *
 * `mergedCategories` is pure, so it is tested directly. The second suite is the one that
 * matters over time -- it binds the label table to the builder's own category list, in
 * the same spirit as `ratingLogo`'s binding to `src/logos.json`: widen what the index
 * ingests and forget the label, and the suite goes red instead of a chip reading
 * `production_designer` reaching the browser.
 */

import { describe, expect, test } from "bun:test";
import { mergedCategories } from "./PersonRoute";

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
