/**
 * What `postRequest` actually puts on the wire.
 *
 * The rule under test is invisible from the outside and expensive to get wrong: the server
 * REFUSES a non-admin who sends any of the three override keys, so a body carrying
 * `qualityProfileId: null` turns every ordinary user's request into a 403 -- on a request
 * they made by clicking one button, with nothing on screen to explain it.
 *
 * "Absent, not null" is therefore a correctness rule rather than a tidiness one, which is
 * why `requestBody` is exported and pinned here rather than being inlined in the fetch.
 */

import { describe, expect, test } from "bun:test";
import { requestBody } from "./api";

describe("requestBody", () => {
  test("an ordinary request is a tconst and nothing else", () => {
    expect(requestBody("tt0111161")).toEqual({ tconst: "tt0111161" });
  });

  test("an empty overrides object adds no keys -- this is the non-admin path", () => {
    // `RequestOptions` starts at `{}` and a non-admin never renders it at all, so this is
    // the body every ordinary user sends. One stray key here is a 403 for all of them.
    const body = requestBody("tt0111161", null, {});
    expect(body).toEqual({ tconst: "tt0111161" });
    expect(Object.hasOwn(body, "qualityProfileId")).toBe(false);
    expect(Object.hasOwn(body, "rootFolderPath")).toBe(false);
    expect(Object.hasOwn(body, "searchOnAdd")).toBe(false);
  });

  test("nulls are dropped, not forwarded -- clearing a picker is not choosing", () => {
    // Selecting "Service default" in the panel sets the field back to null. That must
    // travel as absence, or an admin who opened the panel and changed their mind sends a
    // body claiming they chose something.
    const body = requestBody("tt0111161", null, {
      qualityProfileId: null,
      rootFolderPath: null,
      searchOnAdd: null,
    });
    expect(body).toEqual({ tconst: "tt0111161" });
  });

  test("chosen overrides travel", () => {
    expect(
      requestBody("tt0111161", null, {
        qualityProfileId: 7,
        rootFolderPath: "/media/movies-4k",
        searchOnAdd: false,
      }),
    ).toEqual({
      tconst: "tt0111161",
      qualityProfileId: 7,
      rootFolderPath: "/media/movies-4k",
      searchOnAdd: false,
    });
  });

  test("searchOnAdd false survives -- it is a choice, not an absence", () => {
    // The falsy trap, on the client side this time. A truthiness check here would drop the
    // one setting whose entire purpose is to be false.
    expect(requestBody("tt0111161", null, { searchOnAdd: false })).toEqual({
      tconst: "tt0111161",
      searchOnAdd: false,
    });
  });

  test("seasons keep their existing rule: sent when chosen, absent when not", () => {
    expect(requestBody("tt0944947", [1, 2])).toEqual({ tconst: "tt0944947", seasons: [1, 2] });
    expect(requestBody("tt0944947", [])).toEqual({ tconst: "tt0944947" });
    expect(requestBody("tt0944947", null)).toEqual({ tconst: "tt0944947" });
  });

  test("seasons and overrides travel together", () => {
    expect(requestBody("tt0944947", [3], { qualityProfileId: 2 })).toEqual({
      tconst: "tt0944947",
      seasons: [3],
      qualityProfileId: 2,
    });
  });
});
