import { describe, expect, test } from "bun:test";
import { LogoIndex, slugifyLogo } from "./logos";

describe("slugifyLogo", () => {
  test("lowercases and dashes the ordinary case", () => {
    expect(slugifyLogo("Studio Ghibli")).toBe("studio-ghibli");
    expect(slugifyLogo("HBO")).toBe("hbo");
    expect(slugifyLogo("Castle Rock Entertainment")).toBe("castle-rock-entertainment");
  });

  /**
   * THE regression this whole function exists for. A naive fold collapses `+` as
   * punctuation, and then the import writes Disney's logo over Disney+'s (or the other
   * way round, depending on directory order) with no error anywhere. Measured across
   * Kometa's 765 names, a naive fold produced 17 collisions and every one was a
   * distinct service merged into its parent brand.
   */
  test("a trailing + is a different service, not punctuation", () => {
    expect(slugifyLogo("AMC")).toBe("amc");
    expect(slugifyLogo("AMC+")).toBe("amc-plus");
    expect(slugifyLogo("AMC")).not.toBe(slugifyLogo("AMC+"));

    expect(slugifyLogo("Disney")).not.toBe(slugifyLogo("Disney+"));
    expect(slugifyLogo("Apple TV")).not.toBe(slugifyLogo("Apple TV+"));
    expect(slugifyLogo("BET")).not.toBe(slugifyLogo("BET+"));
    expect(slugifyLogo("Discovery")).not.toBe(slugifyLogo("discovery+"));
    expect(slugifyLogo("Lionsgate")).not.toBe(slugifyLogo("Lionsgate+"));
  });

  test("& is spelled out so A&E does not become a-e", () => {
    expect(slugifyLogo("A&E")).toBe("a-and-e");
    expect(slugifyLogo("U&Dave")).toBe("u-and-dave");
  });

  test("+ and & together", () => {
    expect(slugifyLogo("Planète+ A&E")).toBe("planete-plus-a-and-e");
  });

  /** Inherits the project's ligature map -- ð is a letter, not a diacritic. */
  test("folds Nordic and accented names the way titles fold", () => {
    expect(slugifyLogo("Stöð 2")).toBe("stod-2");
    expect(slugifyLogo("RTÉ One")).toBe("rte-one");
    expect(slugifyLogo("Ficción Producciones")).toBe("ficcion-producciones");
    expect(slugifyLogo("RÚV")).toBe("ruv");
  });

  /** `#` would be a fragment delimiter in a URL, so it must not survive. */
  test("strips characters that would break a URL", () => {
    expect(slugifyLogo("#0")).toBe("0");
    expect(slugifyLogo("SAT.1")).toBe("sat-1");
    expect(slugifyLogo("7mate")).toBe("7mate");
  });

  test("empty and nullish are empty, never a stray dash", () => {
    expect(slugifyLogo("")).toBe("");
    expect(slugifyLogo(null)).toBe("");
    expect(slugifyLogo(undefined)).toBe("");
    expect(slugifyLogo("   ")).toBe("");
    expect(slugifyLogo("!!!")).toBe("");
  });
});

describe("LogoIndex", () => {
  const index = new LogoIndex({
    commit: "abc123",
    generatedAt: "2026-08-30T00:00:00Z",
    sets: {
      network: ["hbo", "fx", "amc", "amc-plus"],
      studio: ["a24", "studio-ghibli", "warner-bros-pictures"],
      streaming: ["netflix"],
      rating: ["imdb", "rt-crit-fresh", "rt-aud-rotten"],
    },
  });

  test("resolves a known name to a public path", () => {
    expect(index.urlFor("network", "HBO")).toBe("/logos/network/hbo.png");
    expect(index.urlFor("studio", "Studio Ghibli")).toBe("/logos/studio/studio-ghibli.png");
  });

  test("unknown name is null, not an error -- the long tail has no logos", () => {
    expect(index.urlFor("studio", "Monkeypaw Productions")).toBeNull();
    expect(index.urlFor("network", "Some Regional Broadcaster")).toBeNull();
    expect(index.urlFor("studio", null)).toBeNull();
  });

  /** A series must not fall back to the studio set -- different vocabularies. */
  test("sets do not leak into each other", () => {
    expect(index.urlFor("studio", "HBO")).toBeNull();
    expect(index.urlFor("network", "A24")).toBeNull();
  });

  /**
   * `kind` is IMDb's `titleType` verbatim -- the index holds movie / tvSeries /
   * tvMovie / tvMiniSeries -- and the series split must match `serviceFor()` in the
   * server exactly, or a title routed to Sonarr would look its logo up in the movie
   * studio set.
   */
  test("urlForTitle splits on IMDb titleType, matching serviceFor", () => {
    expect(index.urlForTitle("tvSeries", "FX")).toBe("/logos/network/fx.png");
    expect(index.urlForTitle("tvMiniSeries", "HBO")).toBe("/logos/network/hbo.png");
    expect(index.urlForTitle("movie", "A24")).toBe("/logos/studio/a24.png");
    // tvMovie is a Radarr title, so it reads the studio set like any other movie.
    expect(index.urlForTitle("tvMovie", "A24")).toBe("/logos/studio/a24.png");
    // A movie whose studio string happens to be a network name gets nothing.
    expect(index.urlForTitle("movie", "FX")).toBeNull();
  });

  test("empty index answers null for everything and does not throw", () => {
    const empty = LogoIndex.empty();
    expect(empty.size).toBe(0);
    expect(empty.urlFor("network", "HBO")).toBeNull();
  });
});
