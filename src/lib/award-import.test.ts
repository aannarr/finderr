/**
 * The registry's invariants, and the mapping from a SPARQL answer to stored rows.
 *
 * Two things worth pinning and no third. The REGISTRY is data a route table and a list
 * catalogue both read, so a malformed entry is a 404 or a dead link rather than an exception
 * anybody would see in a log. The MAPPING is where a public database's answer becomes rows
 * this product asserts as fact, and the interesting cases are the ones it refuses.
 *
 * No network anywhere: `fetch` is injected and the fixtures are the shapes the live endpoint
 * returned on 2026-09-03, trimmed.
 */

import { describe, expect, test } from "bun:test";
import { loadAward, wikidataNominations } from "./award-import";
import {
  AWARDS,
  type AwardDef,
  anchorNoun,
  awardById,
  OSCARS,
  oscarsDef,
  winnerQuery,
} from "./award-registry";
import { AWARDS_HEADER } from "./awards";
import type { SparqlRow } from "./wikidata";

const palme = awardById("palme-dor") as AwardDef;

describe("the award registry", () => {
  test("ids are unique and safe in a URL segment", () => {
    // The id is the `award` column, the route parameter and the curated row's key at once.
    // A duplicate would silently merge two awards' rows; a slash would split the segment.
    expect(new Set(AWARDS.map((a) => a.id)).size).toBe(AWARDS.length);
    for (const a of AWARDS) expect(encodeURIComponent(a.id)).toBe(a.id);
  });

  test("an award with no anchor category files its rows under a single one", () => {
    // The two halves of the same decision. `anchorCategory: null` says "there is nothing to
    // filter by"; `singleCategory` is what the import then writes into the column the
    // ceremony page groups on. One without the other is a table of rows with no category, or
    // a timeline that anchors on nothing.
    for (const a of AWARDS) {
      if (a.anchorCategory === null) expect(a.singleCategory).not.toBeNull();
      else expect(a.singleCategory).toBeNull();
    }
  });

  test("a single category's label is its key re-cased and nothing else", () => {
    // The pair exists because title case cannot spell `Palme d'Or`, and it is safe to write
    // twice only while the two stay the same WORDS: a label that reworded the category would
    // make a ceremony heading and the row it heads look like two different prizes. Sundance is
    // the reason this compares upper case rather than `prettyCategory` -- its `anchorLabel`
    // reorders the words on purpose, and its `singleCategory.label` must not.
    for (const a of AWARDS) {
      if (a.singleCategory === null) continue;
      expect(a.singleCategory.label.toUpperCase()).toBe(a.singleCategory.key);
    }
  });

  test("every wikidata query selects the three columns the importer reads", () => {
    // The contract between the queries and `wikidataNominations`. A query that renamed a
    // column would import zero rows and report success.
    for (const a of AWARDS) {
      if (a.source.kind !== "wikidata") continue;
      for (const column of ["?year", "?imdb", "?label"]) {
        expect(a.source.query).toContain(column);
      }
    }
  });

  test("every wikidata query REQUIRES an edition, so no row lands on a timeline it guessed", () => {
    // The honesty rule, as an assertion rather than as a paragraph seven entries have to
    // remember. A `pq:P585` inside an OPTIONAL admits rows with no point in time, and
    // `wikidataNominations` would then drop them silently -- a list quietly shorter than the
    // count in its own comment. Requiring the qualifier is what keeps the two agreeing.
    for (const a of AWARDS) {
      if (a.source.kind !== "wikidata") continue;
      expect(a.source.query).toContain("pq:P585");
      expect(a.source.query).not.toContain("OPTIONAL");
    }
  });

  test("every wikidata query keeps people out of a list of films", () => {
    // P166 is stated on the PEOPLE who received a prize as often as on the works: measured
    // 2026-09-06 the BAFTA carries 36 person rows against 30 film rows, and Venice 61 against
    // 66, because the Golden Lion for Lifetime Achievement is filed under the same item.
    // Without the filter every one of those opens the list.
    for (const a of AWARDS) {
      if (a.source.kind !== "wikidata") continue;
      expect(a.source.query).toContain(`STRSTARTS(?imdb, "tt")`);
    }
  });

  test("winnerQuery asks about the award item it was handed, and only excludes shorts on request", () => {
    // The one seam where a copy-paste would ask the wrong award's question and still return
    // rows -- a list of the wrong festival's winners under the right heading.
    expect(winnerQuery("Q42")).toContain("ps:P166 wd:Q42");
    expect(winnerQuery("Q42")).not.toContain("wd:Q24862");
    expect(winnerQuery("Q42", { excludeShorts: true })).toContain(
      "FILTER NOT EXISTS { ?work wdt:P31 wd:Q24862 }",
    );
  });

  test("the completion noun is built from the anchor label, once", () => {
    expect(anchorNoun(oscarsDef())).toBe("Best Picture winners");
    expect(anchorNoun(palme)).toBe("Palme d'Or winners");
  });

  test("the Oscars are still resolvable by name, because a dozen call sites want them", () => {
    expect(oscarsDef().id).toBe(OSCARS);
    expect(awardById("no-such-award")).toBeUndefined();
  });
});

describe("wikidataNominations", () => {
  const rows: SparqlRow[] = [
    { year: "1993", imdb: "tt0106332", label: "Farewell My Concubine" },
    { year: "1993", imdb: "tt0107822", label: "The Piano" },
    { year: "1994", imdb: "tt0110912", label: "Pulp Fiction" },
  ];

  test("one row per win, keyed on the year and numbered within it", () => {
    // Cannes has split the Palme nine times, so two rows in one edition is the data. `seq`
    // makes the pair a tie rather than a primary-key collision that loses one of them.
    const out = wikidataNominations(rows, palme);
    expect(out.map((n) => [n.ceremony, n.seq])).toEqual([
      [1993, 0],
      [1993, 1],
      [1994, 0],
    ]);
    expect(out.every((n) => n.won)).toBe(true);
    expect(out[0]).toMatchObject({
      award: palme.id,
      year: "1993",
      category: "PALME D'OR",
      films: ["Farewell My Concubine"],
      filmIds: ["tt0106332"],
    });
  });

  test("no nominees, ever -- the source names winners and nothing else", () => {
    // `P166` is "award received". There is no nominee list behind it, so inventing the
    // director as one would put a Palme d'Or on a person page Wikidata never said won one.
    for (const n of wikidataNominations(rows, palme)) {
      expect(n.nominees).toEqual([]);
      expect(n.nconsts).toEqual([]);
    }
  });

  test("a row with no year is dropped rather than filed under a guess", () => {
    // Two real rows behave like this -- Neecha Nagar and Scarecrow carry no point in time on
    // Wikidata. The year is the edition key the timeline is built on, so a defaulted one
    // would put a film under a heading that is simply wrong.
    const out = wikidataNominations([{ imdb: "tt0070643", label: "Scarecrow" }, ...rows], palme);
    expect(out).toHaveLength(3);
    expect(out.map((n) => n.films[0])).not.toContain("Scarecrow");
  });

  test("a person id is dropped, because P166 is stated on directors too", () => {
    // The trap the queries filter for and this catches if one ever stops: the unfiltered
    // Palme d'Or answer opens with Fellini and Buñuel, whose P345 is an `nm` id.
    const out = wikidataNominations([{ year: "1960", imdb: "nm0000019", label: "Federico Fellini" }], palme);
    expect(out).toEqual([]);
  });

  test("a row with no label keeps its id as the printed name", () => {
    // One real row has no label in any language we asked for. The id is a worse name than a
    // title and a better one than an empty string, and the page links it either way.
    const out = wikidataNominations([{ year: "1965", imdb: "tt0059362" }], palme);
    expect(out[0]?.films).toEqual(["tt0059362"]);
  });

  test("refuses an award that has no category to file rows under", () => {
    // The registry pairs `anchorCategory: null` with a `singleCategory`, and the test above
    // holds that. This is what happens if somebody breaks the pair: loud, at import, rather
    // than a table of rows the ceremony page groups under the empty string.
    expect(() => wikidataNominations(rows, { ...palme, singleCategory: null })).toThrow(/singleCategory/);
  });
});

describe("loadAward", () => {
  test("a wikidata award records the query and no revision", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "",
        json: async () => ({
          results: { bindings: [{ year: { value: "1994" }, imdb: { value: "tt0110912" } }] },
        }),
      }) as Response) as unknown as typeof fetch;

    const { rows, meta } = await loadAward(palme, {
      fetchImpl,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });

    expect(rows).toHaveLength(1);
    // No commit exists to name, so the honest provenance is the question and the moment.
    expect(meta.sha).toBeNull();
    expect(meta.sourceDate).toBeNull();
    expect(meta.query).toBe((palme.source as { query: string }).query);
    expect(meta.importedAt).toBe("2026-09-03T10:00:00.000Z");
    expect(meta.licence).toBe("CC0-1.0");
  });

  test("an oscar_data award pins the commit it actually read from", async () => {
    const calls: string[] = [];
    // One fake answering both calls: the commits API reads `json`, the raw file reads `text`.
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        statusText: "",
        json: async () => [{ sha: "abc123def456", commit: { committer: { date: "2026-03-11T00:00:00Z" } } }],
        text: async () =>
          `${AWARDS_HEADER}\n98\t2025\tTitle\tBEST PICTURE\tBEST PICTURE\tAnora\ttt28607951\t\t\t\tTrue`,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { rows, meta } = await loadAward(oscarsDef(), { fetchImpl });

    expect(rows).toHaveLength(1);
    expect(meta.sha).toBe("abc123def456");
    // Read AT the sha, never from `main` with the sha recorded beside it -- that would be a
    // provenance line naming a commit we did not parse.
    expect(calls[1]).toContain("/abc123def456/");
    expect(meta.query).toBeNull();
  });
});
