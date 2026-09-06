/**
 * `/lists` as a whole page, driven against a stubbed API.
 *
 * What only this file can prove is the WIRING, and it is this page's one real risk: the
 * acceptance the route was rebuilt under is that posters and people cost NO additional
 * request over the completion call it already made. A second `fetch` would render perfectly
 * and quietly turn an index page into three round trips, so the call list is asserted rather
 * than the markup alone.
 *
 * The rest is a section that has to disappear rather than draw a heading over nothing: an
 * award we hold no artwork for, and an index built without the cast tables, are ordinary
 * states, and both are what the empty payload below stands for.
 *
 * `fetch` is replaced rather than the API module mocked, so the path the client actually
 * sends is what is being asserted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AWARDS } from "../../../src/lib/award-registry";
import type { CompletionPayload } from "../../../src/server/lists";
import { resetCaches } from "../lib/api";
import { render, screen, waitFor } from "../test/interact";
import { inRouter } from "../test/render-in-router";
import { ListsRoute } from "./ListsRoute";

const realFetch = globalThis.fetch;
let paths: string[];

const AWARD = AWARDS[0]?.id as string;

const EMPTY: CompletionPayload = { completions: [], posters: {}, boards: [] };

const FULL: CompletionPayload = {
  completions: [{ id: "top-250", size: 250, owned: 178 }],
  posters: {
    [AWARD]: [
      { tconst: "tt15398776", title: "Oppenheimer" },
      { tconst: "tt6751668", title: "Parasite" },
    ],
  },
  boards: [
    {
      id: "directors",
      title: "Directors",
      blurb: null,
      unit: { one: "title", many: "titles" },
      entries: [{ nconst: "nm0634240", name: "Christopher Nolan", value: 9, note: null }],
    },
  ],
};

function stubFetch(payload: CompletionPayload): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    paths.push(String(input).split("?")[0] ?? "");
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

const routed = () => inRouter(<ListsRoute />, ["/browse", "/awards/$award", "/person/$nconst"]);

beforeEach(() => {
  paths = [];
  resetCaches();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the whole page", () => {
  test("posters, counts and people all arrive on ONE request", async () => {
    // THE ACCEPTANCE. `/lists` made exactly one call before this card and makes exactly one
    // after it; three sections riding one payload is the entire design.
    stubFetch(FULL);
    render(await routed());

    await waitFor(() => expect(screen.getByText("Christopher Nolan")).toBeDefined());
    expect(screen.getByText(/178/)).toBeDefined();
    expect(document.querySelector('img[src^="/img/t/tt15398776"]')).not.toBeNull();
    expect(paths).toEqual(["/api/lists/completion"]);
  });

  test("every row renders before the payload lands, and nothing empty is drawn after it", async () => {
    // Two claims, one render, because they are the same rule from both ends: the catalogue is
    // static data the browser already holds, so the links need no server -- and a section the
    // server cannot fill (an award with no resolved artwork, an index with no cast tables) is
    // omitted rather than headed over nothing.
    stubFetch(EMPTY);
    render(await routed());

    expect(screen.getByText("finderr Top 250")).toBeDefined();
    expect(screen.getByText(AWARDS[0]?.title as string)).toBeDefined();

    await waitFor(() => expect(paths).toEqual(["/api/lists/completion"]));
    expect(screen.queryByText("People")).toBeNull();
    expect(document.querySelector('img[src^="/img/t/"]')).toBeNull();
  });

  /**
   * The regression: "Best Actionyou own 66 of 250 top-ranked films", on nineteen rows.
   *
   * `Completion` is `inline-flex` with a top margin, and a margin does not start a line. The
   * curated rows have a subtitle above it so it looked right; the genre and decade rows have
   * none, so the sentence ran straight on from the list's name. Found in a browser, because
   * both components were individually correct and it was their composition that was not.
   */
  test("the completion sentence starts its own line, on a row with no subtitle", async () => {
    stubFetch({ ...FULL, completions: [{ id: "genre-action", size: 250, owned: 66 }] });
    render(await routed());

    await waitFor(() => expect(screen.getByText(/you own 66/)).toBeDefined());

    // The nearest BLOCK around the sentence must not be one that also holds the name. Without
    // the slot, the nearest block is the page itself and this reads "Best Action" -- which is
    // exactly the run-on, asserted structurally rather than as a margin nobody can see.
    const block = screen.getByText(/you own 66/).closest("div");
    expect(block?.textContent).toContain("you own 66");
    expect(block?.textContent).not.toContain("Best Action");
  });

  /*
    THE LANGUAGE GROUP DEGRADES TO NOTHING, and these two are the pair that says so.

    On an index built before the origin stage `title_lang` does not exist, the membership
    query returns nothing, and the completion payload omits every language list. A row drawn
    anyway would be a link to a page reading "Nothing matches that" under the heading "Best
    films in Korean" -- degrading to an empty PRODUCT, which is the one thing the card that
    built these lists ruled out.
  */
  test("no language row, and no heading over them, until the server has counted one", async () => {
    stubFetch(EMPTY);
    render(await routed());

    await waitFor(() => expect(paths).toEqual(["/api/lists/completion"]));
    expect(screen.queryByText("Best films in Korean")).toBeNull();
    expect(screen.queryByText("By language")).toBeNull();
    // The groups that need no proof are untouched -- they are carried by every index this
    // product has ever built, and drawing them at once is what keeps this page complete.
    expect(screen.getByText("Best Action")).toBeDefined();
    expect(screen.getByText("finderr Top 250")).toBeDefined();
  });

  test("a counted language draws its row, and an uncounted sibling still does not", async () => {
    stubFetch({ ...EMPTY, completions: [{ id: "lang-ko", size: 250, owned: 12 }] });
    render(await routed());

    await waitFor(() => expect(screen.getByText("Best films in Korean")).toBeDefined());
    expect(screen.getByText("By language")).toBeDefined();
    // Per ROW rather than per group: an index can hold Korean and nothing in Bengali, and
    // the row it cannot substantiate is the one that goes.
    expect(screen.queryByText("Best films in Bengali")).toBeNull();
  });

  test("a poster is drawn INSIDE the award's own link, and never as a link of its own", async () => {
    // Nested links are not a thing a browser can render, and the strip is decoration for a
    // row that already says where it goes -- so it is hidden from the accessibility tree
    // rather than read out as five more destinations.
    stubFetch(FULL);
    render(await routed());

    await waitFor(() => expect(document.querySelector('img[src^="/img/t/"]')).not.toBeNull());
    const link = document.querySelector(`a[href="/awards/${AWARD}"]`);
    expect(link?.querySelectorAll("img")).toHaveLength(2);
    expect(link?.querySelectorAll("a")).toHaveLength(0);
    expect(link?.querySelector("[aria-hidden]")).not.toBeNull();
  });
});
