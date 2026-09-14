import { describe, expect, test } from "bun:test";
import { placeMapUrl, placeWikidataUrl } from "./place-links";

describe("placeMapUrl", () => {
  test("OpenStreetMap, lat before lon, and nothing without a coordinate", () => {
    expect(placeMapUrl({ lat: 36.841667, lon: -2.463889 })).toBe(
      "https://www.openstreetmap.org/?mlat=36.84167&mlon=-2.46389#map=14/36.84167/-2.46389",
    );
    expect(placeMapUrl({ lat: null, lon: 1 })).toBeNull();
    expect(placeMapUrl({ lat: 1, lon: null })).toBeNull();
  });
});

describe("placeWikidataUrl", () => {
  test("the item page, keyed on the id as the reader sees it", () => {
    expect(placeWikidataUrl({ id: "Q10400" })).toBe("https://www.wikidata.org/wiki/Q10400");
  });
});
