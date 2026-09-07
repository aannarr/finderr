import { describe, expect, test } from "bun:test";
import type { PersonLinks } from "../../../src/lib/people";
import {
  adjacentSeasonNumber,
  byBillingOrder,
  cardSubtitle,
  defaultSeasonNumber,
  entityKindOf,
  episodeLabel,
  episodeSkeletonRows,
  episodeStateIndex,
  episodesForSeason,
  externalHref,
  foreignLanguage,
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
  nconstForCredit,
  orderSeasons,
  paneView,
  personNameKey,
  pickCertification,
  preferredCountries,
  problemNote,
  ratingLogo,
  releaseRows,
  seasonAirRange,
  seasonLabel,
  shelfDateLabel,
  sourceName,
  TRAILER_MARKS,
  titleLinks,
  trailerLinks,
  trailerLogo,
} from "./facet-panes";
import type {
  CastMember,
  CrewMember,
  Episode,
  FacetProblem,
  FailureReason,
  PersonCredit,
  Rating,
  ResolvedFacets,
  Season,
  Trailer,
} from "./facets";

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
    expect(view).toEqual({ state: "content", data: [{ id: "1", name: "heist" }] });
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

  test("hides an empty facet -- the provider answered, and the answer was nothing", () => {
    expect(paneView({ cast: { status: "empty" } }, "cast", WORKING_ON_CAST).state).toBe("hidden");
  });

  test("hides a failure nobody claims, rather than blaming an unnamed addon", () => {
    // `workState` reports problems from CURRENT rows only, so a failure recorded under a
    // superseded plugin config reaches the client as `failed` with no owner. There is
    // nobody to name, and the provider's replacement is already in flight.
    expect(paneView({ cast: { status: "failed" } }, "cast", WORKING_ON_CAST).state).toBe("hidden");
    expect(paneView({ cast: { status: "failed" } }, "cast", NOBODY_WORKING, []).state).toBe("hidden");
  });
});

/**
 * The gap this closed: `failed` used to go down the `hidden` path with `empty`, so a title
 * whose cast provider timed out rendered IDENTICALLY to a title that genuinely has no cast.
 * The data telling those apart was already on the wire and nothing read it.
 */
describe("paneView on a failure somebody owns", () => {
  const TIMED_OUT: FacetProblem[] = [{ pluginId: "servarr-metadata", facet: "cast", reason: "timeout" }];

  test("says so, and hands the pane who to name", () => {
    const view = paneView({ cast: { status: "failed" } }, "cast", [], TIMED_OUT);
    expect(view).toEqual({ state: "problem", problems: TIMED_OUT });
  });

  test("a problem on ANOTHER facet does not make this one speak", () => {
    // One list for the whole title, filtered here rather than by every caller.
    expect(paneView({ crew: { status: "failed" } }, "crew", [], TIMED_OUT).state).toBe("hidden");
  });

  test("a facet another provider answered stays silent -- the reader has the cast", () => {
    // Two plugins provide `cast`; one failed and one did not, so the facet is `ready` and
    // the failure is an operational fact rather than a gap on the page.
    const member: CastMember = { name: "Ada", personId: null, image: null, character: null, order: 0 };
    const facets: ResolvedFacets = { cast: { status: "ready", data: [member] } };
    expect(paneView(facets, "cast", [], TIMED_OUT).state).toBe("content");
  });

  test("a pending facet is still a skeleton, whatever else already failed", () => {
    // One provider of two died and the other is still going: the answer may yet arrive,
    // and saying "unavailable" over work in progress would be the older bug's mirror image.
    expect(paneView({ cast: { status: "pending" } }, "cast", ["cast"], TIMED_OUT).state).toBe("skeleton");
  });
});

/**
 * The line a failed pane says, and the only place an addon's own words could reach a page.
 *
 * The reason is a CODE rather than a message precisely so this is safe (`FAILURE_REASONS`
 * in `src/lib/facets.ts`): an upstream URL can carry a credential in its query string, and
 * a plugin's exception text can quote one. Both guards below are what keep that true when
 * the wire carries something the vocabulary does not.
 */
describe("problemNote", () => {
  test("names the addon and the reason, and nothing else", () => {
    expect(problemNote([{ pluginId: "servarr-metadata", facet: "cast", reason: "timeout" }])).toBe(
      "Unavailable: servarr-metadata timed out",
    );
  });

  test.each([
    ["error", "Unavailable: tmdb failed"],
    ["invalid-shape", "Unavailable: tmdb sent something we could not read"],
  ])("%s reads as English rather than as a code", (reason, expected) => {
    expect(problemNote([{ pluginId: "tmdb", facet: "cast", reason: reason as FailureReason }])).toBe(
      expected,
    );
  });

  test("two plugins failing one facet is two clauses, and a repeat is one", () => {
    const problems: FacetProblem[] = [
      { pluginId: "servarr-metadata", facet: "cast", reason: "timeout" },
      { pluginId: "tmdb", facet: "cast", reason: "error" },
      { pluginId: "tmdb", facet: "cast", reason: "error" },
    ];
    expect(problemNote(problems)).toBe("Unavailable: servarr-metadata timed out, tmdb failed");
  });

  test("a reason outside the vocabulary is generalised, never printed", () => {
    const leak = "GET https://api.example.com/v3/movie?api_key=SECRET failed" as FailureReason;
    const note = problemNote([{ pluginId: "tmdb", facet: "cast", reason: leak }]);
    expect(note).toBe("Unavailable: tmdb failed");
    expect(note).not.toContain("api_key");
    expect(note).not.toContain("https://");
  });

  test("a plugin id that is not one is mentioned anonymously", () => {
    // The loader enforces this shape on every manifest, so a real id always passes. It is
    // guarded again here because this is the one line on the page an addon supplies text to.
    const note = problemNote([
      { pluginId: "https://api.example.com/?api_key=SECRET", facet: "cast", reason: "timeout" },
    ]);
    expect(note).toBe("Unavailable: an addon timed out");
    expect(note).not.toContain("api_key");
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

describe("foreignLanguage", () => {
  test("names a language the reader does not read", () => {
    expect(foreignLanguage("ko", ["en-US"])).toBe("Korean");
    expect(foreignLanguage("es", ["en-GB"])).toBe("Spanish");
    // Named in the READER's language, off the same stored code -- the whole reason the
    // column holds `sv` and not "Swedish".
    expect(foreignLanguage("sv", ["de"])).toBe("Schwedisch");
  });

  test("says nothing about a title the reader can already watch", () => {
    expect(foreignLanguage("en", ["en-US"])).toBeNull();
    // The region is not part of the question: `en-GB` reads an American film.
    expect(foreignLanguage("en", ["en-GB", "sv"])).toBeNull();
    expect(foreignLanguage("sv", ["en-US", "sv-SE"])).toBeNull();
  });

  /**
   * The rule the codes' shape forces, and the one worth stating twice.
   *
   * P364 is an unordered SET -- nothing says which of `en,hi,pa` is the main language --
   * so "the primary language is not yours" is unanswerable and ANY overlap has to silence
   * the label. A wrong label on something a reader can watch is worse than a missing one.
   */
  test("ANY overlap silences it, on a multi-language title", () => {
    expect(foreignLanguage("en,hi,pa", ["en-US"])).toBeNull();
    expect(foreignLanguage("hi,pa", ["en-US"])).toBe("Hindi, Punjabi");
  });

  test("nothing to say is the common answer, and never an empty string", () => {
    // Every one of these is a real row: no column on an older index, no language known,
    // and the empty-ish shapes a comma-joined column can take.
    expect(foreignLanguage(null, ["en"])).toBeNull();
    expect(foreignLanguage(undefined, ["en"])).toBeNull();
    expect(foreignLanguage("", ["en"])).toBeNull();
    expect(foreignLanguage(" , ,", ["en"])).toBeNull();
    // A well-formed tag naming no language is dropped by `languageNames`, and dropping
    // every code must leave nothing rather than an empty label.
    expect(foreignLanguage("xx", ["en"])).toBeNull();
  });

  test("survives a junk locale from the browser", () => {
    expect(foreignLanguage("ko", ["not a locale"])).toBe("Korean");
    expect(foreignLanguage("ko", [])).toBe("Korean");
  });

  /**
   * aannarr, 2026-09-07: *"no need to show 'English' for english titles"*. Not a property
   * of the reader's browser -- a property of what this library is mostly in.
   */
  test("English is never labelled, whatever the browser reports", () => {
    expect(foreignLanguage("en", ["ko"])).toBeNull();
    expect(foreignLanguage("en", [])).toBeNull();
    expect(foreignLanguage("en,fr", ["ko"])).toBeNull();
    // And it silences only ITSELF: a Korean reader still learns a film is in French.
    expect(foreignLanguage("fr", ["ko"])).toBe("프랑스어");
  });

  test("takes the codes as the index writes them: lower case, comma-joined, sorted", () => {
    expect(foreignLanguage("es,fr", ["en"])).toBe("Spanish, French");
    // Whitespace and case are not in the column today, and a guard here costs nothing.
    expect(foreignLanguage(" ES , fr ", ["en"])).toBe("Spanish, French");
  });
});

describe("cardSubtitle", () => {
  test("both halves, either half, or no line at all", () => {
    expect(cardSubtitle("Collision", "Colisión", "Spanish")).toEqual({
      original: "Colisión",
      language: "Spanish",
    });
    expect(cardSubtitle("Inception", null, null)).toEqual({ original: null, language: null });
    expect(cardSubtitle("Inception", "Inception", null)).toEqual({ original: null, language: null });
  });

  /**
   * The bug this function was extracted to make impossible.
   *
   * `La Cible` is a French mini-series whose original title IS its title, so a language
   * nested inside the original-title check never draws -- and that shape is common rather
   * than a corner. Both halves are decided independently, every time.
   */
  test("a language draws even when the title has no other name", () => {
    expect(cardSubtitle("La Cible", "La Cible", "French")).toEqual({
      original: null,
      language: "French",
    });
    expect(cardSubtitle("SWAT Exiles", null, "French")).toEqual({
      original: null,
      language: "French",
    });
  });

  test("an original title draws with no language, which is what every English row does", () => {
    expect(cardSubtitle("The Seventh Seal", "Det sjunde inseglet", null)).toEqual({
      original: "Det sjunde inseglet",
      language: null,
    });
    expect(cardSubtitle("X", undefined, null)).toEqual({ original: null, language: null });
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
      {
        url: "https://www.youtube.com/watch?v=cdx31ak4KbQ",
        label: "Trailer",
        logo: "/logos/streaming/youtube.png",
      },
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

  test("carries the host's mark, so the tile is not two links both reading Trailer", () => {
    expect(trailerLinks([trailer({ site: "YouTube" })])[0].logo).toBe("/logos/streaming/youtube.png");
  });
});

describe("trailerLogo", () => {
  test("folds the site the provider sent, however it spelled it", () => {
    for (const site of ["youtube", "YouTube", "  YOUTUBE "]) {
      expect(trailerLogo(site)).toBe("/logos/streaming/youtube.png");
    }
  });

  /**
   * The same rule `ratingLogo` and `streamingLogo` follow: no art means the label stays
   * visible, never a guessed path that 404s behind an empty tile.
   */
  test("a host we have no mark for is null, not a guess", () => {
    expect(trailerLogo("vimeo")).toBeNull();
    expect(trailerLogo("")).toBeNull();
  });
});

describe("trailerLogo is bound to the imported logo set", () => {
  /**
   * The same guard the other two mark tables get. It reads the STREAMING set deliberately:
   * `bun run logos:import` writes four groups and no `trailer` one, so these marks are
   * borrowed from the set that already has them rather than hand-placed in a fifth folder
   * the importer would never refresh.
   */
  test("every mark the table names exists in src/logos.json", async () => {
    const manifest = (await Bun.file(`${import.meta.dir}/../../../src/logos.json`).json()) as {
      sets: { streaming: string[] };
    };
    const have = new Set(manifest.sets.streaming);

    expect([...new Set(Object.values(TRAILER_MARKS))].filter((s) => !have.has(s))).toEqual([]);
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

describe("nconstForCredit", () => {
  const credit = (name: string, personId: string | null = null): PersonCredit => ({
    name,
    personId,
    image: null,
  });

  test("an id match wins, and does not consult the name at all", () => {
    const links: PersonLinks = {
      byId: { "tmdb:6193": "nm0000138" },
      byName: { "leonardo dicaprio": "nm-somebody-else" },
    };
    expect(nconstForCredit(credit("Leonardo DiCaprio", "tmdb:6193"), links)).toBe("nm0000138");
  });

  test("the name is the fallback for a credit with no id", () => {
    const links: PersonLinks = { byId: {}, byName: { "hans zimmer": "nm0001877" } };
    expect(nconstForCredit(credit("Hans Zimmer"), links)).toBe("nm0001877");
  });

  /**
   * A credit whose id we cannot place is NOT a credit we refuse to link -- it is one where
   * the better answer was unavailable, and the title-scoped name join is still safe. This
   * is every series cast entry the crosswalk misses.
   */
  test("an id we cannot place falls through to the name", () => {
    const links: PersonLinks = { byId: {}, byName: { "hans zimmer": "nm0001877" } };
    expect(nconstForCredit(credit("Hans Zimmer", "tmdb:99999"), links)).toBe("nm0001877");
  });

  /**
   * The refusal, pinned. Two same-named people on one title poison the name entry, so it is
   * simply absent -- and with no id there is nowhere certain to go. Plain text is the
   * output, not a guess at whichever of them is more famous.
   */
  test("a name we cannot place resolves to nothing, never to a guess", () => {
    expect(nconstForCredit(credit("John Williams"), { byId: {}, byName: {} })).toBeNull();
  });

  test("no map at all is nothing rather than a throw", () => {
    expect(nconstForCredit(credit("Anyone", "tmdb:1"), undefined)).toBeNull();
  });
});

describe("personNameKey", () => {
  /**
   * The server folds with its own copy in `src/lib/people.ts` and the client reads the map
   * with this one. A divergence silently unlinks every name rather than failing loudly, so
   * the fold is pinned on both sides.
   */
  test("folds case and surrounding space, and nothing else", () => {
    expect(personNameKey("  Leonardo DiCaprio ")).toBe("leonardo dicaprio");
    expect(personNameKey("Louis C.K.")).toBe("louis c.k.");
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
      { url: "https://trakt.tv/movies/tt1375666", label: "Trakt" },
      { url: "https://letterboxd.com/imdb/tt1375666/", label: "Letterboxd" },
    ]);
  });

  /**
   * Letterboxd catalogues films only, and its `/imdb/` redirect answers 200 with a
   * not-found page for a series rather than refusing -- so a series link would look live
   * and be a dead end.
   */
  test("a series gets no Letterboxd link, and TMDB's /tv/ path rather than /movie/", () => {
    const links = titleLinks("tt0944947", "series", { tmdb: 1399 }, undefined);
    expect(links.map((l) => l.label)).not.toContain("Letterboxd");
    expect(links).toContainEqual({ url: "https://www.themoviedb.org/tv/1399", label: "TMDB" });
  });

  /**
   * Trakt is the second kind-dependent address, after TMDB. It reads an IMDb id where its
   * own slug goes, but the path segment says which catalogue to look in, so a film sent to
   * `/shows/` is a 404 the reader only discovers by clicking.
   */
  test("Trakt's path segment follows the kind", () => {
    expect(titleLinks(FILM, "movie", undefined, undefined)).toContainEqual({
      url: "https://trakt.tv/movies/tt1375666",
      label: "Trakt",
    });
    expect(titleLinks("tt0944947", "series", undefined, undefined)).toContainEqual({
      url: "https://trakt.tv/shows/tt0944947",
      label: "Trakt",
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

describe("episodeStateIndex", () => {
  test("keys on the season/episode pair the two sources agree on", () => {
    const idx = episodeStateIndex([
      { season: 1, episode: 2, arrEpisodeId: 12 },
      { season: 2, episode: 1, arrEpisodeId: 21 },
    ]);
    expect(idx.get("1:2")?.arrEpisodeId).toBe(12);
    expect(idx.get("2:1")?.arrEpisodeId).toBe(21);
    // Season 12 episode 1 must not collide with season 1 episode 2.
    expect(idx.get("12:1")).toBeUndefined();
  });

  test("absent and empty both mean an empty lookup", () => {
    expect(episodeStateIndex(undefined).size).toBe(0);
    expect(episodeStateIndex([]).size).toBe(0);
  });
});
