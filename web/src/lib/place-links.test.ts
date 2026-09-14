import { describe, expect, test } from "bun:test";
import {
  countryCaption,
  episodesLabel,
  partsLabel,
  placeMapUrl,
  placePrefix,
  placeWikidataUrl,
} from "./place-links";

describe("placeMapUrl", () => {
  test("OpenStreetMap, lat before lon, and nothing without a coordinate", () => {
    expect(placeMapUrl({ lat: 36.841667, lon: -2.463889 })).toBe(
      "https://www.openstreetmap.org/?mlat=36.84167&mlon=-2.46389#map=14/36.84167/-2.46389",
    );
    expect(placeMapUrl({ lat: null, lon: 1 })).toBeNull();
    expect(placeMapUrl({ lat: 1, lon: null })).toBeNull();
  });
});

describe("placePrefix", () => {
  test("an area is filmed IN, a site or a studio is filmed AT", () => {
    expect(placePrefix({ kind: "area" })).toBe("Filmed in");
    expect(placePrefix({ kind: "site" })).toBe("Filmed at");
  });
});

describe("episodesLabel", () => {
  test("one is singular, and a count past a thousand is grouped", () => {
    expect(episodesLabel(1)).toBe("1 episode");
    expect(episodesLabel(178)).toBe("178 episodes");
    expect(episodesLabel(1200)).toBe(`${(1200).toLocaleString()} episodes`);
  });
});

describe("partsLabel", () => {
  test("episodes are the finer grain, a season-only place says its season, and a series' own claim says nothing", () => {
    expect(partsLabel({ episodes: 2, seasons: 1 })).toBe("2 episodes");
    expect(partsLabel({ episodes: 0, seasons: 1 })).toBe("1 season");
    expect(partsLabel({ episodes: 0, seasons: 3 })).toBe("3 seasons");
    expect(partsLabel({ episodes: 0, seasons: 0 })).toBeNull();
  });
});

// Seen on /place/Q334, 2026-09-14: "Filmed in Singapore" over a caption reading "Singapore".
describe("countryCaption", () => {
  test("a city-state's country is not printed under its own name", () => {
    expect(countryCaption("Singapore", "Singapore")).toBeNull();
    expect(countryCaption("Monaco", "monaco")).toBeNull();
    expect(countryCaption("Vatican City", "Vatican City")).toBeNull();
  });

  test("any other place keeps its country, and no country is no caption", () => {
    expect(countryCaption("Almería", "Spain")).toBe("Spain");
    expect(countryCaption("Almería", null)).toBeNull();
  });
});

describe("placeWikidataUrl", () => {
  test("the item page, keyed on the id as the reader sees it", () => {
    expect(placeWikidataUrl({ id: "Q10400" })).toBe("https://www.wikidata.org/wiki/Q10400");
  });
});
