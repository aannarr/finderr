/**
 * `ATTRIBUTION.md` survives the trip through our own markdown renderer.
 *
 * `src/lib/attribution.test.ts` asserts the document says the right things. This asserts
 * the reader can actually SEE them -- a different question, and the one that would have
 * caught the two shapes the renderer has no block for. It parses no tables and no `<url>`
 * autolinks, so a document written for GitHub alone renders here as a wall of pipes or a
 * literal angle bracket, passing every content check on the way.
 *
 * Rendered with `react-dom/server` like the other component tests here.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SourcesRoute } from "./SourcesRoute";

const html = renderToStaticMarkup(<SourcesRoute />);

describe("SourcesRoute", () => {
  test("renders the required notices as readable text", () => {
    expect(html).toContain("Information courtesy of IMDb");
    expect(html).toContain("This product uses the TMDB API but is not endorsed or certified by TMDB.");
  });

  test("renders headings rather than raw hashes", () => {
    expect(html).toMatch(/<h\d[^>]*>Required notices<\/h\d>/);
    expect(html).not.toContain("## ");
  });

  test("turns every address into a real link", () => {
    expect(html).toContain('href="https://www.themoviedb.org"');
    expect(html).toContain('href="https://github.com/DLu/oscar_data"');
    // A markdown link that failed to parse leaves its own syntax on the page, which is the
    // visible symptom of using a form the renderer does not carry.
    expect(html).not.toContain("](http");
    expect(html).not.toContain("&lt;http");
  });

  test("draws TMDB's mark from our own origin", () => {
    // The notice is required WITH a logo, and an `<img>` here may only load locally --
    // hotlinking their CDN is the rule `localImageUrl` exists to enforce everywhere else.
    expect(html).toContain('src="/logos/rating/tmdb.png"');
  });

  test("carries no table, which this renderer would print as pipes", () => {
    expect(html).not.toContain("|---");
  });
});
