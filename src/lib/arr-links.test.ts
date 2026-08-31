/**
 * The admin-only arr link.
 *
 * The test that matters most is the stripping one: this is the single place in the product
 * that deliberately hands a browser an upstream URL, so "a non-admin gets null" is the
 * whole security property and not a detail of presentation.
 */

import { describe, expect, test } from "bun:test";
import { arrBaseUrl, arrLink } from "./arr-links";
import type { LibraryEntry } from "./store";

const CFG = {
  radarr: { url: "http://10.0.0.5:7878", apiKey: "k", publicUrl: "https://radarr.example.com" },
  sonarr: { url: "http://10.0.0.5:8989", apiKey: "k" },
};

function entry(over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    imdb_id: "tt0092494",
    service: "radarr",
    arr_id: 7,
    has_file: 1,
    monitored: 1,
    progress: 1,
    title_slug: "700391",
    updated_at: "2026-08-31T00:00:00.000Z",
    ...over,
  };
}

describe("arrLink", () => {
  test("an admin gets the public address, not the one the server dials", () => {
    expect(arrLink(CFG, entry(), "admin")).toEqual({
      service: "radarr",
      label: "Radarr",
      url: "https://radarr.example.com/movie/700391",
    });
  });

  test("a non-admin gets NOTHING -- the address never reaches an ordinary user", () => {
    expect(arrLink(CFG, entry(), "user")).toBeNull();
    expect(arrLink(CFG, entry(), null)).toBeNull();
  });

  test("Sonarr routes on /series and falls back to the server's own url", () => {
    const e = entry({ service: "sonarr", title_slug: "preacher" });
    expect(arrLink(CFG, e, "admin")).toEqual({
      service: "sonarr",
      label: "Sonarr",
      url: "http://10.0.0.5:8989/series/preacher",
    });
  });

  test("no slug, no title, no configured arr -- each yields null rather than a guess", () => {
    // A row mirrored before the column existed. A link to /movie/null is worse than none.
    expect(arrLink(CFG, entry({ title_slug: null }), "admin")).toBeNull();
    // Not in the library at all: there is no arr page to open.
    expect(arrLink(CFG, undefined, "admin")).toBeNull();
    expect(arrLink({}, entry(), "admin")).toBeNull();
  });

  test("a slug with a slash in it cannot escape the route segment", () => {
    const e = entry({ title_slug: "../../settings/general" });
    expect(arrLink(CFG, e, "admin")?.url).toBe(
      "https://radarr.example.com/movie/..%2F..%2Fsettings%2Fgeneral",
    );
  });
});

describe("arrBaseUrl", () => {
  test("publicUrl wins, url is the fallback, and a trailing slash never doubles", () => {
    expect(arrBaseUrl({ url: "http://a/", apiKey: "k", publicUrl: "https://b/" })).toBe("https://b");
    expect(arrBaseUrl({ url: "http://a/", apiKey: "k" })).toBe("http://a");
  });

  test("an EMPTY publicUrl reads as unset, because that is what compose sends", () => {
    // `FINDERR_RADARR_PUBLIC_URL: ${RADARR_PUBLIC_URL:-}` puts an empty string in the
    // environment when the operator has not set one. Treating it as a base would build
    // "/movie/700391" -- a link to finderr itself.
    expect(arrBaseUrl({ url: "http://a", apiKey: "k", publicUrl: "" })).toBe("http://a");
    expect(arrBaseUrl({ url: "http://a", apiKey: "k", publicUrl: "   " })).toBe("http://a");
    expect(arrBaseUrl(undefined)).toBeNull();
  });
});
