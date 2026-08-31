import { describe, expect, test } from "bun:test";
import {
  type CastMember,
  classFor,
  type Episode,
  type ExternalIds,
  entityKindFor,
  FACET_NAMES,
  FACETS,
  FRESHNESS_CLASSES,
  FRESHNESS_TTL_MS,
  facetsFor,
  IMAGE_BEARING_FACETS,
  isFacetName,
  isFreshnessClass,
  isValidContribution,
  mapFacetImages,
  mergeContributions,
  type Rating,
  type Season,
  scheduleHorizonOf,
} from "./facets";

describe("entityKindFor", () => {
  test("everything episodic is a series, everything else is a movie", () => {
    expect(entityKindFor("tvSeries")).toBe("series");
    expect(entityKindFor("tvMiniSeries")).toBe("series");
    expect(entityKindFor("movie")).toBe("movie");
    // A tvMovie lives in Radarr and has no seasons -- it is a movie to a provider.
    expect(entityKindFor("tvMovie")).toBe("movie");
    expect(entityKindFor("something IMDb invents next year")).toBe("movie");
  });
});

describe("the vocabulary", () => {
  test("every declared facet names at least one entity kind", () => {
    for (const facet of FACET_NAMES) {
      expect(FACETS[facet].entities.length).toBeGreaterThan(0);
    }
  });

  /** The list/object/single split decides how a merge behaves; a wrong one corrupts data. */
  test("facets with several sources are lists, so nothing clobbers anything", () => {
    expect(FACETS.ratings.merge).toBe("list");
    expect(FACETS.cast.merge).toBe("list");
    expect(FACETS.externalIds.merge).toBe("object");
  });

  test("facts that never change are declared immutable", () => {
    for (const facet of ["cast", "crew", "externalIds"] as const) {
      expect(FACETS[facet].immutable).toBe(true);
    }
    expect(FACETS.ratings.immutable).toBeUndefined();
  });

  /**
   * `collection` was in the list above until 2026-08-31, and taking it out is the point
   * rather than a relaxation.
   *
   * `immutable` means the fact CANNOT change. The cast of Inception cannot; "which films
   * are in this collection" plainly can, because a franchise gains members. Cached
   * forever, a sequel announced after the row was written would never appear -- and the
   * failure is invisible, because a stale collection looks exactly like a complete one.
   *
   * The age ladder is already right for it without a special case: a settled franchise
   * gets the long rung, a collection hung on a current release gets a short one, and that
   * is where the next entry actually lands.
   */
  test("a collection can GAIN members, so it is not immutable", () => {
    expect(FACETS.collection.immutable).toBeUndefined();
    expect(FACETS.collection.merge).toBe("single");
  });

  /**
   * `links` sits right beside `externalIds` and is deliberately NOT immutable, which is the
   * kind of near-miss worth a test rather than a comment. An id crosswalk is a fact about
   * identity and cannot change; an address can -- a studio campaign page gets rebuilt or
   * taken down, and caching one forever would leave a dead chip on the page permanently.
   */
  test("links can go stale even though the ids beside them cannot", () => {
    expect(FACETS.externalIds.immutable).toBe(true);
    expect(FACETS.links.immutable).toBeUndefined();
    // A list, so an official site and a plugin's wiki link coexist rather than clobbering.
    expect(FACETS.links.merge).toBe("list");
  });

  test("availability is core-owned and never offered to a provider", () => {
    expect(FACETS.availability.coreOnly).toBe(true);
    expect(facetsFor("movie")).not.toContain("availability");
    expect(facetsFor("series")).not.toContain("availability");
  });

  test("a movie is never asked for seasons, a series never for releaseDates", () => {
    expect(facetsFor("movie")).toContain("releaseDates");
    expect(facetsFor("movie")).not.toContain("seasons");
    expect(facetsFor("series")).toContain("seasons");
    expect(facetsFor("series")).not.toContain("releaseDates");
  });

  test("isFacetName rejects anything not declared", () => {
    expect(isFacetName("ratings")).toBe(true);
    expect(isFacetName("tomatoScore")).toBe(false);
    // Object.hasOwn, not `in` -- a prototype key must not read as a facet.
    expect(isFacetName("toString")).toBe(false);
  });
});

describe("the image walk", () => {
  const cast: CastMember[] = [
    { name: "A", character: null, order: 1, personId: null, image: "https://up.example/a.jpg" },
    { name: "B", character: null, order: 2, personId: null, image: null },
  ];
  /** Stands in for the real rewrite, which is `src/server/facet-images.ts`'s job. */
  const localise = (url: string) => `/img/f/${url.split("/").pop()}`;

  test("every field the vocabulary declares as an image is walked", () => {
    // The four shapes carrying `image: string | null`, and nothing else claiming to.
    expect(IMAGE_BEARING_FACETS.sort()).toEqual(["cast", "crew", "episodes", "seasons"]);
  });

  test("a declared image field is rewritten and a null one is left alone", () => {
    const out = mapFacetImages("cast", cast, localise);
    expect(out[0].image).toBe("/img/f/a.jpg");
    expect(out[1].image).toBeNull();
    // Everything else about the entry survives.
    expect(out[0].name).toBe("A");
  });

  test("null from the mapper clears the field, so a pane falls back rather than fetching", () => {
    expect(mapFacetImages("cast", cast, () => null)[0].image).toBeNull();
  });

  test("the input is not mutated -- the walk copies", () => {
    mapFacetImages("cast", cast, localise);
    expect(cast[0].image).toBe("https://up.example/a.jpg");
  });

  test("a facet with no image field comes back by reference, unwalked", () => {
    const ratings: Rating[] = [{ source: "IMDb", kind: "user", value: 8.4, outOf: 10 }];
    expect(mapFacetImages("ratings", ratings, localise)).toBe(ratings);
  });

  /**
   * All four image-bearing facets are lists today. A `single` facet is ONE object, and
   * the day somebody declares an image on one it must be walked rather than silently
   * skipped -- so the object shape is fed in here deliberately, ahead of that facet.
   */
  test("a facet whose value is one object, not a list, is walked too", () => {
    const single = { number: 1, image: "https://up.example/s.jpg" } as unknown as Season[];
    const out = mapFacetImages("seasons", single, localise) as unknown as { image: string };
    expect(out.image).toBe("/img/f/s.jpg");
  });
});

describe("freshness", () => {
  test("only the declared classes are accepted", () => {
    expect(isFreshnessClass("settled")).toBe(true);
    expect(isFreshnessClass("forever")).toBe(false);
    expect(isFreshnessClass(90)).toBe(false);
  });

  test("every class has a duration, so a new class cannot land without one", () => {
    for (const cls of FRESHNESS_CLASSES) {
      expect(Object.hasOwn(FRESHNESS_TTL_MS, cls)).toBe(true);
    }
  });
});

describe("the freshness ladder", () => {
  /** 2026-06-15, so "this year" and "last year" are unambiguous below. */
  const NOW = Date.parse("2026-06-15T00:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const ttlFor = (
    facet: Parameters<typeof classFor>[0],
    claimed: Parameters<typeof classFor>[1],
    subject: Parameters<typeof classFor>[2],
  ) => FRESHNESS_TTL_MS[classFor(facet, claimed, subject, NOW)];

  test("the ladder is the durations the card ratified", () => {
    expect(FRESHNESS_TTL_MS.immutable).toBeNull();
    expect(FRESHNESS_TTL_MS.settled).toBe(90 * DAY);
    expect(FRESHNESS_TTL_MS.recent).toBe(14 * DAY);
    expect(FRESHNESS_TTL_MS.fresh).toBe(3 * DAY);
    expect(FRESHNESS_TTL_MS.moving).toBe(12 * HOUR);
    expect(FRESHNESS_TTL_MS.volatile).toBe(7 * DAY);
  });

  test("an immutable facet never expires, whatever the provider claims", () => {
    expect(ttlFor("cast", "volatile", { year: 2026 })).toBeNull();
    expect(ttlFor("externalIds", "moving", { year: 2026 })).toBeNull();
  });

  /**
   * The other half of dropping `immutable` from `collection`: it now EXPIRES, which is
   * the behaviour change the declaration was only half of. This used to be the second
   * assertion in the test above -- the rule it was defending is still true, `collection`
   * just stopped being an example of it.
   */
  test("a collection expires on the ladder, so a new sequel can still arrive", () => {
    expect(ttlFor("collection", "moving", { year: 2026 })).not.toBeNull();
    // And the ladder, not the claim, is what sets it: an old franchise still caches long.
    const recent = ttlFor("collection", "moving", { year: 2026 }) as number;
    const settled = ttlFor("collection", "moving", { year: 1972 }) as number;
    expect(settled).toBeGreaterThan(recent);
  });

  test("a provider claiming immutable gets it, on a mutable facet", () => {
    expect(ttlFor("ratings", "immutable", { year: 2026 })).toBeNull();
  });

  /**
   * The point of the whole card: both shipped providers call `ratings` "moving", and an
   * old film's score must still cache for months rather than being re-asked twice a day.
   */
  test("a settled title's ratings cache for 90 days even though the provider said moving", () => {
    expect(ttlFor("ratings", "moving", { year: 2010 })).toBe(90 * DAY);
  });

  test("the same lookup on a newer title climbs the ladder", () => {
    expect(ttlFor("ratings", "moving", { year: 2025 })).toBe(14 * DAY);
    expect(ttlFor("ratings", "moving", { year: 2026 })).toBe(3 * DAY);
  });

  test("a title that is not out yet is still being written about", () => {
    expect(ttlFor("ratings", "settled", { year: 2027 })).toBe(12 * HOUR);
  });

  test("a title with no year gets the conservative rung, not the longest cache", () => {
    expect(ttlFor("ratings", "settled", { year: null })).toBe(14 * DAY);
  });

  /** watchProviders churn when a licensing deal ends, which has nothing to do with age. */
  test("a volatile fact never rides the age ladder", () => {
    expect(ttlFor("watchProviders", "volatile", { year: 1994 })).toBe(7 * DAY);
    expect(ttlFor("watchProviders", "volatile", { year: 2026 })).toBe(7 * DAY);
  });

  describe("a continuing series", () => {
    /** tt0944947: premiered 2011, so the age ladder alone would file it `settled`. */
    const OLD_SERIES = { year: 2011 };

    test("its schedule is moving while episodes are still airing", () => {
      expect(ttlFor("episodes", "settled", { ...OLD_SERIES, latestKnownDate: "2026-06-10" })).toBe(12 * HOUR);
      expect(ttlFor("episodes", "settled", { ...OLD_SERIES, latestKnownDate: "2026-07-01" })).toBe(12 * HOUR);
    });

    test("its schedule settles once the last episode is well past", () => {
      expect(ttlFor("episodes", "settled", { ...OLD_SERIES, latestKnownDate: "2019-05-19" })).toBe(90 * DAY);
    });

    /**
     * Built the way the resolver builds it -- through `scheduleHorizonOf` -- because the
     * override is scoped by which facets HAVE a horizon rather than by a second list of
     * facet names. A rating for a show airing tonight is still a 2011 rating.
     */
    test("only its schedule is continuing; the age ladder still governs its ratings", () => {
      const ratings: Rating[] = [{ source: "imdb", kind: "user", value: 9.2, outOf: 10 }];
      const subject = { ...OLD_SERIES, latestKnownDate: scheduleHorizonOf("ratings", ratings) };
      expect(ttlFor("ratings", "moving", subject)).toBe(90 * DAY);
    });
  });
});

describe("scheduleHorizonOf", () => {
  const episodes: Episode[] = [
    {
      season: 1,
      number: 1,
      title: "Winter Is Coming",
      airDate: "2011-04-17",
      overview: null,
      image: null,
      runtime: 62,
    },
    {
      season: 1,
      number: 2,
      title: "The Kingsroad",
      airDate: "2011-04-24",
      overview: null,
      image: null,
      runtime: 56,
    },
    { season: 1, number: 3, title: "unaired", airDate: null, overview: null, image: null, runtime: null },
  ];

  test("the newest air date wins, whatever order the episodes arrive in", () => {
    expect(scheduleHorizonOf("episodes", episodes)).toBe("2011-04-24");
    expect(scheduleHorizonOf("episodes", [...episodes].reverse())).toBe("2011-04-24");
  });

  test("seasons carry the same signal, from their own date fields", () => {
    const seasons: Season[] = [
      {
        number: 1,
        name: "Season 1",
        episodeCount: 10,
        premiereDate: "2011-04-17",
        endDate: "2011-06-19",
        image: null,
      },
      {
        number: 2,
        name: "Season 2",
        episodeCount: 10,
        premiereDate: "2012-04-01",
        endDate: null,
        image: null,
      },
    ];
    expect(scheduleHorizonOf("seasons", seasons)).toBe("2012-04-01");
  });

  /** Everything else rides the age ladder, so it must not accidentally grow a horizon. */
  test("a facet that carries no schedule has no horizon", () => {
    expect(
      scheduleHorizonOf("ratings", [{ source: "imdb", kind: "user", value: 9.2, outOf: 10 }]),
    ).toBeNull();
    expect(scheduleHorizonOf("episodes", null)).toBeNull();
    expect(scheduleHorizonOf("episodes", [])).toBeNull();
  });
});

describe("mergeContributions", () => {
  const imdb: Rating[] = [{ source: "imdb", kind: "user", value: 8.8, outOf: 10 }];
  const rt: Rating[] = [
    { source: "rottentomatoes", kind: "critics", value: 86, outOf: 100 },
    { source: "rottentomatoes", kind: "audience", value: 91, outOf: 100 },
  ];

  /** The case the whole design exists for: two plugins, one row on screen. */
  test("two plugins providing ratings produce one merged list", () => {
    const merged = mergeContributions(
      "ratings",
      new Map([
        ["servarr-metadata", imdb],
        ["rotten-tomatoes", rt],
      ]),
    );
    expect(merged).toHaveLength(3);
    expect(merged?.map((r) => r.source)).toEqual(["rottentomatoes", "rottentomatoes", "imdb"]);
  });

  /** Deterministic by plugin id, never by whatever order the filesystem listed the files in. */
  test("merge order does not depend on insertion order", () => {
    const a = mergeContributions(
      "ratings",
      new Map([
        ["a-plugin", imdb],
        ["z-plugin", rt],
      ]),
    );
    const b = mergeContributions(
      "ratings",
      new Map([
        ["z-plugin", rt],
        ["a-plugin", imdb],
      ]),
    );
    expect(a).toEqual(b as Rating[]);
  });

  test("an object facet is merged key by key", () => {
    const merged = mergeContributions(
      "externalIds",
      new Map<string, ExternalIds>([
        ["servarr-metadata", { tvdb: 121361 }],
        ["rotten-tomatoes", { rt: "inception" }],
      ]),
    );
    expect(merged).toEqual({ tvdb: 121361, rt: "inception" });
  });

  test("a single facet takes the first contribution by plugin id", () => {
    const merged = mergeContributions(
      "synopsis",
      new Map([
        ["z-plugin", { text: "last", language: "en", source: "z" }],
        ["a-plugin", { text: "first", language: "en", source: "a" }],
      ]),
    );
    expect(merged?.text).toBe("first");
  });

  test("nothing contributed is null, not an empty value", () => {
    expect(mergeContributions("ratings", new Map())).toBeNull();
  });
});

describe("isValidContribution", () => {
  test("accepts a well-formed contribution", () => {
    expect(isValidContribution("ratings", { data: [{ source: "imdb" }] })).toBe(true);
    expect(isValidContribution("ratings", { data: [], freshness: "settled" })).toBe(true);
    expect(isValidContribution("synopsis", { data: { text: "x" } })).toBe(true);
  });

  /** Everything here is a shape a renderer or a merge would break on. */
  test("rejects the shapes that would break a merge", () => {
    expect(isValidContribution("ratings", { data: { source: "imdb" } })).toBe(false);
    expect(isValidContribution("ratings", { data: ["86%"] })).toBe(false);
    expect(isValidContribution("synopsis", { data: ["not an object"] })).toBe(false);
    expect(isValidContribution("ratings", { data: null })).toBe(false);
    expect(isValidContribution("ratings", {})).toBe(false);
    expect(isValidContribution("ratings", "86%")).toBe(false);
    expect(isValidContribution("ratings", null)).toBe(false);
  });

  test("rejects a freshness class core does not know", () => {
    expect(isValidContribution("ratings", { data: [], freshness: "forever" })).toBe(false);
  });
});
