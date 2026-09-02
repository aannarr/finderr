/**
 * What the series pane puts on the page, per facet status.
 *
 * Rendered with `react-dom/server` for the same reason `TitlePanes.test.tsx` is: these
 * assertions are about WHICH markup appears for a status, and static markup answers that
 * with no DOM and no test-library dependency. Choosing a different season needs a click,
 * so the rules behind the selector -- ordering, the default, the labels -- are tested as
 * pure functions in `../lib/facet-panes.test.ts` instead.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EpisodeState } from "../lib/api";
import type { Episode, FacetName, ResolvedFacets, Season } from "../lib/facets";
import { SeriesPane } from "./SeriesPane";

function season(over: Partial<Season> & { number: number }): Season {
  return { name: null, episodeCount: 10, premiereDate: null, endDate: null, image: null, ...over };
}

function episode(over: Partial<Episode> & { season: number; number: number }): Episode {
  return { title: null, airDate: null, overview: null, image: null, runtime: null, ...over };
}

/** Game of Thrones as skyhook actually sends it: eight named seasons plus the specials. */
const GOT_SEASONS: Season[] = [
  season({ number: 0, episodeCount: 55 }),
  ...["Winter is Coming", "Hear me Roar!", "Fire and Blood", "Ours is the Fury"].map((name, i) =>
    season({ number: i + 1, name, premiereDate: "2011-04-17", endDate: "2011-06-19" }),
  ),
];

const GOT_EPISODES: Episode[] = [
  episode({ season: 0, number: 1, title: "Inside Game of Thrones", airDate: "2010-12-05" }),
  episode({ season: 2, number: 1, title: "The North Remembers", airDate: "2012-04-01" }),
  episode({ season: 1, number: 2, title: "The Kingsroad", airDate: "2011-04-24" }),
  episode({
    season: 1,
    number: 1,
    title: "Winter Is Coming",
    airDate: "2011-04-17",
    overview: "Eddard Stark is torn between his family and an old friend.",
  }),
];

function render(
  facets: ResolvedFacets | undefined,
  working: readonly FacetName[] = ["seasons", "episodes"],
  episodeState?: readonly EpisodeState[],
): string {
  return renderToStaticMarkup(<SeriesPane facets={facets} working={working} episodeState={episodeState} />);
}

describe("a film", () => {
  /** `seasons` is declared for series only, so the key is simply absent on a film. */
  test("gets no season shell at all, and no kind check was needed to arrange that", () => {
    expect(render({ synopsis: { status: "ready", data: { text: "x", language: "en", source: "s" } } })).toBe(
      "",
    );
  });
});

describe("before the providers have answered", () => {
  test("reserves the selector and the rows under it", () => {
    const html = render(undefined);
    expect(html).toContain("Seasons");
    expect(html).toContain("animate-pulse");
    expect(html).toContain('aria-busy="true"');
  });

  test("gives up quietly once no provider is working on either facet", () => {
    const pending: ResolvedFacets = { seasons: { status: "pending" }, episodes: { status: "pending" } };
    expect(render(pending, [])).toBe("");
  });

  /** The pane is built on TWO facets, so each half follows the work state of its own. */
  test("keeps the seasons skeleton while only seasons is still being worked", () => {
    const pending: ResolvedFacets = { seasons: { status: "pending" }, episodes: { status: "pending" } };
    expect(render(pending, ["seasons"])).toContain("animate-pulse");
  });
});

describe("a series with both facets resolved", () => {
  const facets: ResolvedFacets = {
    seasons: { status: "ready", data: GOT_SEASONS },
    episodes: { status: "ready", data: GOT_EPISODES },
  };

  test("names every season it was given a name for", () => {
    const html = render(facets);
    expect(html).toContain("Season 1 · Winter is Coming");
    expect(html).toContain("Season 4 · Ours is the Fury");
  });

  test("keeps the specials, last and unselected -- they are an appendix, not season one", () => {
    const html = render(facets);
    expect(html).toContain("Specials");
    expect(html.indexOf("Season 4")).toBeLessThan(html.indexOf("Specials"));
    // The pressed chip is the first real season, so nobody lands on 55 behind-the-scenes clips.
    expect(html).toContain('aria-pressed="true"');
    expect(html.slice(0, html.indexOf('aria-pressed="true"'))).not.toContain("Specials");
  });

  test("lists the chosen season's episodes with their real air dates, and only those", () => {
    const html = render(facets);
    expect(html).toContain("Winter Is Coming");
    // The machine-readable date, asserted rather than the printed one: the printed form
    // is the runner's own locale and is covered against a fixed locale in the lib tests.
    expect(html).toContain('dateTime="2011-04-17"');
    // Episode 1 before episode 2, whatever order the provider sent them in.
    expect(html.indexOf("Winter Is Coming")).toBeLessThan(html.indexOf("The Kingsroad"));
    // Another season's episodes are behind its own chip, not appended to this list.
    expect(html).not.toContain("The North Remembers");
    expect(html).not.toContain("Inside Game of Thrones");
    expect(html).not.toContain("animate-pulse");
  });

  /**
   * The season header has always been wired through `localImageUrl`, so it started
   * drawing art the moment the server began rewriting posters -- with no edit in `web/`.
   * This is the assertion that says so out loud.
   */
  test("a proxied season poster reaches the img tag", () => {
    const html = render({
      seasons: { status: "ready", data: [season({ number: 1, image: "/img/f/4b2d81" })] },
      episodes: { status: "ready", data: [episode({ season: 1, number: 1, title: "One" })] },
    });
    expect(html).toContain('<img src="/img/f/4b2d81"');
  });

  /** finderr is internet-facing; its providers are an implementation detail. */
  test("an upstream season poster never reaches an img tag", () => {
    const html = render({
      seasons: {
        status: "ready",
        data: [season({ number: 1, image: "https://artworks.thetvdb.com/x.jpg" })],
      },
      episodes: { status: "ready", data: [episode({ season: 1, number: 1, title: "One" })] },
    });
    expect(html).not.toContain("thetvdb.com");
    expect(html).not.toContain("<img");
  });
});

/**
 * "Get me the rest of this show" is the request people actually make, and this line is the
 * answer to it. The counting rules are tested against fixed dates in `../lib/season-gap.test.ts`;
 * these assertions are about whether the sentence reaches the page and where it lands.
 *
 * The air dates below are 2011's on purpose -- the pane asks the real clock what today is,
 * and a fixture dated in this decade would eventually start deciding its own outcome.
 */
describe("the season-gap line", () => {
  const facets: ResolvedFacets = {
    seasons: { status: "ready", data: GOT_SEASONS },
    episodes: { status: "ready", data: GOT_EPISODES },
  };

  /** Season 1 downloaded in full; season 2 has aired an episode we do not have. */
  const HELD: EpisodeState[] = [
    { season: 1, episode: 1, arrEpisodeId: 11, hasFile: true, monitored: true, airDate: "2011-04-17" },
    { season: 1, episode: 2, arrEpisodeId: 12, hasFile: true, monitored: true, airDate: "2011-04-24" },
    { season: 2, episode: 1, arrEpisodeId: 21, hasFile: false, monitored: true, airDate: "2012-04-01" },
  ];

  test("says what is complete and what is short, in one line", () => {
    expect(render(facets, ["seasons", "episodes"], HELD)).toContain(
      "Downloaded: Season 1 complete, Season 2 missing 1 episode",
    );
  });

  /** It is about the series, so it belongs above the chip that picks one season of it. */
  test("sits above the selector", () => {
    const html = render(facets, ["seasons", "episodes"], HELD);
    expect(html.indexOf("Downloaded:")).toBeLessThan(html.indexOf('role="group"'));
  });

  /** Most series on this page are ones nobody has asked for. They get no sentence at all. */
  test("is absent for a series Sonarr does not hold", () => {
    expect(render(facets)).not.toContain("Downloaded:");
  });

  /**
   * The summary needs the episode list to count. Drawing it off the seasons facet alone
   * would mean printing a sentence and then correcting it a moment later.
   */
  test("waits for the episodes facet rather than guessing from the seasons one", () => {
    const seasonsOnly: ResolvedFacets = { ...facets, episodes: { status: "pending" } };
    expect(render(seasonsOnly, ["episodes"], HELD)).not.toContain("Downloaded:");
  });
});

/**
 * A key drawn on a control must be live in that control's context -- the card's rule.
 * For the selector that means: several seasons, several chips, arrows. One season, no
 * arrows, because there is nowhere to step to.
 */
describe("the arrow keys on the selector", () => {
  const withSeasons = (data: Season[]) =>
    render({
      seasons: { status: "ready", data },
      episodes: { status: "ready", data: [episode({ season: 1, number: 1, title: "One" })] },
    });

  test("advertises both arrows on the group they drive, and draws both glyphs", () => {
    const html = withSeasons(GOT_SEASONS);
    expect(html).toContain('aria-keyshortcuts="ArrowLeft ArrowRight"');
    expect(html).toContain("←");
    expect(html).toContain("→");
    // The glyphs are decoration; the group is what a reader is told about.
    expect(html).toContain('aria-hidden="true"');
  });

  test("a one-season show gets neither the keys nor the glyphs", () => {
    const html = withSeasons([season({ number: 1 })]);
    expect(html).not.toContain("aria-keyshortcuts");
    expect(html).not.toContain("←");
    expect(html).not.toContain("→");
  });
});

describe("the two facets resolving apart", () => {
  const seasonsOnly: ResolvedFacets = {
    seasons: { status: "ready", data: GOT_SEASONS },
    episodes: { status: "pending" },
  };

  test("shows the selector it already has, with skeleton rows underneath", () => {
    const html = render(seasonsOnly);
    expect(html).toContain("Season 1 · Winter is Coming");
    expect(html).toContain("animate-pulse");
    // The pane's own aria-busy is false by now; the outstanding half says so itself.
    expect(html).toContain('<ol class="mt-3" aria-busy="true">');
  });

  test("keeps the selector when the episodes never arrive", () => {
    const html = render({ ...seasonsOnly, episodes: { status: "failed" } });
    expect(html).toContain("Season 1 · Winter is Coming");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("<ol");
  });
});
