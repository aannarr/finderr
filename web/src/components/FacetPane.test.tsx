/**
 * The rule every pane follows -- skeleton, content, problem, hidden -- and the one case
 * that rule structurally cannot decide.
 *
 * Tested HERE rather than through `TitlePanes` because this is where the rule lives --
 * the card that produced it said so: "a test covering it, at the `FacetPane`/`paneView`
 * level rather than per pane". The render function draws plain text, so nothing needs a
 * router or an `AppProvider`, which is what `TitlePanes.test.tsx` cannot get past for the
 * panes that draw real cards.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FacetName, FacetProblem, ResolvedFacets } from "../lib/facets";
import { FacetPane } from "./FacetPane";

function render(
  facets: ResolvedFacets | undefined,
  working: readonly FacetName[] | undefined,
  drawing?: { count: number; whenNone: string },
  problems?: readonly FacetProblem[],
): string {
  return renderToStaticMarkup(
    <FacetPane
      heading="Keywords"
      facets={facets}
      facet="keywords"
      working={working}
      problems={problems}
      skeleton={<span>SKELETON</span>}
      render={(data) => <span>DREW {data.length}</span>}
      drawing={drawing}
    />,
  );
}

const READY = { keywords: { status: "ready", data: [{ name: "heist" }] } } as unknown as ResolvedFacets;

describe("the rule every pane follows", () => {
  test("no response yet reserves the space", () => {
    expect(render(undefined, undefined)).toContain("SKELETON");
  });

  test("pending with a provider still owed holds the skeleton", () => {
    const facets = { keywords: { status: "pending" } } as unknown as ResolvedFacets;
    expect(render(facets, ["keywords"])).toContain("SKELETON");
  });

  test("pending with nobody working disappears rather than lying about work", () => {
    const facets = { keywords: { status: "pending" } } as unknown as ResolvedFacets;
    expect(render(facets, [])).toBe("");
  });

  test.each(["empty", "failed"])("a %s facet nobody named leaves nothing behind", (status) => {
    const facets = { keywords: { status } } as unknown as ResolvedFacets;
    expect(render(facets, [])).toBe("");
  });

  test("ready with content draws it", () => {
    expect(render(READY, [])).toContain("DREW 1");
  });
});

/**
 * The state this file's header used to call "the fourth case", which was `drawing` below.
 *
 * A failure went down the `hidden` path with `empty`, so a pane whose provider timed out
 * looked exactly like a pane whose provider said "nothing". The reader could not tell those
 * apart and neither could anybody debugging it, while the answer was already on the wire.
 */
describe("a provider that failed, by name", () => {
  const FAILED = { keywords: { status: "failed" } } as unknown as ResolvedFacets;
  const PROBLEMS: FacetProblem[] = [{ pluginId: "servarr-metadata", facet: "keywords", reason: "timeout" }];

  test("keeps its heading and says which addon failed and why", () => {
    const html = render(FAILED, [], undefined, PROBLEMS);
    expect(html).toContain("Keywords");
    expect(html).toContain("Unavailable: servarr-metadata timed out");
  });

  test("an EMPTY facet is untouched by any of this", () => {
    // The pane a reader sees for "there genuinely is no answer" must not change: `empty` is
    // a real answer, and today's silence is the right output for it.
    const empty = { keywords: { status: "empty" } } as unknown as ResolvedFacets;
    expect(render(empty, [], undefined, PROBLEMS)).toBe("");
  });

  test("is NOT busy -- nothing is in flight, this is the final answer for this view", () => {
    expect(render(FAILED, [], undefined, PROBLEMS)).not.toContain('aria-busy="true"');
  });

  test("draws no skeleton, and never calls render", () => {
    const html = render(FAILED, [], undefined, PROBLEMS);
    expect(html).not.toContain("SKELETON");
    expect(html).not.toContain("DREW");
  });
});

/**
 * The case `paneView` structurally cannot decide.
 *
 * A pane that draws something OTHER than its facet's members -- `collection` and
 * `related` draw index rows -- can be handed a `ready`, non-empty facet and still have
 * nothing to put on screen. `paneView` sees only the facet, so it says `content` and the
 * heading gets drawn over a void. That was the bug.
 */
describe("a pane that cannot draw what its facet named", () => {
  test("says so instead of drawing a heading over nothing", () => {
    const html = render(READY, [], { count: 0, whenNone: "NONE HELD" });
    expect(html).toContain("Keywords");
    expect(html).toContain("NONE HELD");
    expect(html).not.toContain("DREW");
  });

  test("a non-zero count takes the ordinary path", () => {
    const html = render(READY, [], { count: 2, whenNone: "NONE HELD" });
    expect(html).toContain("DREW 1");
    expect(html).not.toContain("NONE HELD");
  });

  test("the sentence is NOT busy -- nothing is in flight, this is the final answer", () => {
    // aria-busy here would tell a screen reader to expect the content to change. It will
    // not: the provider answered, and this is what the answer amounts to.
    expect(render(READY, [], { count: 0, whenNone: "NONE HELD" })).not.toContain('aria-busy="true"');
  });

  test("a zero count NEVER resurrects a pane the rule already hid", () => {
    // The ordering that matters: `hidden` wins over `drawing`. A failed provider with a
    // count of zero must stay silent rather than claim an index shortfall -- those are
    // different sentences and only one of them would be true.
    const facets = { keywords: { status: "failed" } } as unknown as ResolvedFacets;
    expect(render(facets, [], { count: 0, whenNone: "NONE HELD" })).toBe("");
  });

  test("a zero count does not replace a skeleton while work is outstanding", () => {
    // Before the facet lands, `count` is 0 simply because nothing has arrived. Saying
    // "none are in the index" then would be a guess dressed as an answer.
    const facets = { keywords: { status: "pending" } } as unknown as ResolvedFacets;
    const html = render(facets, ["keywords"], { count: 0, whenNone: "NONE HELD" });
    expect(html).toContain("SKELETON");
    expect(html).not.toContain("NONE HELD");
  });

  test("omitting drawing leaves every other pane exactly as it was", () => {
    expect(render(READY, [])).toContain("DREW 1");
  });
});
