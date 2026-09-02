import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  ogType,
  type PreviewTitle,
  previewDescription,
  previewTitle,
  renderPreviewPage,
} from "./og-preview";

const BATMAN: PreviewTitle = {
  tconst: "tt0096895",
  title: "Batman",
  year: 1989,
  kind: "movie",
  genres: "Action,Adventure",
  rating: 7.5,
  votes: 402_000,
};

function render(over: Partial<Parameters<typeof renderPreviewPage>[0]> = {}) {
  return renderPreviewPage({
    title: BATMAN,
    synopsis: null,
    imageUrl: null,
    origin: "https://finderr.example.com",
    returnPath: "/title/tt0096895",
    ...over,
  });
}

describe("escapeHtml", () => {
  test("closes every way out of a double-quoted attribute", () => {
    expect(escapeHtml(`" onload="alert(1)`)).toBe("&quot; onload=&quot;alert(1)");
    expect(escapeHtml("<script>x</script>")).toBe("&lt;script&gt;x&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's `back`")).toBe("it&#39;s &#96;back&#96;");
  });

  test("escapes the ampersand FIRST, so an entity is not double-encoded into a live one", () => {
    // Getting the order wrong turns `&` into `&amp;` after `<` became `&lt;`, yielding
    // `&amp;lt;` -- visible garbage -- or worse, reconstitutes a tag.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("previewDescription", () => {
  test("prefers a real synopsis", () => {
    expect(previewDescription(BATMAN, "The Dark Knight of Gotham City.")).toBe(
      "The Dark Knight of Gotham City.",
    );
  });

  test("falls back to what the index alone knows", () => {
    expect(previewDescription(BATMAN, null)).toBe("Action, Adventure · 1989 · ★7.5");
  });

  test("drops a rating nothing voted on", () => {
    expect(previewDescription({ ...BATMAN, rating: 0, votes: 0 }, null)).toBe("Action, Adventure · 1989");
  });

  test("survives a title with no year and no genres", () => {
    const bare = { ...BATMAN, year: null, genres: "", rating: 0, votes: 0 };
    expect(previewDescription(bare, null)).toBe("");
    // And the page still renders rather than throwing on the empty string.
    expect(render({ title: bare })).toContain("<h1>Batman</h1>");
  });

  test("truncates on a word boundary and marks the cut", () => {
    const long = `${"word ".repeat(80)}end`;
    const out = previewDescription(BATMAN, long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("wor…");
  });

  test("collapses the whitespace a provider's blurb arrives with", () => {
    expect(previewDescription(BATMAN, "  two\n\nlines  ")).toBe("two lines");
  });
});

describe("ogType", () => {
  test("splits series from film", () => {
    expect(ogType("movie")).toBe("video.movie");
    expect(ogType("tvMovie")).toBe("video.movie");
    expect(ogType("tvSeries")).toBe("video.tv_show");
    expect(ogType("tvMiniSeries")).toBe("video.tv_show");
  });
});

describe("previewTitle", () => {
  test("carries the year when there is one", () => {
    expect(previewTitle(BATMAN)).toBe("Batman (1989)");
    expect(previewTitle({ ...BATMAN, year: null })).toBe("Batman");
  });
});

describe("renderPreviewPage", () => {
  test("emits the tags an unfurl actually reads", () => {
    const html = render({ synopsis: "Gotham's protector." });
    expect(html).toContain('<meta property="og:title" content="Batman (1989)">');
    expect(html).toContain('<meta property="og:type" content="video.movie">');
    expect(html).toContain('<meta property="og:url" content="https://finderr.example.com/title/tt0096895">');
    expect(html).toContain('<meta property="og:description" content="Gotham&#39;s protector.">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  test("ships NO og:image when there is no cached poster", () => {
    const html = render();
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("<img");
  });

  test("ships the image and its dimensions when there is one", () => {
    const html = render({ imageUrl: "https://finderr.example.com/img/og/tt0096895" });
    expect(html).toContain(
      '<meta property="og:image" content="https://finderr.example.com/img/og/tt0096895">',
    );
    expect(html).toContain('<meta property="og:image:width" content="342">');
    expect(html).toContain('<meta property="og:image:height" content="513">');
  });

  test("a hostile synopsis cannot break out of the meta attribute", () => {
    const html = render({ synopsis: `"><script>alert(1)</script>` });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("the sign-in link carries the destination", () => {
    const html = render({ returnPath: "/title/tt0096895" });
    expect(html).toContain('href="/?next=%2Ftitle%2Ftt0096895"');
  });

  /**
   * The disclosure rule, pinned as a test rather than as a comment: this page is about the
   * FILM. A future edit that helpfully adds "in your library" would go green everywhere
   * else and quietly publish request state to strangers.
   */
  test("names nothing about this deployment", () => {
    const html = render({ synopsis: "Gotham's protector." }).toLowerCase();
    for (const leak of ["radarr", "sonarr", "plex", "requested", "library", "/api/", "hasfile"]) {
      expect(html).not.toContain(leak);
    }
  });

  /**
   * The card printed "1989 · Crime" and then "Crime · 1989 · ★7.5" directly under it for
   * any title whose synopsis has not been fetched -- which is the common case for a cold
   * share, and the one where a reader is most likely to think the page is broken. Caught in
   * a browser, not by a test, which is why there is now a test.
   */
  test("does not print the same facts twice when there is no synopsis", () => {
    const html = render();
    expect(html).toContain('<p class="meta">Action, Adventure · 1989 · ★7.5</p>');
    // Scoped to the BODY: the meta tags carry the same string, correctly and invisibly.
    const body = html.slice(html.indexOf("<body>"));
    expect(body.match(/Action, Adventure · 1989 · ★7\.5/g)).toHaveLength(1);
  });

  test("prints the synopsis in the body when there is one", () => {
    const html = render({ synopsis: "Gotham's protector." });
    expect(html).toContain("<p>Gotham&#39;s protector.</p>");
    expect(html).toContain('<p class="meta">Action, Adventure · 1989 · ★7.5</p>');
  });

  test("references no hashed asset, so it cannot rot against a rebuilt bundle", () => {
    expect(render()).not.toContain("<script");
    expect(render()).not.toContain('rel="stylesheet"');
  });
});
