import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  ogType,
  type PreviewPerson,
  type PreviewTitle,
  personDescription,
  personFactLine,
  personLifespan,
  previewDescription,
  previewTitle,
  renderPersonPreviewPage,
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

  /**
   * The declared width must clear Apple's stated 900px bar on the LONG edge.
   *
   * Asserted as an inequality rather than as the literal 780, because the number that
   * matters is the threshold and a future move to `w1280` should not have to edit a test
   * that was only ever defending "big enough". The exact pair still has to agree with
   * `PREVIEW_IMAGE_SIZE`, which the server test pins from the other side.
   */
  test("ships the image and dimensions large enough for a rich card", () => {
    const html = render({ imageUrl: "https://finderr.example.com/img/og/tt0096895" });
    expect(html).toContain(
      '<meta property="og:image" content="https://finderr.example.com/img/og/tt0096895">',
    );

    const width = Number(/og:image:width" content="(\d+)"/.exec(html)?.[1]);
    const height = Number(/og:image:height" content="(\d+)"/.exec(html)?.[1]);
    // TN3156: "Images should be at least 900 pixels in width", and "less than 150 pixels
    // in width may be ignored or presented as icons". A 2:3 poster satisfies the spirit of
    // that on its long edge; 342x513 -- what shipped until 2026-09-05 -- satisfied neither.
    expect(height).toBeGreaterThanOrEqual(900);
    expect(width).toBeGreaterThan(150);
    // 2:3, so a client laying the card out before the bytes arrive reserves the right box.
    expect(height / width).toBeCloseTo(1.5, 2);
  });

  /**
   * The icon fallback, and the reason it is a test rather than a comment.
   *
   * TN3156: a preview "will use an `apple-touch-icon`, a favicon, or an icon specified by
   * `<link rel="...">`" when it declines the image. This page shipped NONE of the three
   * until 2026-09-05, so a client that rejected the poster fell all the way back to the
   * domain's own card -- which is what a shared link looked like in Messages.
   */
  test("declares an icon for a client that will not use og:image", () => {
    const html = render();
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48">');
  });

  test("an image carries alt text on BOTH vocabularies", () => {
    const html = render({ imageUrl: "https://finderr.example.com/img/og/tt0096895" });
    expect(html).toContain('<meta property="og:image:alt" content="Poster for Batman (1989)">');
    expect(html).toContain('<meta name="twitter:image:alt" content="Poster for Batman (1989)">');
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

const NOLAN: PreviewPerson = {
  nconst: "nm0634240",
  name: "Christopher Nolan",
  birthYear: 1970,
  deathYear: null,
};

function renderPerson(over: Partial<Parameters<typeof renderPersonPreviewPage>[0]> = {}) {
  return renderPersonPreviewPage({
    person: NOLAN,
    knownFor: ["Inception", "The Dark Knight", "Memento"],
    credits: 42,
    imageUrl: null,
    origin: "https://finderr.example.com",
    returnPath: "/person/nm0634240",
    ...over,
  });
}

describe("personLifespan", () => {
  test("both years read as a span", () => {
    expect(personLifespan({ ...NOLAN, birthYear: 1899, deathYear: 1980 })).toBe("1899 – 1980");
  });

  /**
   * A living person is the COMMON case, and a bare year is the wrong answer for them.
   * `1970` alone beside a name, on a card whose neighbours all print release years, reads
   * as the year of a film rather than the year of a birth.
   */
  test("a living person gets the b. prefix rather than a bare year", () => {
    expect(personLifespan(NOLAN)).toBe("b. 1970");
  });

  test("a death year with no birth year still says something", () => {
    expect(personLifespan({ ...NOLAN, birthYear: null, deathYear: 2014 })).toBe("d. 2014");
  });

  test("neither year yields nothing rather than a stray separator", () => {
    expect(personLifespan({ ...NOLAN, birthYear: null, deathYear: null })).toBe("");
  });
});

describe("personFactLine", () => {
  test("lifespan and credit count", () => {
    expect(personFactLine(NOLAN, 42)).toBe("b. 1970 · 42 credits");
  });

  test("one credit is not pluralised", () => {
    expect(personFactLine(NOLAN, 1)).toBe("b. 1970 · 1 credit");
  });

  test("no credits and no years leaves an empty line, never a bare separator", () => {
    expect(personFactLine({ ...NOLAN, birthYear: null, deathYear: null }, 0)).toBe("");
  });
});

describe("personDescription", () => {
  test("reads as a sentence, with an Oxford-free final conjunction", () => {
    expect(personDescription(NOLAN, ["Inception", "The Dark Knight", "Memento"], 42)).toBe(
      "Known for Inception, The Dark Knight and Memento.",
    );
  });

  test("a single credit needs no list at all", () => {
    expect(personDescription(NOLAN, ["Inception"], 1)).toBe("Known for Inception.");
  });

  /**
   * A person we hold with no nameable credits still has to unfurl with SOMETHING -- an
   * empty `og:description` is a worse card than a terse one, and this is the fallback the
   * title half already takes for a title whose synopsis was never fetched.
   */
  test("falls back to the fact line when there is nothing to name", () => {
    expect(personDescription(NOLAN, [], 42)).toBe("b. 1970 · 42 credits");
    expect(personDescription(NOLAN, ["  ", ""], 42)).toBe("b. 1970 · 42 credits");
  });
});

describe("renderPersonPreviewPage", () => {
  /**
   * `profile` is Open Graph's own vertical for a human being. Shipping `video.movie` for a
   * person would file the card under the wrong type on every client that reads it, and is
   * the kind of thing that looks right in a browser and wrong in a chat app.
   */
  test("declares og:type profile, not a video type", () => {
    expect(renderPerson()).toContain('<meta property="og:type" content="profile">');
    expect(renderPerson()).not.toContain("video.movie");
  });

  /**
   * THE WHOLE POINT, pinned. TN3156: metadata behind an auth wall must describe the page
   * being protected, "not the authentication page itself. This avoids showing 'Sign In' as
   * the title for every page behind an authentication wall." Before this, a shared person
   * link unfurled as the sign-in shell's own `<title>`: the bare word `finderr`.
   */
  test("the title is the PERSON, never the sign-in shell's", () => {
    const html = renderPerson();
    expect(html).toContain('<meta property="og:title" content="Christopher Nolan">');
    expect(html).toContain("<title>Christopher Nolan — finderr</title>");
    expect(html).toContain('<meta property="og:url" content="https://finderr.example.com/person/nm0634240">');
  });

  test("the sign-in link returns the reader to the person, not the front page", () => {
    expect(renderPerson()).toContain('href="/?next=%2Fperson%2Fnm0634240"');
  });

  test("ships NO og:image when no face has ever been filed", () => {
    const html = renderPerson();
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("<img");
  });

  test("a headshot ships with the same dimensions and its own alt text", () => {
    const html = renderPerson({ imageUrl: "https://finderr.example.com/img/og/nm0634240" });
    expect(html).toContain(
      '<meta property="og:image" content="https://finderr.example.com/img/og/nm0634240">',
    );
    expect(html).toContain('<meta property="og:image:alt" content="Photograph of Christopher Nolan">');
    expect(Number(/og:image:height" content="(\d+)"/.exec(html)?.[1])).toBeGreaterThanOrEqual(900);
  });

  test("inherits the icon fallback rather than needing its own", () => {
    expect(renderPerson()).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  });

  /**
   * The fact line already prints the lifespan and the credit count, so a body repeating the
   * description would print the same sentence twice -- the duplication `factLine` was split
   * out of the title card to stop.
   */
  test("does not print the same facts twice", () => {
    const body = renderPerson().slice(renderPerson().indexOf("<body>"));
    expect(body).toContain('<p class="meta">b. 1970 · 42 credits</p>');
    expect(body.match(/b\. 1970 · 42 credits/g)).toHaveLength(1);
    expect(body).not.toContain("Known for");
  });

  test("a hostile name cannot break out of the meta attribute", () => {
    const html = renderPerson({
      person: { ...NOLAN, name: `"><script>alert(1)</script>` },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  /** The same disclosure rule the title card is held to, and for the same reason. */
  test("names nothing about this deployment", () => {
    const html = renderPerson().toLowerCase();
    for (const leak of ["radarr", "sonarr", "plex", "requested", "library", "/api/", "hasfile"]) {
      expect(html).not.toContain(leak);
    }
  });
});
