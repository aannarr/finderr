/**
 * What the panes actually put on the page, per facet status.
 *
 * Rendered with `react-dom/server`, which needs no DOM and no test-library dependency:
 * these assertions are about WHICH markup appears for a status, and static markup
 * answers that exactly. Anything needing a click or a layout measurement is not here.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Title } from "../lib/api";
import type { FacetName, ResolvedFacets } from "../lib/facets";
import {
  PERSON_LINK_CLASS,
  RATING_CAPTION_SLOT,
  RATING_TILE_SIZE,
  TitleFactsCard,
  TitleLowerPanes,
  TitleMainPanes,
} from "./TitlePanes";

const TITLE: Title = {
  tconst: "tt1375666",
  title: "Inception",
  orig: null,
  year: 2010,
  kind: "movie",
  votes: 2_400_000,
  rating: 8.4,
  genres: "Action,Sci-Fi",
  runtime: 148,
  inLibrary: false,
  hasFile: false,
  progress: null,
  requestStatus: null,
  requestError: null,
  requestVerdict: null,
  requestProgress: null,
  requestEtaAt: null,
  requestEvidence: null,
  service: "radarr",
  posterUrl: null,
  studio: null,
  studioLogo: null,
  plex: null,
};

/**
 * The three regions the route mounts, in the route's order: the facts card (the desktop
 * rail), the reading flow, the full-width lower half. Composed here the same way so the
 * assertions keep covering the whole pane set -- including the fact that the lookup facts
 * render TWICE (rail card and mobile `<details>`), which is why the facts assertions below
 * use `toContain` rather than counting.
 */
function render(
  facets: ResolvedFacets | undefined,
  working: readonly FacetName[] | undefined = undefined,
  people?: Record<string, string>,
  rows?: { collectionTitles?: Title[]; relatedTitles?: Title[] },
): string {
  return renderToStaticMarkup(
    <>
      <TitleFactsCard facets={facets} working={working} />
      <TitleMainPanes title={TITLE} facets={facets} working={working} />
      <TitleLowerPanes
        title={TITLE}
        facets={facets}
        working={working}
        people={people}
        collectionTitles={rows?.collectionTitles}
        relatedTitles={rows?.relatedTitles}
      />
    </>,
  );
}

/**
 * The heading of every pane that drew itself, in order.
 *
 * "This facet's pane is gone" used to be spelt `expect(render(...)).toBe("")`, which was
 * only ever true by accident: it read as "the pane disappeared" and actually asserted that
 * the WHOLE PAGE was empty. Naming the headings says the intended thing directly, and says
 * which pane survived when it fails.
 */
function paneHeadings(html: string): string[] {
  return [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((m) => m[1]);
}

/**
 * The floor every "nothing else is here" assertion sits on, and it is EMPTY.
 *
 * It held `["Links"]` until the links row moved under the synopsis and lost its heading.
 * That row is still always drawn -- it is built from the `tconst` in the local row rather
 * than from a facet -- it just is not a section any more, so `linkHrefs` is what pins it.
 */
const ALWAYS: string[] = [];

/** Every address the links row is offering, which is the row's real assertion surface. */
function linkHrefs(html: string): string[] {
  return [...html.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
}

describe("before the first response", () => {
  test("every pane reserves its space instead of popping in later", () => {
    const html = render(undefined);
    expect(html).toContain("Synopsis");
    expect(html).toContain("Cast");
    expect(html).toContain("animate-pulse");
    // Reserved space, and said out loud for anything reading the page non-visually.
    expect(html).toContain('aria-busy="true"');
  });
});

describe("a facet nobody can answer", () => {
  /** With no provider installed at all, the page must look finished, not broken. */
  test("empty and failed panes leave nothing behind -- no heading, no skeleton", () => {
    const html = render({
      synopsis: { status: "empty" },
      cast: { status: "failed" },
      ratings: { status: "empty" },
    });
    expect(paneHeadings(html)).toEqual(ALWAYS);
    expect(html).not.toContain("animate-pulse");
  });
});

describe("a facet that resolves", () => {
  test("the cast row renders billed order, with initials where a headshot is missing", () => {
    const html = render({
      cast: {
        status: "ready",
        data: [
          { name: "Ellen Page", character: "Ariadne", order: 2, personId: "p2", image: null },
          { name: "Leonardo DiCaprio", character: "Cobb", order: 1, personId: "p1", image: null },
        ],
      },
    });
    expect(html.indexOf("Leonardo DiCaprio")).toBeLessThan(html.indexOf("Ellen Page"));
    expect(html).toContain("LD");
    expect(html).toContain("Ariadne");
    expect(html).not.toContain("animate-pulse");
  });

  /**
   * The pane the whole facet-list design exists for: one row, several sources, and the
   * IMDb score we already hold locally sitting in it beside them.
   */
  test("the ratings row merges the local IMDb score with every provider's", () => {
    const html = render({
      ratings: {
        status: "ready",
        data: [{ source: "Rotten Tomatoes", kind: "critics", value: 86, outOf: 100 }],
      },
    });
    expect(html).toContain("8.4");
    expect(html).toContain("IMDb");
    expect(html).toContain("86%");
    expect(html).toContain("Rotten Tomatoes");
  });

  /**
   * Every score in the row sits on one line, whatever each source sent.
   *
   * The tile is a fixed height with a vertically centred column, so a caption rendered only
   * where there is a vote count does not merely add a caption -- it MOVES THE SCORE. IMDb
   * carries a count and Rotten Tomatoes carries none, so the row shipped with its numbers at
   * two different heights. Counting slots against tiles is the assertion that survives a
   * restyle: it says every tile reserves the line, without pinning any particular class.
   */
  test("every rating tile reserves the caption line, so no score sits higher than another", () => {
    const html = render({
      ratings: {
        status: "ready",
        data: [
          { source: "Rotten Tomatoes", kind: "critics", value: 86, outOf: 100 },
          { source: "Rotten Tomatoes", kind: "audience", value: 91, outOf: 100 },
        ],
      },
    });

    const occurrences = (needle: string) => html.split(needle).length - 1;
    // The local IMDb seed plus RT's two halves. Only the first of the three has a count.
    expect(occurrences(RATING_TILE_SIZE)).toBe(3);
    expect(occurrences(RATING_CAPTION_SLOT)).toBe(3);
    expect(html).toContain("2.4M votes");
  });

  /**
   * The caption spans the tile, so it is a SIBLING of the mark-and-score line.
   *
   * Nested inside the score's own column -- which is where it started -- it began after the
   * mark and read as a caption belonging to the number rather than to the tile. Asserted
   * structurally rather than by class name: the element that holds the mark must also hold
   * the score and must have CLOSED before the caption opens. A re-nest puts the caption
   * inside that element and this goes red; a restyle that keeps the shape does not.
   */
  test("the vote count sits under the mark and the score, not beside the score", () => {
    // One provided score so the pane renders at all; the tile under test is the IMDb seed
    // in front of it, which is the only one carrying BOTH a mark and a vote count.
    const html = render({
      ratings: {
        status: "ready",
        data: [{ source: "Rotten Tomatoes", kind: "critics", value: 86, outOf: 100 }],
      },
    });

    const mark = html.indexOf("<img");
    const caption = html.indexOf(`<span class="${RATING_CAPTION_SLOT}"`);
    expect(mark).toBeGreaterThan(-1);
    expect(caption).toBeGreaterThan(mark);

    // Everything between the mark and the caption is the headline's tail. It holds the
    // score, and its span nesting returns to zero -- the headline closed before the
    // caption began, which is what makes them siblings.
    const headlineTail = html.slice(mark, caption);
    expect(headlineTail).toContain("8.4");
    const opened = (headlineTail.match(/<span/g) ?? []).length;
    const closed = (headlineTail.match(/<\/span>/g) ?? []).length;
    expect(closed).toBe(opened + 1);
  });

  /**
   * The other half of the guard below, and the one that only became possible once the
   * server started rewriting headshots to `/img/f/<key>`. A green guard proves an
   * upstream URL is refused; it cannot prove a proxied one actually draws a face.
   */
  test("a proxied headshot reaches the img tag, and initials give way to it", () => {
    const html = render({
      cast: {
        status: "ready",
        data: [
          {
            name: "Cillian Murphy",
            character: null,
            order: 1,
            personId: null,
            image: "/img/f/9f3a1c",
          },
        ],
      },
    });
    expect(html).toContain('<img src="/img/f/9f3a1c"');
    expect(html).not.toContain(">CM<");
  });

  test("an upstream headshot URL never reaches an img tag", () => {
    const html = render({
      cast: {
        status: "ready",
        data: [
          {
            name: "Cillian Murphy",
            character: null,
            order: 1,
            personId: null,
            image: "https://image.tmdb.org/x.jpg",
          },
        ],
      },
    });
    expect(html).not.toContain("tmdb.org");
    expect(html).toContain("CM");
  });
});

describe("a facet that misses the deadline", () => {
  const pending: ResolvedFacets = { cast: { status: "pending" }, synopsis: { status: "pending" } };

  test("holds a skeleton while the providers still have time", () => {
    expect(
      render(pending, [
        "cast",
        "crew",
        "ratings",
        "synopsis",
        "keywords",
        "certification",
        "releaseDates",
        "trailer",
        "collection",
        "related",
        "externalIds",
        "watchProviders",
      ]),
    ).toContain("animate-pulse");
  });

  /**
   * Never a permanent skeleton. The answer is cached server-side either way, so it is
   * there at t=0 on the next view -- a placeholder that never resolves would just be
   * a lie about this one.
   */
  test("stops waiting once they have had their turn", () => {
    const html = render(pending, []);
    expect(paneHeadings(html)).toEqual(ALWAYS);
    expect(html).not.toContain("animate-pulse");
  });
});

/**
 * The row that replaced the "tt1375666 on IMDb" line of small print under the request
 * button. It is the one part of the page not driven by a facet, so it is the one with a
 * rule of its own worth pinning.
 */
describe("the links row", () => {
  test("draws the addresses the tconst alone can reach, before any provider answers", () => {
    const html = render(undefined);
    expect(html).toContain('href="https://www.imdb.com/title/tt1375666/"');
    expect(html).toContain('href="https://trakt.tv/search/imdb/tt1375666"');
    expect(html).toContain("Letterboxd");
  });

  /**
   * The whole reason it is not a `FacetPane`. Every other pane vanishes when its facet
   * says there is nothing; this one has the local row and always has something to draw,
   * so a page where every provider failed still gets the reader to IMDb -- and it is then
   * the ONLY thing on the page, with not one section heading around it.
   */
  test("survives a page on which every facet failed", () => {
    const html = render({ synopsis: { status: "failed" }, externalIds: { status: "failed" } });
    expect(paneHeadings(html)).toEqual(ALWAYS);
    expect(linkHrefs(html)).toContain("https://www.imdb.com/title/tt1375666/");
  });

  /** Under the synopsis, above everything a provider fills in. aannarr's call, 2026-08-31. */
  test("sits above the panes, not below them", () => {
    const html = render({
      synopsis: {
        status: "ready",
        data: { text: "A thief who steals secrets.", source: "Tmdb", language: "en" },
      },
      ratings: { status: "ready", data: [{ source: "Imdb", value: 8.8, outOf: 10, kind: "user" }] },
    });
    expect(html.indexOf("imdb.com/title/tt1375666")).toBeLessThan(html.indexOf("Ratings"));
  });

  test("adds the id-space links once externalIds lands, and never repeats one", () => {
    const html = render({
      externalIds: { status: "ready", data: { tmdb: 27205, imdb: "tt1375666" } },
    });
    expect(html).toContain('href="https://www.themoviedb.org/movie/27205"');
    // `externalIds` carries the same IMDb id the local row does. One chip, not two.
    expect(html.match(/imdb\.com\/title/g)).toHaveLength(1);
  });

  /** The `links` facet is for what no id space can express, and it lands in the same row. */
  test("renders a plugin's contributed link under its own name", () => {
    const html = render({
      links: {
        status: "ready",
        data: [{ kind: "homepage", url: "https://www.warnerbros.com/movies/inception" }],
      },
    });
    expect(html).toContain('href="https://www.warnerbros.com/movies/inception"');
    expect(html).toContain("Official site");
  });

  /** A plugin is not the wall, but an href is where a sloppy one turns a string into script. */
  test("refuses a contributed link that is not http(s)", () => {
    const html = render({
      links: { status: "ready", data: [{ kind: "homepage", url: "javascript:alert(1)" }] },
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Official site");
  });
});

describe("panes that are one fact", () => {
  /**
   * The attribution credits a provider, so it prints the provider's NAME.
   *
   * `synopsis.source` is whatever id the plugin used -- `tmdb` for a film off
   * `api.radarr.video`, `tvdb` for a series off skyhook. Both are honest attributions, and
   * both used to render as a bare lowercase slug under a paragraph of prose.
   */
  test("the synopsis credits its provider by name, not by slug", () => {
    const film = render({
      synopsis: { status: "ready", data: { text: "A thief.", language: "en", source: "tmdb" } },
    });
    expect(film).toContain("TMDB");
    expect(film).not.toContain(">tmdb<");

    const series = render({
      synopsis: { status: "ready", data: { text: "Seven families.", language: "en", source: "tvdb" } },
    });
    expect(series).toContain("TheTVDB");
    expect(series).not.toContain(">tvdb<");
  });

  test("shows one certification for the reader's country, not all forty-two", () => {
    const html = render({
      certification: {
        status: "ready",
        data: [
          { country: "DE", rating: "12" },
          { country: "US", rating: "PG-13" },
        ],
      },
    });
    expect(html).toContain("PG-13");
    expect(html).not.toContain(">12<");
  });

  test("keyword chips are inert text, because /browse cannot serve a keyword", () => {
    const html = render({ keywords: { status: "ready", data: [{ id: "k1", name: "heist" }] } });
    // The CHIP is what must not be a link -- scoped to the word itself, because the links
    // pane below puts perfectly legitimate anchors on the same page.
    expect(html).toContain(">heist</span>");
  });

  /**
   * The pane aannarr asked for, on the title he asked about: `tt12574330` is a Hindi film
   * whose synopsis arrives in English, so before this the page said nothing about it.
   *
   * Plain text and no chip -- `/browse` cannot filter on language and the index cannot grow
   * a column for it, so a chip that looks clickable would be a dead end.
   */
  test("the language is named in words, and is not a chip", () => {
    const html = render({ language: { status: "ready", data: [{ code: "hi" }] } });

    expect(html).toContain("Language");
    expect(html).toContain("Hindi");
    expect(html).not.toContain(">hi<");
    expect(html).not.toContain("/browse?language");
  });

  test("a title nobody stated a language for leaves no pane behind", () => {
    expect(render({ language: { status: "ready", data: [] } })).not.toContain("Language");
    expect(render({ language: { status: "empty" } })).not.toContain("Language");
  });

  test("release dates print the windows we have, and only those", () => {
    const html = render({
      releaseDates: { status: "ready", data: { cinema: "2010-07-16", physical: null, digital: null } },
    });
    expect(html).toContain("Cinema");
    expect(html).not.toContain("Physical");
  });

  /**
   * A link out and nothing else: no iframe, because finderr is internet-facing and an
   * embed would put a third party's player on our page.
   */
  test("the trailer pane links out to where it plays, and embeds nothing", () => {
    const html = render({
      trailer: {
        status: "ready",
        data: [{ site: "youtube", key: "cdx31ak4KbQ", name: null, kind: "Trailer" }],
      },
    });
    expect(html).toContain('href="https://www.youtube.com/watch?v=cdx31ak4KbQ"');
    expect(html).toContain(">Trailer<");
    expect(html).not.toContain("<iframe");
  });

  /** A series resolves `[]`, which is the same nothing-to-show a film with no id takes. */
  test("no trailer leaves no pane behind", () => {
    expect(paneHeadings(render({ trailer: { status: "ready", data: [] } }))).toEqual(ALWAYS);
    expect(paneHeadings(render({ trailer: { status: "empty" } }))).toEqual(ALWAYS);
  });

  test("crew collapses one job's people onto one line, director first", () => {
    const html = render({
      crew: {
        status: "ready",
        data: [
          { name: "Jonathan Nolan", job: "Writer", department: null, personId: null, image: null },
          { name: "Christopher Nolan", job: "Director", department: null, personId: null, image: null },
          { name: "Emma Thomas", job: "Producer", department: null, personId: null, image: null },
        ],
      },
    });
    expect(html.indexOf("Director")).toBeLessThan(html.indexOf("Producer"));
    expect(html).toContain("Jonathan Nolan");
  });

  /**
   * The crew pane was half-linked for as long as the index held only actors, directors
   * and writers: a director navigated and the producer beside him did not, which reads as
   * breakage. What decides it is the `people` map, so these two assert both halves of it
   * -- a name we can place is an anchor, a name we cannot is still plain text.
   */
  const CREW = {
    crew: {
      status: "ready" as const,
      data: [
        { name: "Emma Thomas", job: "Producer", department: null, personId: null, image: null },
        { name: "Hans Zimmer", job: "Music", department: null, personId: null, image: null },
      ],
    },
  };

  test("a crew name the index cannot place stays plain text, not a dead link", () => {
    // Nothing in `people`, so nowhere real to send anyone -- and the dead-end rule says
    // do not make it look like there is. Rendered through the whole pane rather than
    // through PersonLink directly, because the map has to survive two components to
    // reach the name.
    const html = render(CREW, [], {});
    expect(html).toContain("Emma Thomas");
    expect(html).toContain("Hans Zimmer");
    expect(html).not.toContain("/person/");
  });

  /**
   * Asserted on the class string rather than on rendered markup: the linked branch is a
   * TanStack `<Link>`, which throws outside a `RouterProvider`, and standing a router up
   * to read one attribute would test the router. What can go wrong here is the STYLE
   * rule, and that is entirely in this string.
   */
  test("a person link wears nothing at rest and underlines on hover and focus", () => {
    expect(PERSON_LINK_CLASS).not.toMatch(/(^|\s)underline(\s|$)/);
    expect(PERSON_LINK_CLASS).toContain("hover:underline");
    // Tailwind puts `hover:` behind `@media (hover:hover)`, so a keyboard and a touch
    // screen get nothing at all without this half.
    expect(PERSON_LINK_CLASS).toContain("focus-visible:underline");
  });
});

/**
 * The bug: a facet that RESOLVED, with real members, whose members we hold no index rows
 * for. `paneView` correctly reports `ready` -- the provider answered and its list is not
 * empty -- so the pane drew its heading, and `PosterRow` returned null underneath it.
 * "Other movies in The Matrix Collection" over a blank strip.
 *
 * Two panes have this shape and both were wrong: `collection` and `related`. It is not a
 * `paneView` failure and cannot be fixed there -- the shortfall lives in a different array
 * from the facet, which is why `FacetPane` has to be told.
 */
describe("a facet that resolved but whose members we do not hold", () => {
  /*
    Deliberately UNNAMED. A named collection heads itself with a `<Link>` to
    `/collection/:id`, and a router-free `renderToStaticMarkup` cannot render one -- the
    same reason this file renders no `TitleCard`. The name is not what is under test here;
    whether a body appears beneath the heading is.
  */
  const COLLECTION = {
    status: "ready" as const,
    data: { id: "10", name: null, titles: [{ tconst: "tt0234215" }] },
  };
  const RELATED = {
    status: "ready" as const,
    data: [{ tconst: "tt0234215", title: "The Matrix Reloaded" }],
  };

  test("the collection pane says so instead of heading an empty row", () => {
    const html = render({ collection: COLLECTION } as unknown as ResolvedFacets, [], undefined, {
      collectionTitles: [],
    });
    expect(paneHeadings(html)).toContain("In this collection");
    expect(html).toContain("are in the index yet");
  });

  test("'More like this' does the same -- reported against this one", () => {
    const html = render({ related: RELATED } as unknown as ResolvedFacets, [], undefined, {
      relatedTitles: [],
    });
    expect(paneHeadings(html)).toContain("More like this");
    expect(html).toContain("are in the index yet");
  });

  test("the heading is never alone -- no pane draws a heading over nothing", () => {
    // The regression in one line: a heading with no body is the defect, whatever the
    // facet. If a future pane reintroduces it, this fails without naming the pane.
    const html = render({ collection: COLLECTION, related: RELATED } as unknown as ResolvedFacets, []);
    for (const heading of paneHeadings(html)) {
      const body = html.slice(html.indexOf(`>${heading}</h3>`) + heading.length + 6);
      expect(body.slice(0, body.indexOf("</section>")).trim().length).toBeGreaterThan(0);
    }
  });

  /*
    The "we DO hold rows" case is not asserted here on purpose: drawing one means drawing
    a `TitleCard`, which needs a router AND an `AppProvider`, and this file renders
    neither. The non-zero branch is covered in `FacetPane.test.tsx`, against a render
    function that draws plain text -- which is where the rule lives anyway.
  */

  /**
   * The distinction that keeps the sentence honest. A provider that FAILED never reaches
   * this branch -- it hides at `paneView` -- so "not in the index yet" can never be shown
   * for what is really "rotten-tomatoes timed out".
   */
  test("a FAILED facet still hides silently rather than claiming an index shortfall", () => {
    const html = render({ collection: { status: "failed" } } as unknown as ResolvedFacets, []);
    expect(paneHeadings(html)).not.toContain("In this collection");
    expect(html).not.toContain("are in the index yet");
  });

  test("still a skeleton while the provider is genuinely working", () => {
    const html = render({ collection: { status: "pending" } } as unknown as ResolvedFacets, ["collection"]);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("are in the index yet");
  });
});
