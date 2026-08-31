import { describe, expect, test } from "bun:test";
import { hasOverrides, parseRequestOverrides } from "./request-overrides";

/** Narrow a parse result to its overrides, failing loudly if it refused. */
function ok(body: unknown) {
  const parsed = parseRequestOverrides(body);
  if ("error" in parsed) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.overrides;
}

/** Narrow a parse result to its refusal, failing loudly if it accepted. */
function err(body: unknown): string {
  const parsed = parseRequestOverrides(body);
  if (!("error" in parsed)) throw new Error("expected a refusal");
  return parsed.error;
}

describe("parseRequestOverrides", () => {
  test("an ordinary request carries nothing, and that is not an error", () => {
    // The overwhelmingly common case: a user clicks Request and the body is just a tconst.
    expect(ok({ tconst: "tt0111161" })).toEqual({});
    expect(hasOverrides(ok({ tconst: "tt0111161" }))).toBe(false);
  });

  test("null means the same as absent -- a cleared selection is not a choice", () => {
    const o = ok({ qualityProfileId: null, rootFolderPath: null, searchOnAdd: null });
    expect(o).toEqual({});
    expect(hasOverrides(o)).toBe(false);
  });

  test("all three together", () => {
    const o = ok({ qualityProfileId: 7, rootFolderPath: "/media/movies-4k", searchOnAdd: false });
    expect(o).toEqual({ qualityProfileId: 7, rootFolderPath: "/media/movies-4k", searchOnAdd: false });
    expect(hasOverrides(o)).toBe(true);
  });

  test("searchOnAdd: false is a real choice, not an absent one", () => {
    // The falsy trap. `if (body.searchOnAdd)` would drop this silently, and the admin who
    // deliberately said "add it but do not search yet" would get a search anyway.
    const o = ok({ searchOnAdd: false });
    expect(o.searchOnAdd).toBe(false);
    expect(hasOverrides(o)).toBe(true);
  });

  test("a non-integer or non-positive profile id is refused, not coerced", () => {
    // A caller sending "5" has a bug. Coercing it hides the bug and works right up until
    // the day the string is not a number.
    expect(err({ qualityProfileId: "5" })).toContain("positive integer");
    expect(err({ qualityProfileId: 1.5 })).toContain("positive integer");
    expect(err({ qualityProfileId: 0 })).toContain("positive integer");
    expect(err({ qualityProfileId: -3 })).toContain("positive integer");
  });

  test("a root folder must be an absolute path", () => {
    expect(err({ rootFolderPath: "movies" })).toContain("absolute");
    expect(err({ rootFolderPath: "   " })).toContain("empty");
    expect(err({ rootFolderPath: 5 })).toContain("string");
    expect(ok({ rootFolderPath: "/media/tv" }).rootFolderPath).toBe("/media/tv");
    // Sonarr and Radarr both run on Windows for a lot of people.
    expect(ok({ rootFolderPath: "D:\\Media\\TV" }).rootFolderPath).toBe("D:\\Media\\TV");
  });

  test("a root folder is trimmed, because a trailing space is a different folder to an arr", () => {
    expect(ok({ rootFolderPath: "  /media/tv  " }).rootFolderPath).toBe("/media/tv");
  });

  test("searchOnAdd must be a boolean", () => {
    expect(err({ searchOnAdd: "yes" })).toContain("boolean");
    expect(err({ searchOnAdd: 1 })).toContain("boolean");
  });

  test("a non-object body yields no overrides rather than throwing", () => {
    // The route has already refused a non-JSON body; this is the belt to that braces.
    expect(ok(null)).toEqual({});
    expect(ok("nope")).toEqual({});
    expect(ok(42)).toEqual({});
  });

  test("it does not check that the profile EXISTS, and that is deliberate", () => {
    // The arr is the authority on its own ids and it is the one that will refuse. Asking it
    // here would put a network call inside a request the browser is waiting on, which is
    // the one thing this product is built not to do.
    expect(ok({ qualityProfileId: 999_999 }).qualityProfileId).toBe(999_999);
  });
});
