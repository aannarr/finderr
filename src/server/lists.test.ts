/**
 * The `/lists` payload: completion counts, curated poster strips, and the people boards.
 *
 * Every collaborator is injected, so each case here is exercised with no index, no library
 * and no server -- which is the point of the split: the payload's rules are about WHICH
 * lists get a count, which winners are drawable and what the boards are ranked over, and
 * none of that needs SQLite to be true.
 */

import { describe, expect, test } from "bun:test";
import type { AnchorWin } from "../lib/award-marks";
import { AWARDS } from "../lib/award-registry";
import { computedLists } from "../lib/lists";
import type { CreditTally } from "../lib/people";
import { completionPayload, type ListsDeps, POSTER_STRIP } from "./lists";

const YEAR = 2026;
const AWARD = AWARDS[0]?.id as string;

/** A fake index: `size` ids for every list, or none for the ones named as unranked. */
function members(size: number, unranked: string[] = []) {
  return (list: { id: string }) =>
    unranked.includes(list.id) ? [] : Array.from({ length: size }, (_, i) => `tt${list.id}-${i}`);
}

/** Everything off unless a case switches it on, so each test states only what it is about. */
function deps(over: Partial<ListsDeps> = {}): ListsDeps {
  return {
    year: YEAR,
    members: members(250),
    ownedCount: () => 0,
    winners: () => [],
    hasPoster: () => false,
    credits: () => [],
    ...over,
  };
}

/** `n` anchor wins for one award, newest first, ids `tt-win-0` upward. */
function wins(n: number, award = AWARD): AnchorWin[] {
  return Array.from({ length: n }, (_, i) => ({
    tconst: `tt-win-${i}`,
    title: `Winner ${i}`,
    award,
    ceremony: 100 - i,
    year: String(2026 - i),
  }));
}

describe("completion counts", () => {
  test("one entry per computed list, counted against the library", () => {
    const payload = completionPayload(
      deps({
        // Every third id owned, so the count is a real function of the ids rather than a
        // constant a broken implementation could also return.
        ownedCount: (ids) => ids.filter((_, i) => i % 3 === 0).length,
      }),
    );

    expect(payload.completions).toHaveLength(computedLists(YEAR).length);
    for (const c of payload.completions) {
      expect(c.size).toBe(250);
      expect(c.owned).toBe(84);
    }
  });

  test("a list with no members is OMITTED, never sent as zero", () => {
    // An index built before the rank column, or a genre nothing is ranked in, has no list to
    // be complete of. "You own 0 of 0" reads as an empty library rather than as an absent
    // list, so the id simply is not there and every surface draws nothing for it.
    const payload = completionPayload(
      deps({ members: members(250, ["genre-horror", "top-250-series"]), ownedCount: () => 1 }),
    );

    const ids = payload.completions.map((c) => c.id);
    expect(ids).not.toContain("genre-horror");
    expect(ids).not.toContain("top-250-series");
    expect(ids).toContain("top-250");
  });

  test("a language list is counted like any other, and omitted the same way", () => {
    // The route hands `members` the list's whole filter object, so a language list is one
    // more ranked query -- there is no second code path for it. What differs is that an
    // index built before the origin stage returns nothing for EVERY one of them, which is
    // the signal `/lists` reads to draw no language rows at all.
    const languages = computedLists(YEAR)
      .filter((l) => l.filters.lang)
      .map((l) => l.id);
    expect(languages.length).toBeGreaterThan(0);

    const counted = completionPayload(deps({ ownedCount: () => 7 })).completions.map((c) => c.id);
    for (const id of languages) expect(counted).toContain(id);

    const originless = completionPayload(deps({ members: members(250, languages) })).completions;
    for (const id of languages) expect(originless.map((c) => c.id)).not.toContain(id);
    expect(originless.map((c) => c.id)).toContain("top-250");
  });

  test("an index with nothing ranked yields an empty payload rather than a wall of zeroes", () => {
    expect(completionPayload(deps({ members: () => [] }))).toEqual({
      completions: [],
      posters: {},
      boards: [],
    });
  });

  test("`size` is what the index RETURNED, not what was asked for", () => {
    // A thin slice is genuinely a shorter list. Printing "of 250" for a list holding 31
    // would be a denominator nobody could ever reach.
    const payload = completionPayload(deps({ members: members(31), ownedCount: (ids) => ids.length }));

    for (const c of payload.completions) {
      expect(c.size).toBe(31);
      expect(c.owned).toBe(31);
    }
  });

  test("the year decides which decade lists get a count", () => {
    // The catalogue is generated from a year and the server passes its own clock, so this is
    // the one input that changes the SET of ids in the payload rather than their values.
    const ids = (year: number) =>
      completionPayload(deps({ year, members: members(10) })).completions.map((c) => c.id);

    expect(ids(2026)).toContain("decade-2020");
    expect(ids(2026)).not.toContain("decade-2030");
    expect(ids(2031)).toContain("decade-2030");
  });
});

describe("curated poster strips", () => {
  test("the newest winners we can draw, capped at the strip length", () => {
    const payload = completionPayload(
      deps({ winners: (award) => (award === AWARD ? wins(20) : []), hasPoster: () => true }),
    );

    expect(payload.posters[AWARD]).toHaveLength(POSTER_STRIP);
    expect(payload.posters[AWARD]?.[0]).toEqual({ tconst: "tt-win-0", title: "Winner 0" });
  });

  test("a winner whose artwork we have never resolved is SKIPPED, not sent as a hole", () => {
    // `/img/t/:tconst` resolves an unseen poster through Radarr or Sonarr on first request,
    // so an id we have not looked up is an upstream lookup this index page must not provoke.
    // Skipping rather than including is also what makes every frame in the strip fill.
    const drawable = new Set(["tt-win-3", "tt-win-7"]);
    const payload = completionPayload(
      deps({
        winners: (award) => (award === AWARD ? wins(20) : []),
        hasPoster: (tconst) => drawable.has(tconst),
      }),
    );

    expect(payload.posters[AWARD]?.map((p) => p.tconst)).toEqual(["tt-win-3", "tt-win-7"]);
  });

  test("an award with nothing drawable has NO KEY rather than an empty strip", () => {
    // The same rule the completion counts follow: absent means "nothing to draw here", which
    // every surface already renders as nothing. An empty array would be a second way to say
    // the same thing, and the client would have to know both.
    const payload = completionPayload(deps({ winners: () => wins(20), hasPoster: () => false }));
    expect(payload.posters).toEqual({});
  });
});

describe("people boards", () => {
  /** One credit row per person, so a test can name exactly who is on which board. */
  const tally = (name: string, category: string, titles: number): CreditTally => ({
    nconst: `nm-${name}`,
    name,
    category,
    titles,
  });

  test("ranked over the ALL-TIME membership, and nothing else", () => {
    // The boards are about the two `finderr Top 250` lists, so the ids handed to the credit
    // reader must be exactly those and not every list on the page. Asking the index for them
    // again would be the one avoidable query in this payload.
    let asked: string[] = [];
    completionPayload(
      deps({
        members: (list) => [`tt-${list.id}`],
        credits: (ids) => {
          asked = ids;
          return [];
        },
      }),
    );

    expect(asked).toEqual(["tt-top-250", "tt-top-250-series"]);
  });

  test("actor and actress rank as ONE performer board", () => {
    const payload = completionPayload(
      deps({
        credits: () => [
          tally("Gena Rowlands", "actress", 4),
          tally("Peter Falk", "actor", 3),
          tally("Kelly Reichardt", "director", 6),
        ],
      }),
    );

    const performers = payload.boards.find((b) => b.id === "performers");
    expect(performers?.entries.map((e) => e.name)).toEqual(["Gena Rowlands", "Peter Falk"]);
    expect(payload.boards.find((b) => b.id === "directors")?.entries).toHaveLength(1);
  });

  test("a board nobody is on is not sent, and an index with no credits sends none", () => {
    // An index built before the cast tables answers with nothing at all, and the page draws
    // no People section rather than three empty headings.
    expect(completionPayload(deps()).boards).toEqual([]);

    const payload = completionPayload(deps({ credits: () => [tally("Agnès Varda", "director", 3)] }));
    expect(payload.boards.map((b) => b.id)).toEqual(["directors"]);
  });
});
