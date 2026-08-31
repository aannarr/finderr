import { describe, expect, test } from "bun:test";
import {
  adjacentSeasonNumber,
  byBillingOrder,
  defaultSeasonNumber,
  entityKindOf,
  episodeLabel,
  episodeSkeletonRows,
  episodesForSeason,
  externalHref,
  formatCalendarDate,
  formatRatingValue,
  formatShelfDate,
  formatVotes,
  groupCrewByJob,
  hasPendingFacet,
  initialsOf,
  isCacheableFacetSet,
  languageNames,
  localImageUrl,
  localImdbRating,
  mergeRatings,
  orderSeasons,
  paneView,
  pickCertification,
  pickWatchProviders,
  preferredCountries,
  ratingLogo,
  releaseRows,
  STREAMING_MARKS,
  seasonAirRange,
  seasonLabel,
  shelfDateLabel,
  sourceName,
  streamingLogo,
  titleLinks,
  trailerLinks,
  watchServices,
} from "./facet-panes";
import type { CastMember, CrewMember, Episode, Rating, ResolvedFacets, Season, Trailer } from "./facets";

describe("paneView", () => {
  /** The facets the server says a provider still owes. `[]` means nobody owes anything. */
  const WORKING_ON_CAST = ["cast"] as const;
  const NOBODY_WORKING = [] as const;

  test("reserves space before the first response, whatever the work state", () => {
    // No response yet is NOT the same as "nobody is working": we do not know what this
    // title even has, so every pane holds its space rather than popping in a beat later.
    expect(paneView(undefined, "cast", undefined).state).toBe("skeleton");
    expect(paneView(undefined, "cast", NOBODY_WORKING).state).toBe("skeleton");
  });

  test("hides a facet the server did not declare for this entity kind", () => {
    // `seasons` is a series facet; on a film the key is simply absent.
    expect(paneView({} as ResolvedFacets, "seasons", NOBODY_WORKING).state).toBe("hidden");
  });

  test("renders content and hands back the typed data", () => {
    const facets: ResolvedFacets = { keywords: { status: "ready", data: [{ id: "1", name: "heist" }] } };
    const view = paneView(facets, "keywords", NOBODY_WORKING);
    expect(view.state).toBe("content");
    expect(view.data).toEqual([{ id: "1", name: "heist" }]);
  });

  /** A ready-but-empty list is nothing to show, and a heading over nothing is noise. */
  test("hides a ready facet whose data is an empty list", () => {
    expect(paneView({ cast: { status: "ready", data: [] } }, "cast", NOBODY_WORKING).state).toBe("hidden");
  });

  /**
   * The rule this replaced was a page-wide `settled` boolean flipped by a browser timer.
   * `pending` alone cannot decide it: a facet whose provider the server's outbound gate
   * REFUSED is `pending` with nobody working on it, and a timer either hides a facet that
   * was about to land or holds a skeleton over a provider that already died.
   */
  test("skeletons a pending facet only while a provider still owes it an answer", () => {
    const facets: ResolvedFacets = { cast: { status: "pending" } };
    expect(paneView(facets, "cast", WORKING_ON_CAST).state).toBe("skeleton");
    expect(paneView(facets, "cast", NOBODY_WORKING).state).toBe("hidden");
  });

  /** Each facet decides for itself: a fast synopsis paints while a slow cast waits. */
  test("one facet still working does not hold the space of another that has settled", () => {
    const facets: ResolvedFacets = { cast: { status: "pending" }, synopsis: { status: "pending" } };
    expect(paneView(facets, "cast", WORKING_ON_CAST).state).toBe("skeleton");
    expect(paneView(facets, "synopsis", WORKING_ON_CAST).state).toBe("hidden");
  });

  test("hides empty and failed alike -- a dead provider is not the user's problem", () => {
    expect(paneView({ cast: { status: "empty" } }, "cast", WORKING_ON_CAST).state).toBe("hidden");
    expect(paneView({ cast: { status: "failed" } }, "cast", WORKING_ON_CAST).state).toBe("hidden");
  });
});

describe("isCacheableFacetSet", () => {
  /**
   * The live bug this pins: the client cached on "nothing pending" alone, so ONE
   * transient provider failure was frozen for the whole session while the server retried
   * it after its own short TTL. Because `paneView` hides `failed` quietly, the symptom
   * was a title page with a header and no panes at all -- unrecoverable without a hard
   * reload, and indistinguishable from a title that genuinely has no metadata.
   */
  test("a failed facet is NOT final -- the server retries it, so the client must too", () => {
    expect(isCacheableFacetSet({ cast: { status: "ready", data: [] }, crew: { status: "failed" } })).toBe(
      false,
    );
  });

  test("pending is not final either", () => {
    expect(isCacheableFacetSet({ cast: { status: "pending" } })).toBe(false);
  });

  test("empty IS final -- the provider answered, and the answer was nothing", () => {
    expect(isCacheableFacetSet({ cast: { status: "empty" }, crew: { status: "ready", data: [] } })).toBe(
      true,
    );
  });

  test("an all-ready set, and an empty set, are both cacheable", () => {
    expect(isCacheableFacetSet({ cast: { status: "ready", data: [] } })).toBe(true);
    expect(isCacheableFacetSet({})).toBe(true);
  });

  test("differs from hasPendingFacet exactly on failure, which is the whole point", () => {
    const oneFailure: ResolvedFacets = { cast: { status: "failed" } };
    expect(hasPendingFacet(oneFailure)).toBe(false);
    expect(isCacheableFacetSet(oneFailure)).toBe(false);
  });
});

describe("hasPendingFacet", () => {
  test("is true only while something is genuinely outstanding", () => {
    expect(hasPendingFacet({ cast: { status: "ready", data: [] }, crew: { status: "pending" } })).toBe(true);
    expect(hasPendingFacet({ cast: { status: "empty" }, crew: { status: "failed" } })).toBe(false);
    expect(hasPendingFacet({})).toBe(false);
  });
});

describe("ratings", () => {
  const rt = (over: Partial<Rating> = {}): Rating => ({
    source: "Rotten Tomatoes",
    kind: "critics",
    value: 86,
    outOf: 100,
    ...over,
  });

  test("the local IMDb score joins the row, and disappears when there is none", () => {
    expect(localImdbRating(8.4, 2_400_000, "https://imdb/x")).toEqual({
      source: "IMDb",
      kind: "user",
      value: 8.4,
      outOf: 10,
      count: 2_400_000,
      url: "https://imdb/x",
    });
    expect(localImdbRating(0, 0, "https://imdb/x")).toBeNull();
  });

  test("merges every source into one row", () => {
    const merged = mergeRatings(localImdbRating(8.4, 100, "u"), [rt(), rt({ kind: "audience", value: 91 })]);
    expect(merged.map((r) => `${r.source}/${r.kind}`)).toEqual([
      "IMDb/user",
      "Rotten Tomatoes/critics",
      "Rotten Tomatoes/audience",
    ]);
  });

  /** Two plugins both carrying the IMDb score must not print it twice. */
  test("a provider's entry replaces the local seed in place", () => {
    const provided: Rating = { source: "imdb", kind: "user", value: 8.5, outOf: 10, count: 9, url: "p" };
    const merged = mergeRatings(localImdbRating(8.4, 100, "u"), [provided, rt()]);
    expect(merged).toHaveLength(2);
    // Position 0, not appended: a late contribution must not reshuffle the row.
    expect(merged[0]).toEqual(provided);
  });

  /**
   * The live defect this guards: `servarr-metadata` and `rotten-tomatoes` both send a
   * RottenTomatoes critics score and only RT's carries the link, so under a last-writer
   * rule the clickable tile was decided by which HTTP call came back first.
   */
  test("the richer of two contributions to the same tile wins, whichever arrived first", () => {
    const linked = rt({ url: "https://rottentomatoes.com/m/x" });
    const bare = rt({ value: 84 });
    for (const provided of [
      [linked, bare],
      [bare, linked],
    ]) {
      const merged = mergeRatings(null, provided);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toEqual(linked);
    }
  });

  test("a vote count breaks a tie between two contributions with no link", () => {
    const counted = rt({ count: 500 });
    expect(mergeRatings(null, [rt(), counted])[0]).toEqual(counted);
    expect(mergeRatings(null, [counted, rt()])[0]).toEqual(counted);
  });

  test("contributions that tie keep the first writer, so the row is stable not arbitrary", () => {
    const first = rt({ value: 86 });
    const second = rt({ value: 84 });
    expect(mergeRatings(null, [first, second])[0]).toEqual(first);
    expect(mergeRatings(null, [second, first])[0]).toEqual(second);
  });

  test("critics and audience from one source stay two tiles even when each is duplicated", () => {
    const merged = mergeRatings(null, [
      rt(),
      rt({ kind: "audience", value: 91 }),
      rt({ url: "https://rottentomatoes.com/m/x" }),
      rt({ kind: "audience", value: 91, url: "https://rottentomatoes.com/m/x" }),
    ]);
    expect(merged.map((r) => `${r.kind}:${r.url ?? ""}`)).toEqual([
      "critics:https://rottentomatoes.com/m/x",
      "audience:https://rottentomatoes.com/m/x",
    ]);
  });

  test("prints each scale the way its source does", () => {
    expect(formatRatingValue(rt())).toBe("86%");
    expect(formatRatingValue(rt({ source: "IMDb", kind: "user", value: 8.4, outOf: 10 }))).toBe("8.4");
    expect(formatRatingValue(rt({ source: "Letterboxd", value: 4.2, outOf: 5 }))).toBe("4.2/5");
  });

  test("vote counts print the way the title header has always printed them", () => {
    expect(formatVotes(999)).toBe("999");
    expect(formatVotes(2400)).toBe("2k");
    expect(formatVotes(743_210)).toBe("743k");
    // `2655k` before the millions tier existed -- four figures in a three-figure caption.
    expect(formatVotes(2_655_421)).toBe("2.7M");
    expect(formatVotes(1_000_000)).toBe("1.0M");
  });
});

describe("sourceName", () => {
  /**
   * The two the product actually ships. `synopsis.source` is the provider's own id --
   * `tmdb` on a film from `api.radarr.video`, `tvdb` on a series from skyhook -- and both
   * are honest attributions, so they are named rather than hidden.
   */
  test("names the providers whose words we print", () => {
    expect(sourceName("tmdb")).toBe("TMDB");
    expect(sourceName("tvdb")).toBe("TheTVDB");
  });

  /** One key per provider, however it spelled itself -- the `ratingLogo` fold, shared. */
  test("folds every spelling of one provider onto one name", () => {
    for (const spelling of ["RottenTomatoes", "Rotten Tomatoes", "rotten-tomatoes", "ROTTENTOMATOES"]) {
      expect(sourceName(spelling)).toBe("Rotten Tomatoes");
    }
    // `servarr-metadata` emits `Imdb` and the local seed emits `IMDb`; one tile, one name.
    expect(sourceName("Imdb")).toBe("IMDb");
    expect(sourceName("IMDb")).toBe("IMDb");
  });

  /**
   * Verbatim, never title-cased. A transform would print `Anidb` and `Mubi`, and inventing
   * somebody's capitalisation is worse than repeating what they called themselves.
   */
  test("returns an unmapped source exactly as it arrived", () => {
    expect(sourceName("MUBI")).toBe("MUBI");
    expect(sourceName("some-new-provider")).toBe("some-new-provider");
    expect(sourceName("")).toBe("");
  });

  /**
   * The two tables are keyed on the same fold, so a source cannot wear one provider's mark
   * under another's name. Asserted rather than trusted: they are separate literals.
   */
  test("agrees with ratingLogo on what counts as one source", () => {
    for (const spelling of ["RottenTomatoes", "Rotten Tomatoes", "rotten-tomatoes"]) {
      const r: Rating = { source: spelling, kind: "critics", value: 86, outOf: 100 };
      expect(ratingLogo(r)).toBe("/logos/rating/rt-crit-fresh.png");
      expect(sourceName(spelling)).toBe("Rotten Tomatoes");
    }
  });
});

/** One rule, two panes: the certificate and the streaming row ask the same question. */
describe("preferredCountries", () => {
  test("puts the viewer's own region first, then the fallbacks", () => {
    expect(preferredCountries(["de-DE", "en-GB"])).toEqual(["DE", "GB", "US"]);
    expect(preferredCountries([])).toEqual(["US", "GB"]);
  });

  /** A hand-edited or truncated locale is expected input, not an error case. */
  test("survives a junk locale and a locale with no region", () => {
    expect(preferredCountries(["not a locale", "en"])).toEqual(["US", "GB"]);
  });
});

/**
 * The locale is passed explicitly in every case here. `Intl` with no locale follows the
 * test RUNNER's, which makes an assertion on a formatted string machine-dependent -- the
 * same rule `formatCalendarDate`'s tests follow.
 */
describe("languageNames", () => {
  test("names a stored code in the reader's own language", () => {
    expect(languageNames([{ code: "hi" }], ["en"])).toEqual(["Hindi"]);
    expect(languageNames([{ code: "en" }], ["de"])).toEqual(["Englisch"]);
    expect(languageNames([{ code: "ja" }, { code: "ko" }], ["en"])).toEqual(["Japanese", "Korean"]);
  });

  /**
   * The reason the facet stores a code and never a name: one cached row serves every
   * reader, and the name is made where the reader is.
   */
  test("one code, two readers, two names", () => {
    const hindi = [{ code: "hi" }];
    expect(languageNames(hindi, ["en"])).not.toEqual(languageNames(hindi, ["fr"]));
  });

  test("drops a well-formed code that names no language, rather than printing it", () => {
    // `languageCode` cannot refuse these -- they are syntactically valid tags. This is the
    // only place the miss is detectable: `DisplayNames` hands the code straight back.
    expect(languageNames([{ code: "xx" }, { code: "qqq" }], ["en"])).toEqual([]);
    expect(languageNames([{ code: "" }, { code: "  " }], ["en"])).toEqual([]);
    expect(languageNames([], ["en"])).toEqual([]);
  });

  /**
   * The facet merges as a LIST, so two providers agreeing about a title contribute two
   * entries -- the same collision `mergeRatings` and `watchServices` guard against.
   * Deduped on the NAME, so two codes that render one word collapse to one word.
   */
  test("says each language once, however many providers said it", () => {
    expect(languageNames([{ code: "en" }, { code: "en" }], ["en"])).toEqual(["English"]);
    expect(languageNames([{ code: "zh" }, { code: "cmn" }], ["en"])).toEqual(["Chinese"]);
  });

  test("survives a junk locale from the browser", () => {
    expect(languageNames([{ code: "hi" }], ["not a locale"])).toEqual(["Hindi"]);
    expect(languageNames([{ code: "hi" }], [])).toEqual(["Hindi"]);
  });
});

describe("certification", () => {
  const certs = [
    { country: "DE", rating: "12" },
    { country: "US", rating: "PG-13" },
    { country: "GB", rating: "12A" },
  ];

  test("picks the most-preferred country that has a rating", () => {
    expect(pickCertification(certs, ["DE", "US"])).toEqual({ country: "DE", rating: "12" });
    expect(pickCertification(certs, ["FR", "GB"])).toEqual({ country: "GB", rating: "12A" });
  });

  test("falls back to any rated country rather than showing nothing", () => {
    expect(pickCertification(certs, ["FR"])).toEqual({ country: "DE", rating: "12" });
    expect(pickCertification([{ country: "US", rating: "  " }], ["US"])).toBeNull();
    expect(pickCertification([], ["US"])).toBeNull();
  });
});

describe("groupCrewByJob", () => {
  const crew = (job: string, name: string): CrewMember => ({
    name,
    job,
    department: null,
    personId: null,
    image: null,
  });

  test("collapses one job's people onto one line, leads first", () => {
    const { leads, rest } = groupCrewByJob([
      crew("Editor", "Lee"),
      crew("Writer", "Ann"),
      crew("Director", "Chris"),
      crew("Writer", "Bo"),
      crew("Composer", "Hans"),
    ]);
    expect(leads.map((g) => g.job)).toEqual(["Director", "Writer"]);
    expect(leads[1].members.map((m) => m.name)).toEqual(["Ann", "Bo"]);
    // Alphabetical, so the secondary block is stable however providers ordered it.
    expect(rest.map((g) => g.job)).toEqual(["Composer", "Editor"]);
  });

  test("groups case-insensitively and drops entries with no job", () => {
    const { leads } = groupCrewByJob([crew("director", "Chris"), crew("Director", "Bo"), crew(" ", "X")]);
    expect(leads).toHaveLength(1);
    expect(leads[0].members).toHaveLength(2);
  });
});

describe("release dates", () => {
  test("keeps only the windows we have, in order", () => {
    expect(releaseRows({ cinema: null, physical: "", digital: "2010-12-07" })).toEqual([
      { label: "Digital", date: "2010-12-07" },
    ]);
  });

  /** UTC, or everybody west of Greenwich sees a date-only release a day early. */
  test("formats a date-only string without sliding it a day", () => {
    expect(formatCalendarDate("2010-07-16", "en-GB")).toBe("16 Jul 2010");
  });

  test("shows an unparseable provider string as it came", () => {
    expect(formatCalendarDate("sometime in 2010")).toBe("sometime in 2010");
  });
});

describe("shelf dates", () => {
  /** The shape aannarr asked for: weekday, month, day. No year -- a shelf is weeks deep. */
  test("a shelf date carries the weekday and drops the year", () => {
    expect(formatShelfDate("2026-08-24", "en-US")).toBe("Mon, Aug 24");
  });

  test("UTC, so the weekday does not slide for readers west of Greenwich", () => {
    // Parsed as local time this is Sunday evening in the Americas, and would print "Sun".
    expect(formatShelfDate("2026-08-24", "en-US")).toContain("Mon");
  });

  test("today and tomorrow read as words, because that is what a glance wants", () => {
    expect(shelfDateLabel("2026-08-31", "2026-08-31", "en-US")).toBe("Tonight");
    expect(shelfDateLabel("2026-09-01", "2026-08-31", "en-US")).toBe("Tomorrow");
  });

  test("anything further out gets the absolute date", () => {
    expect(shelfDateLabel("2026-09-02", "2026-08-31", "en-US")).toBe("Wed, Sep 2");
  });

  /**
   * A past date is NOT softened into "Yesterday". On a shelf about what is coming, an
   * episode that already aired is the exception worth noticing, and a plain date looks
   * different enough to catch the eye.
   */
  test("a date already past prints plainly rather than as a word", () => {
    expect(shelfDateLabel("2026-08-29", "2026-08-31", "en-US")).toBe("Sat, Aug 29");
  });
});

describe("seasons", () => {
  const season = (over: Partial<Season> & { number: number }): Season => ({
    name: null,
    episodeCount: 10,
    premiereDate: null,
    endDate: null,
    image: null,
    ...over,
  });

  /** Skyhook hands back nine for Game of Thrones: eight named, plus the specials. */
  const GOT: Season[] = [
    season({ number: 0, episodeCount: 55 }),
    season({ number: 2, name: "Hear me Roar!" }),
    season({ number: 1, name: "Winter is Coming" }),
  ];

  test("orders ascending and puts the specials last, whatever the provider sent", () => {
    expect(orderSeasons(GOT).map((s) => s.number)).toEqual([1, 2, 0]);
    // The provider's array is not the pane's to reorder.
    expect(GOT[0].number).toBe(0);
  });

  test("lands the reader on the first real season, never on the specials", () => {
    expect(defaultSeasonNumber(GOT)).toBe(1);
    expect(defaultSeasonNumber([])).toBeNull();
  });

  /** A show with nothing but extras still has to open on something. */
  test("falls back to the specials when that is all there is", () => {
    expect(defaultSeasonNumber([season({ number: 0 })])).toBe(0);
  });

  describe("stepping with ← and →", () => {
    const ordered = orderSeasons(GOT); // [1, 2, 0]

    test("moves by ORDERED position, so the specials are reached from the last real season", () => {
      expect(adjacentSeasonNumber(ordered, 2, 1)).toBe(0);
      expect(adjacentSeasonNumber(ordered, 0, -1)).toBe(2);
    });

    test("clamps at both ends rather than wrapping around", () => {
      expect(adjacentSeasonNumber(ordered, 1, -1)).toBe(1);
      expect(adjacentSeasonNumber(ordered, 0, 1)).toBe(0);
    });

    test("has nowhere to go from a season that is not in the list", () => {
      expect(adjacentSeasonNumber(ordered, 7, 1)).toBeNull();
      expect(adjacentSeasonNumber(ordered, null, 1)).toBeNull();
      expect(adjacentSeasonNumber([], 1, 1)).toBeNull();
    });
  });

  test("names a season where the provider named it, and numbers it either way", () => {
    expect(seasonLabel(season({ number: 3, name: "Fire and Blood" }))).toBe("Season 3 · Fire and Blood");
    expect(seasonLabel(season({ number: 9 }))).toBe("Season 9");
    expect(seasonLabel(season({ number: 9, name: "  " }))).toBe("Season 9");
    expect(seasonLabel(season({ number: 0 }))).toBe("Specials");
  });

  test("prints the run as a range, one date, or nothing", () => {
    const dated = (premiereDate: string | null, endDate: string | null) =>
      seasonAirRange(season({ number: 1, premiereDate, endDate }), "en-GB");
    expect(dated("2011-04-17", "2011-06-19")).toBe("17 Apr 2011 – 19 Jun 2011");
    // A one-episode season is a date, not a range from a day to itself.
    expect(dated("2011-04-17", "2011-04-17")).toBe("17 Apr 2011");
    expect(dated("2011-04-17", null)).toBe("17 Apr 2011");
    expect(dated(null, null)).toBeNull();
  });

  test("reserves rows for the season we hold, capped so a 55-episode one is not four screens", () => {
    expect(episodeSkeletonRows(season({ number: 1, episodeCount: 10 }))).toBe(10);
    expect(episodeSkeletonRows(season({ number: 0, episodeCount: 55 }))).toBe(12);
    expect(episodeSkeletonRows(season({ number: 1, episodeCount: 0 }))).toBe(1);
    // Nothing known yet -- the seasons facet has not landed either.
    expect(episodeSkeletonRows(null)).toBe(6);
  });
});

describe("episodes", () => {
  const episode = (over: Partial<Episode> & { season: number; number: number }): Episode => ({
    title: null,
    airDate: null,
    overview: null,
    image: null,
    runtime: null,
    ...over,
  });

  test("takes one season's episodes in broadcast order, leaving the rest alone", () => {
    const all = [
      episode({ season: 1, number: 2 }),
      episode({ season: 2, number: 1 }),
      episode({ season: 1, number: 1 }),
    ];
    expect(episodesForSeason(all, 1).map((e) => e.number)).toEqual([1, 2]);
    expect(episodesForSeason(all, 3)).toEqual([]);
    expect(all[0].number).toBe(2);
  });

  test("an untitled episode still gets a row, because the air date is the point", () => {
    expect(episodeLabel(episode({ season: 1, number: 4, title: "Cripples" }))).toBe("Cripples");
    expect(episodeLabel(episode({ season: 1, number: 4, title: "  " }))).toBe("Episode 4");
    expect(episodeLabel(episode({ season: 1, number: 4 }))).toBe("Episode 4");
  });
});

describe("person images", () => {
  /** finderr is internet-facing; its providers are an implementation detail. */
  test("only a same-origin path is allowed into an img tag", () => {
    expect(localImageUrl("/img/p/nm123")).toBe("/img/p/nm123");
    expect(localImageUrl("https://image.tmdb.org/x.jpg")).toBeNull();
    expect(localImageUrl("//image.tmdb.org/x.jpg")).toBeNull();
    expect(localImageUrl(null)).toBeNull();
  });

  test("initials stand in for a missing headshot", () => {
    expect(initialsOf("Leonardo DiCaprio")).toBe("LD");
    expect(initialsOf("Cher")).toBe("C");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("trailerLinks", () => {
  function trailer(over: Partial<Trailer> = {}): Trailer {
    return { site: "youtube", key: "cdx31ak4KbQ", name: null, kind: "Trailer", ...over };
  }

  test("builds a watch URL from the site and key the facet carries", () => {
    expect(trailerLinks([trailer()])).toEqual([
      { url: "https://www.youtube.com/watch?v=cdx31ak4KbQ", label: "Trailer" },
    ]);
  });

  test("a site we have no address for yields no link, rather than a guessed one", () => {
    expect(trailerLinks([trailer({ site: "vimeo", key: "12345" })])).toEqual([]);
    expect(trailerLinks([trailer({ key: "  " })])).toEqual([]);
  });

  /** `trailer` merges as a list, so two plugins can contribute the same video. */
  test("the same video contributed twice is one link, and the first one wins", () => {
    const links = trailerLinks([trailer({ name: "Official Trailer" }), trailer({ name: "Trailer 1" })]);
    expect(links).toHaveLength(1);
    expect(links[0].label).toBe("Official Trailer");
  });

  test("labels fall back from the provider's name to its kind", () => {
    expect(trailerLinks([trailer({ name: "Teaser" })])[0].label).toBe("Teaser");
    expect(trailerLinks([trailer({ kind: "Teaser" })])[0].label).toBe("Teaser");
    expect(trailerLinks([trailer({ kind: null })])[0].label).toBe("Trailer");
  });

  test("a key is escaped, because a provider's id is not ours to trust in a URL", () => {
    expect(trailerLinks([trailer({ key: "a&b=c" })])[0].url).toBe(
      "https://www.youtube.com/watch?v=a%26b%3Dc",
    );
  });
});

describe("byBillingOrder", () => {
  test("sorts by billing order without mutating the provider's array", () => {
    const cast: CastMember[] = [
      { name: "Second", character: null, order: 2, personId: null, image: null },
      { name: "First", character: null, order: 1, personId: null, image: null },
    ];
    expect(byBillingOrder(cast).map((c) => c.name)).toEqual(["First", "Second"]);
    expect(cast[0].name).toBe("Second");
  });
});

describe("ratingLogo", () => {
  const rating = (over: Partial<Rating>): Rating => ({
    source: "IMDb",
    kind: "user",
    value: 9,
    outOf: 10,
    ...over,
  });

  test("matches on a lowercased source, because providers disagree on spelling", () => {
    // servarr-metadata emits `Imdb`, the local seed emits `IMDb`. They are one source
    // and `mergeRatings` already treats them as one; the mark has to agree.
    for (const source of ["IMDb", "Imdb", "imdb", "  IMDB  "]) {
      expect(ratingLogo(rating({ source }))).toBe("/logos/rating/imdb.png");
    }
  });

  test("both spellings of Rotten Tomatoes resolve -- and both are live in this repo", () => {
    // The providers emit `RottenTomatoes`; the pane tests above were written with
    // `Rotten Tomatoes`. Matching on alphanumerics only means neither is a special case.
    for (const source of ["RottenTomatoes", "Rotten Tomatoes", "rotten-tomatoes"]) {
      expect(ratingLogo(rating({ source, kind: "critics", value: 94, outOf: 100 }))).toBe(
        "/logos/rating/rt-crit-fresh.png",
      );
    }
  });

  test("the tomato IS the score -- fresh above 60%, rotten below", () => {
    const rt = (kind: Rating["kind"], value: number) =>
      ratingLogo(rating({ source: "RottenTomatoes", kind, value, outOf: 100 }));

    expect(rt("critics", 94)).toBe("/logos/rating/rt-crit-fresh.png");
    expect(rt("critics", 34)).toBe("/logos/rating/rt-crit-rotten.png");
    expect(rt("audience", 86)).toBe("/logos/rating/rt-aud-fresh.png");
    expect(rt("audience", 40)).toBe("/logos/rating/rt-aud-rotten.png");
    // 60 exactly is fresh -- RT's rule, not ours.
    expect(rt("critics", 60)).toBe("/logos/rating/rt-crit-fresh.png");
    expect(rt("critics", 59)).toBe("/logos/rating/rt-crit-rotten.png");
  });

  test("critics and audience get DIFFERENT art -- this is the whole point", () => {
    const crit = ratingLogo(rating({ source: "RottenTomatoes", kind: "critics", value: 94, outOf: 100 }));
    const aud = ratingLogo(rating({ source: "RottenTomatoes", kind: "audience", value: 86, outOf: 100 }));
    expect(crit).not.toBe(aud);
  });

  test("an RT score that is not a percentage gets no mark rather than a guessed one", () => {
    // Comparing a /10 value against 60 would read rotten for everything.
    expect(
      ratingLogo(rating({ source: "RottenTomatoes", kind: "critics", value: 9.4, outOf: 10 })),
    ).toBeNull();
  });

  test("an unmapped source is null, not an error -- the tile falls back to text", () => {
    expect(ratingLogo(rating({ source: "Letterboxd-ish" }))).toBeNull();
    expect(ratingLogo(rating({ source: "" }))).toBeNull();
  });
});

describe("ratingLogo is bound to the imported logo set", () => {
  /**
   * Guards the one failure this design can have: the client names a file directly rather
   * than checking a manifest, so an upstream rename would 404 silently in the browser.
   * Asserting against the manifest the importer actually wrote turns that into a red test.
   */
  test("every mark the mapper can emit exists in src/logos.json", async () => {
    const manifest = (await Bun.file(`${import.meta.dir}/../../../src/logos.json`).json()) as {
      sets: { rating: string[] };
    };
    const have = new Set(manifest.sets.rating);

    const emitted = new Set<string>();
    const push = (r: Rating) => {
      const p = ratingLogo(r);
      if (p) emitted.add(p.replace("/logos/rating/", "").replace(".png", ""));
    };
    for (const source of ["IMDb", "Tmdb", "Metacritic", "Trakt", "Letterboxd", "AniDB"]) {
      push({ source, kind: "user", value: 8, outOf: 10 });
    }
    for (const kind of ["critics", "audience"] as const) {
      for (const value of [94, 34]) {
        push({ source: "RottenTomatoes", kind, value, outOf: 100 });
      }
    }

    expect(emitted.size).toBe(10);
    expect([...emitted].filter((s) => !have.has(s))).toEqual([]);
  });
});

describe("where to watch", () => {
  const country = (code: string, flatrate: string[] = [], rent: string[] = [], buy: string[] = []) => ({
    country: code,
    flatrate,
    rent,
    buy,
    link: `https://www.themoviedb.org/movie/27205/watch?locale=${code}`,
  });

  const entries = [
    country("DE", ["Netflix"]),
    country("GB", ["Now TV Cinema"], ["Apple TV Store"], ["Amazon Video"]),
    country("TH", [], ["Google Play Movies"]),
  ];

  test("shows the reader's own country, not the first one we happen to hold", () => {
    expect(pickWatchProviders(entries, ["TH", "US", "GB"])?.country).toBe("TH");
    expect(pickWatchProviders(entries, ["de", "GB"])?.country).toBe("DE");
  });

  /**
   * Unlike `pickCertification` there is no "any country will do" fallback: a German
   * subscription is not an answer to "where can I watch this" asked from Bangkok.
   */
  test("shows nothing rather than another country's offers", () => {
    expect(pickWatchProviders(entries, ["FR", "JP"])).toBeNull();
    expect(pickWatchProviders([], ["US"])).toBeNull();
  });

  /**
   * "Where to watch" answers whether a reader can watch this NOW. Every digital storefront
   * on earth will sell them a copy, so a rent/buy row is a row of non-answers -- the facet
   * still carries both, because it caches one upstream document faithfully.
   */
  test("streaming only -- rent and buy are carried but never drawn", () => {
    expect(watchServices(country("GB", ["Sky Go"], ["Apple TV Store"], ["Amazon Video"]))).toEqual([
      { name: "Sky Go", logo: null },
    ]);
    expect(watchServices(country("TH", [], ["Google Play Movies"], ["Amazon Video"]))).toEqual([]);
    expect(watchServices(country("FR"))).toEqual([]);
  });

  /**
   * The bug this replaced, screenshotted 2026-08-31: two identical Netflix tiles
   * side by side, because TMDB sells one service under several product names and the
   * dedupe keyed on the NAME. Nothing on screen told the two apart -- they wear one mark.
   */
  test("one service under several product names draws ONE tile", () => {
    expect(
      watchServices(country("US", ["Netflix", "Netflix Standard with Ads", "Netflix basic with Ads"])),
    ).toEqual([{ name: "Netflix", logo: "/logos/streaming/netflix.png" }]);
  });

  /**
   * The duplicate caught on Game of Thrones after the Netflix one was fixed. TMDB
   * lists a reseller as its own provider, so the row drew the HBO mark beside a tile
   * printing "HBO Max Amazon Channel" -- one service, two tiles, and the pane is asking
   * WHICH SERVICE rather than through whose billing.
   */
  test("a service resold through a storefront is the same service", () => {
    expect(watchServices(country("US", ["HBO Max Amazon Channel", "HBO Max"]))).toEqual([
      { name: "HBO Max", logo: "/logos/streaming/hbo-max.png" },
    ]);
  });

  /** Ranked on content, never on position -- the DIRECT name wins either way round. */
  test("the direct name beats the reseller's whichever order TMDB sent them", () => {
    const forwards = watchServices(country("US", ["HBO Max", "HBO Max Amazon Channel"]));
    const backwards = watchServices(country("US", ["HBO Max Amazon Channel", "HBO Max"]));
    expect(forwards).toEqual(backwards);
    expect(forwards[0]?.name).toBe("HBO Max");
  });

  /** Alone, it is still the only answer there is, so it keeps its own name. */
  test("a reseller with no direct listing keeps its name", () => {
    expect(watchServices(country("US", ["MGM+ Amazon Channel"]))).toEqual([
      { name: "MGM+ Amazon Channel", logo: null },
    ]);
  });

  /**
   * A closed list, not a blanket `/channel$/`: a service genuinely named for a channel is
   * indistinguishable from a reseller by the string alone.
   */
  test("only the known storefront suffixes fold away", () => {
    expect(watchServices(country("US", ["Comedy Central", "Comedy Central Amazon Channel"]))).toEqual([
      { name: "Comedy Central", logo: null },
    ]);
    expect(watchServices(country("US", ["Discovery Channel", "Crunchyroll"])).length).toBe(2);
  });

  /** No mark to key on, so the folded name is the key -- and it still collapses spellings. */
  test("an unmarked service dedupes on its folded name", () => {
    expect(watchServices(country("US", ["Spectrum On Demand", "spectrum on demand"]))).toEqual([
      { name: "Spectrum On Demand", logo: null },
    ]);
  });

  /** Two subscriptions, two marks, two tiles -- the collision `+` is spelt out to avoid. */
  test("Disney and Disney+ stay two tiles", () => {
    expect(watchServices(country("US", ["Disney", "Disney+"]))).toEqual([
      { name: "Disney", logo: "/logos/streaming/disney.png" },
      { name: "Disney+", logo: "/logos/streaming/disney-plus.png" },
    ]);
  });

  /** TMDB sends `display_priority` order; a duplicate must never reshuffle the row. */
  test("the first spelling wins the label", () => {
    expect(watchServices(country("US", ["Netflix Standard with Ads", "Netflix"]))[0]?.name).toBe(
      "Netflix Standard with Ads",
    );
  });

  test("one service spelt several ways wears one mark", () => {
    // Every one of these is a real TMDB `provider_name`.
    for (const name of ["Disney Plus", "Disney+", "disney plus"]) {
      expect(streamingLogo(name)).toBe("/logos/streaming/disney-plus.png");
    }
    expect(streamingLogo("Paramount Plus Premium")).toBe(streamingLogo("Paramount+"));
    expect(streamingLogo("Netflix Standard with Ads")).toBe("/logos/streaming/netflix.png");
  });

  /** Stripping `+` instead of spelling it out would merge two different services. */
  test("Disney and Disney+ keep their own marks", () => {
    expect(streamingLogo("Disney")).toBe("/logos/streaming/disney.png");
    expect(streamingLogo("AMC+")).toBe("/logos/streaming/amc-plus.png");
    expect(streamingLogo("Apple TV")).not.toBe(streamingLogo("Apple TV+"));
  });

  test("a service we have no mark for is null, not an error -- the tile falls back to text", () => {
    // Kometa publishes 26 marks against TMDB's ~300 services, so this is the common case.
    expect(streamingLogo("Spectrum On Demand")).toBeNull();
    expect(streamingLogo("")).toBeNull();
  });
});

describe("streamingLogo is bound to the imported logo set", () => {
  /** The same guard `ratingLogo` gets, read off the table rather than re-typed. */
  test("every mark the table names exists in src/logos.json", async () => {
    const manifest = (await Bun.file(`${import.meta.dir}/../../../src/logos.json`).json()) as {
      sets: { streaming: string[] };
    };
    const have = new Set(manifest.sets.streaming);

    expect([...new Set(Object.values(STREAMING_MARKS))].filter((s) => !have.has(s))).toEqual([]);
  });
});

describe("externalHref", () => {
  test("passes a plain http(s) address through, normalised", () => {
    expect(externalHref("https://www.imdb.com/title/tt1375666/")).toBe(
      "https://www.imdb.com/title/tt1375666/",
    );
    expect(externalHref("  http://example.com/x  ")).toBe("http://example.com/x");
  });

  /**
   * The reason this exists. `links` and `Rating.url` are both plugin-fed and both go
   * straight into an `href`, and a provider does not have to be hostile to send junk.
   */
  test("refuses any scheme that is not http or https", () => {
    expect(externalHref("javascript:alert(1)")).toBeNull();
    expect(externalHref("data:text/html,<script>")).toBeNull();
    expect(externalHref("vbscript:x")).toBeNull();
  });

  /** The opposite of `localImageUrl`: an image must be ours, a link out must not be relative. */
  test("refuses a relative path, and anything that is not a URL at all", () => {
    expect(externalHref("/title/tt1375666")).toBeNull();
    expect(externalHref("//evil.example.com/x")).toBeNull();
    expect(externalHref("")).toBeNull();
    expect(externalHref(null)).toBeNull();
    expect(externalHref(undefined)).toBeNull();
  });
});

describe("entityKindOf", () => {
  /**
   * Read off `service`, which is `entityKindFor`'s answer already computed on the server --
   * `Title.kind` is IMDb's raw `titleType` and collapsing it a second time here would be a
   * second owner of that rule.
   */
  test("reads the kind the server already decided", () => {
    expect(entityKindOf({ service: "sonarr" })).toBe("series");
    expect(entityKindOf({ service: "radarr" })).toBe("movie");
  });
});

describe("titleLinks", () => {
  const FILM = "tt1375666";

  test("three addresses come free, from the tconst alone", () => {
    expect(titleLinks(FILM, "movie", undefined, undefined)).toEqual([
      { url: "https://www.imdb.com/title/tt1375666/", label: "IMDb" },
      { url: "https://trakt.tv/search/imdb/tt1375666", label: "Trakt" },
      { url: "https://letterboxd.com/imdb/tt1375666/", label: "Letterboxd" },
    ]);
  });

  /**
   * Letterboxd catalogues films only, and its `/imdb/` redirect answers 200 with a
   * not-found page for a series rather than refusing -- so a series link would look live
   * and be a dead end.
   */
  test("a series gets no Letterboxd link, and TMDB's /tv/ path rather than /movie/", () => {
    const labels = titleLinks("tt0944947", "series", { tmdb: 1399 }, undefined).map((l) => l.label);
    expect(labels).not.toContain("Letterboxd");
    expect(titleLinks("tt0944947", "series", { tmdb: 1399 }, undefined)).toContainEqual({
      url: "https://www.themoviedb.org/tv/1399",
      label: "TMDB",
    });
  });

  test("every id space we can reach becomes a named link", () => {
    const links = titleLinks("tt0944947", "series", { tvdb: 121361, tvmaze: 82, tmdb: 1399 }, undefined);
    expect(links).toContainEqual({ url: "https://thetvdb.com/dereferrer/series/121361", label: "TheTVDB" });
    expect(links).toContainEqual({ url: "https://www.tvmaze.com/shows/82", label: "TVmaze" });
  });

  /**
   * TVRage shut down in 2018 and the domain now serves a scraped SEO clone, but the id is
   * still in every skyhook payload. An id space we hold and deliberately do not link is
   * the whole point of the table being a whitelist.
   */
  test("an id space with no entry in the table yields no link, rather than a guessed one", () => {
    const labels = titleLinks("tt0944947", "series", { tvrage: 24493, nonsense: 7 }, undefined).map(
      (l) => l.label,
    );
    expect(labels).not.toContain("tvrage");
    expect(labels).not.toContain("nonsense");
  });

  /**
   * The anime spaces arrive comma-joined -- a TVDB series can map to several AniDB entries.
   * Three chips all reading "AniDB" is a row the reader cannot choose from, and picking one
   * would be a guess, so a multi-valued space contributes nothing.
   */
  test("a multi-valued id space contributes nothing, and a single-valued one links", () => {
    expect(titleLinks("tt1", "series", { anidb: "1,2,3" }, undefined).map((l) => l.label)).not.toContain(
      "AniDB",
    );
    expect(titleLinks("tt1", "series", { anidb: "4563" }, undefined)).toContainEqual({
      url: "https://anidb.net/anime/4563",
      label: "AniDB",
    });
  });

  /** Escaping a junk id would dutifully build a link to a page that cannot exist. */
  test("an id that is not a bare identifier is refused rather than escaped", () => {
    const labels = titleLinks("tt1", "movie", { tmdb: "../../etc/passwd" }, undefined).map((l) => l.label);
    expect(labels).not.toContain("TMDB");
  });

  test("a contributed link lands after the derived ones and keeps the row stable", () => {
    const links = titleLinks(FILM, "movie", undefined, [
      { kind: "homepage", url: "https://www.warnerbros.com/movies/inception" },
    ]);
    expect(links[0].label).toBe("IMDb");
    expect(links[links.length - 1]).toEqual({
      url: "https://www.warnerbros.com/movies/inception",
      label: "Official site",
    });
  });

  test("a provider's own name for a link wins over the kind's", () => {
    const links = titleLinks(FILM, "movie", undefined, [
      { kind: "homepage", url: "https://example.com/x", name: "Warner Bros." },
    ]);
    expect(links[links.length - 1].label).toBe("Warner Bros.");
  });

  /** Contributing an address we already build must not print the chip twice. */
  test("a contributed duplicate of a derived link is dropped", () => {
    const links = titleLinks(FILM, "movie", { imdb: FILM }, [
      { kind: "imdb", url: "https://www.imdb.com/title/tt1375666/" },
    ]);
    expect(links.filter((l) => l.url.includes("imdb.com"))).toHaveLength(1);
  });

  test("a contributed link that is not http(s) never reaches the row", () => {
    const links = titleLinks(FILM, "movie", undefined, [{ kind: "homepage", url: "javascript:alert(1)" }]);
    expect(links.map((l) => l.url)).not.toContain("javascript:alert(1)");
  });
});
