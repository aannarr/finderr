/**
 * One board, as markup.
 *
 * It renders from props alone -- no fetch, no effect, no navigation -- which is what makes it
 * testable at all under `renderToStaticMarkup`. Through a memory router because every row
 * links to a person page, and a `<Link>` with no router in context throws.
 *
 * What is asserted here is the board's CONTRACT with whatever ranks the people: the payload
 * carries the unit and the note, and this component prints them without knowing what they
 * count. That is the seam a second ranking source arrives through.
 */

import { describe, expect, test } from "bun:test";
import type { PersonLeaderboard } from "../../../src/lib/people-leaderboard";
import { renderInRouter as render } from "../test/render-in-router";
import { PeopleLeaderboard } from "./PeopleLeaderboard";

const board = (over: Partial<PersonLeaderboard> = {}): PersonLeaderboard => ({
  id: "most-nominated",
  title: "Most nominated",
  blurb: null,
  unit: { one: "nomination", many: "nominations" },
  entries: [
    { nconst: "nm0002354", name: "John Williams", value: 54, note: "won 5" },
    { nconst: "nm0000055", name: "Alfred Newman", value: 45, note: "won 9" },
  ],
  ...over,
});

const renderBoard = (b: PersonLeaderboard) => render(<PeopleLeaderboard board={b} />, ["/person/$nconst"]);

describe("PeopleLeaderboard", () => {
  test("the heading, the names and the numbers", async () => {
    const html = await renderBoard(board());
    expect(html).toContain("Most nominated");
    expect(html).toContain("John Williams");
    expect(html).toContain("54 nominations");
    expect(html).toContain("won 5");
  });

  test("every name is a link into their own page", async () => {
    const html = await renderBoard(board());
    expect(html).toContain('href="/person/nm0002354"');
  });

  /** The unit is the payload's, so a board counting wins says "win" rather than "nomination". */
  test("the unit comes from the board, and one is not '1 nominations'", async () => {
    const html = await renderBoard(
      board({
        unit: { one: "win", many: "wins" },
        entries: [{ nconst: "nm1", name: "Somebody", value: 1, note: null }],
      }),
    );
    expect(html).toContain("1 win");
    expect(html).not.toContain("1 wins");
  });

  /**
   * The caveat is drawn ABOVE the names, where somebody about to screenshot the list has
   * already read it -- a footnote under twenty-five rows is one nobody screenshots.
   */
  test("a blurb is drawn before the first name", async () => {
    const html = await renderBoard(board({ blurb: "The Academy Awards only." }));
    expect(html.indexOf("The Academy Awards only.")).toBeLessThan(html.indexOf("John Williams"));
  });

  test("no blurb draws no paragraph at all, rather than an empty one", async () => {
    expect(await renderBoard(board())).not.toContain("max-w-prose");
  });

  test("a row with no note prints the name and the number and nothing between them", async () => {
    const html = await renderBoard(
      board({ entries: [{ nconst: "nm1", name: "Somebody", value: 3, note: null }] }),
    );
    expect(html).toContain("Somebody");
    expect(html).not.toContain(" · ");
  });
});
