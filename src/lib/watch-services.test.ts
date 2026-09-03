import { describe, expect, test } from "bun:test";
import {
  pickWatchProviders,
  STREAMING_MARKS,
  serviceKey,
  streamingLogo,
  watchServices,
} from "./watch-services";

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
      { name: "Sky Go", logo: null, key: "skygo" },
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
    ).toEqual([{ name: "Netflix", logo: "/logos/streaming/netflix.png", key: "netflix" }]);
  });

  /**
   * The duplicate caught on Game of Thrones after the Netflix one was fixed. TMDB
   * lists a reseller as its own provider, so the row drew the HBO mark beside a tile
   * printing "HBO Max Amazon Channel" -- one service, two tiles, and the pane is asking
   * WHICH SERVICE rather than through whose billing.
   */
  test("a service resold through a storefront is the same service", () => {
    expect(watchServices(country("US", ["HBO Max Amazon Channel", "HBO Max"]))).toEqual([
      { name: "HBO Max", logo: "/logos/streaming/hbo-max.png", key: "hbo-max" },
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
      { name: "MGM+ Amazon Channel", logo: null, key: "mgmplus" },
    ]);
  });

  /**
   * A closed list, not a blanket `/channel$/`: a service genuinely named for a channel is
   * indistinguishable from a reseller by the string alone.
   */
  test("only the known storefront suffixes fold away", () => {
    expect(watchServices(country("US", ["Comedy Central", "Comedy Central Amazon Channel"]))).toEqual([
      { name: "Comedy Central", logo: null, key: "comedycentral" },
    ]);
    expect(watchServices(country("US", ["Discovery Channel", "Crunchyroll"])).length).toBe(2);
  });

  /** No mark to key on, so the folded name is the key -- and it still collapses spellings. */
  test("an unmarked service dedupes on its folded name", () => {
    expect(watchServices(country("US", ["Spectrum On Demand", "spectrum on demand"]))).toEqual([
      { name: "Spectrum On Demand", logo: null, key: "spectrumondemand" },
    ]);
  });

  /** Two subscriptions, two marks, two tiles -- the collision `+` is spelt out to avoid. */
  test("Disney and Disney+ stay two tiles", () => {
    expect(watchServices(country("US", ["Disney", "Disney+"]))).toEqual([
      { name: "Disney", logo: "/logos/streaming/disney.png", key: "disney" },
      { name: "Disney+", logo: "/logos/streaming/disney-plus.png", key: "disney-plus" },
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

describe("serviceKey", () => {
  /** The identity a `/term/service/:key` URL carries -- one key per service, not per name. */
  test("every spelling of one service folds to one key", () => {
    expect(serviceKey("Netflix Standard with Ads")).toBe(serviceKey("Netflix"));
    expect(serviceKey("HBO Max Amazon Channel")).toBe(serviceKey("HBO Max"));
    expect(serviceKey("Disney Plus")).toBe(serviceKey("Disney+"));
  });

  test("two services keep two keys", () => {
    expect(serviceKey("Disney")).not.toBe(serviceKey("Disney+"));
    expect(serviceKey("Apple TV")).not.toBe(serviceKey("Apple TV+"));
  });

  /**
   * An unmarked service still gets a stable key, which is what lets the 274 services Kometa
   * publishes no art for be browsable at all.
   */
  test("a service with no mark folds to its own name", () => {
    expect(serviceKey("Spectrum On Demand")).toBe("spectrumondemand");
    expect(serviceKey("spectrum on demand")).toBe("spectrumondemand");
  });

  /**
   * It reaches a URL as a path segment, so anything a route would have to escape is a key
   * that cannot round-trip. Read off the table rather than spot-checked, so a slug added
   * later cannot slip a character past this.
   */
  test("every key is URL-safe without encoding", () => {
    const keys = [...Object.keys(STREAMING_MARKS), ...Object.values(STREAMING_MARKS)];
    expect(keys.filter((k) => k !== encodeURIComponent(k))).toEqual([]);
    expect(serviceKey("Disney+")).toBe(encodeURIComponent(serviceKey("Disney+")));
  });
});

describe("streamingLogo is bound to the imported logo set", () => {
  /** The same guard `ratingLogo` gets, read off the table rather than re-typed. */
  test("every mark the table names exists in src/logos.json", async () => {
    const manifest = (await Bun.file(`${import.meta.dir}/../logos.json`).json()) as {
      sets: { streaming: string[] };
    };
    const have = new Set(manifest.sets.streaming);

    expect([...new Set(Object.values(STREAMING_MARKS))].filter((s) => !have.has(s))).toEqual([]);
  });
});
