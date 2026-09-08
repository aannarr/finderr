/**
 * What the one poster component actually puts on the page.
 *
 * Rendered with `react-dom/server`, like `TitlePanes.test.tsx` and for the same reason:
 * every question here is "which markup appears for this input", and static markup answers
 * it with no DOM and no test-library dependency.
 *
 * These are not cosmetic assertions. Four screens draw through this component now, so a
 * regression here is a regression on all of them at once -- and the two rules worth pinning
 * are exactly the ones that were re-decided differently by each of the four before it
 * existed: the frame is always drawn, and a link is only offered when there is somewhere to
 * go.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Title } from "../lib/api";
import { makeTitle } from "../test/title-fixture";
import { Poster } from "./Poster";

/** `posterUrl` is null in the fixture, which is the "no image" branch every fallback below is about. */
const TITLE = makeTitle();

/** The same title, with artwork. The server hands the client a same-origin path, never an upstream URL. */
const WITH_ART: Title = { ...TITLE, posterUrl: "/img/t/tt1375666" };

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("the frame is always drawn", () => {
  test("a title with no artwork still occupies its box", () => {
    // The whole reason this is one component: a poster that appears only on success makes
    // the row above it jump when the image lands, and a grid reflow when it does not.
    const html = render(<Poster title={TITLE} className="aspect-2/3 w-16" />);
    expect(html).toContain("aspect-2/3");
    expect(html).toContain("w-16");
    expect(html).not.toContain("<img");
  });

  test("no title at all still occupies its box", () => {
    // A nomination naming a film we do not index. The column of text beside it has to stay
    // straight rather than stepping in and out row by row.
    const html = render(<Poster className="aspect-2/3 w-8" />);
    expect(html).toContain("aspect-2/3");
    expect(html).not.toContain("<img");
  });

  test("the frame is positioned, so the layers inside it cannot escape", () => {
    // Forced on rather than left to the caller: every layer is absolutely positioned, and a
    // caller who forgot `relative` would have the image escape to the nearest positioned
    // ancestor -- which fails silently and looks like a bug somewhere else entirely.
    expect(render(<Poster title={WITH_ART} />)).toContain("relative");
  });
});

describe("the image", () => {
  test("is rendered with the requested size and lazily by default", () => {
    const html = render(<Poster title={WITH_ART} size="w92" />);
    expect(html).toContain("/img/t/tt1375666?size=w92");
    expect(html).toContain('loading="lazy"');
  });

  test("`eager` opts out, for the one poster above the fold", () => {
    expect(render(<Poster title={WITH_ART} eager />)).toContain('loading="eager"');
  });

  test("is decorative by default -- the title is already in the DOM beside it", () => {
    expect(render(<Poster title={WITH_ART} />)).toContain('alt=""');
  });

  test("an uncached image starts hidden and keeps its fade", () => {
    // Two halves of one rule, and this test can only pin the first. An image the browser
    // has NOT yet fetched starts at opacity-0 with the 300ms transition, so a slow poster
    // fades in over the frame rather than popping -- that is deliberate, documented in the
    // component, and this assertion is what stops someone "fixing" the flash below by
    // deleting the fade for everyone.
    //
    // The second half -- an image already complete at mount latches `loaded` from a ref
    // callback during the commit phase, so navigating Back to the grid does not re-fade
    // every cached poster -- CANNOT be expressed here. `renderToStaticMarkup` never creates
    // a DOM node, so a ref callback never runs and `complete`/`naturalWidth` do not exist;
    // asserting on it would test the absence of a DOM, not the behaviour. The ref lives on
    // the `<img>` in `Poster.tsx` with the full story; if these classes ever stop appearing
    // in static markup, either the fade was removed or the latch started running where no
    // image exists -- both are regressions.
    const html = render(<Poster title={WITH_ART} />);
    expect(html).toContain("opacity-0");
    expect(html).toContain("transition-opacity");
    expect(html).not.toContain("opacity-100");
  });
});

describe("fallbacks", () => {
  test("`tile` draws the monogram, with leading articles dropped", () => {
    // "The Inception" -> "I", not "TI": an article is not part of what a person would
    // shorten the title to, and every card in a grid would otherwise start with T.
    const html = render(<Poster title={TITLE} fallback="tile" />);
    expect(html).toContain(">I<");
    expect(html).toContain("linear-gradient");
  });

  test("`tile` is deterministic -- the same title always gets the same colour", () => {
    // A hue that changed between renders would make a grid shimmer on every navigation.
    expect(render(<Poster title={TITLE} fallback="tile" />)).toBe(
      render(<Poster title={TITLE} fallback="tile" />),
    );
  });

  test("`label` says what happened, for the one big box where silence reads as broken", () => {
    expect(render(<Poster title={TITLE} fallback="label" />)).toContain("No artwork");
  });

  test("`plain` says nothing at all, which is right for a 32px row", () => {
    const html = render(<Poster title={TITLE} fallback="plain" />);
    expect(html).not.toContain("No artwork");
    expect(html).not.toContain("linear-gradient");
  });

  test("a fallback never draws over an image we actually have", () => {
    const html = render(<Poster title={WITH_ART} fallback="label" />);
    expect(html).toContain("<img");
    expect(html).not.toContain("No artwork");
  });
});

/**
 * Only the UNLINKED branch is rendered here, and that is the house convention rather than a
 * gap. The linked branch is a TanStack `<Link>`, which throws outside a `RouterProvider`;
 * `TitlePanes.test.tsx` makes the same call for the same reason -- standing a router up to
 * read one `href` tests the router, not this component.
 *
 * What can actually go wrong on this side is the DECISION -- offering a link to nowhere --
 * and that branch renders a plain element, so it is fully covered below.
 */
describe("linking", () => {
  test("a poster with no row is NOT a link, even when asked", () => {
    // Navigable does not outrank honest: a link to a page that 404s is worse than a frame
    // that is merely a frame. The ceremony page asks for `link` on every row and about a
    // tenth of them name a film we hold no row for.
    expect(render(<Poster link className="w-8" />)).not.toContain("<a");
  });

  test("an empty frame is hidden from assistive tech rather than announced as nothing", () => {
    expect(render(<Poster title={TITLE} />)).toContain("aria-hidden");
    expect(render(<Poster title={WITH_ART} />)).not.toContain("aria-hidden");
  });
});
