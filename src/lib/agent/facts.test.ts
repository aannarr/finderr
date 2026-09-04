/**
 * What must survive compaction.
 *
 * These are not format assertions. Compaction throws information away on purpose, so the
 * question each test asks is "would the model still do the right thing?" -- and the answers
 * that matter most are the three HONEST-EMPTY signals. `loose_would_match`,
 * `hidden_by_floor` and `budget_exhausted` exist so a model cannot mistake "we stopped
 * looking" for "it does not exist"; a distillation that dropped them would recreate the
 * exact failure the whole tool surface was built to prevent, and it would do it silently.
 */

import { describe, expect, test } from "bun:test";
import { callSignature, factsFrom, ledgerMessage } from "./facts";

describe("the honest-empty signals survive", () => {
  test("loose_would_match keeps its count AND the instruction to retry", () => {
    const lines = factsFrom(
      "find_title",
      { name: "Furius" },
      { found: [], searched: "Furius", loose_would_match: 3 },
    ).join("\n");
    expect(lines).toContain("3");
    expect(lines).toContain('match:"loose"');
    expect(lines).toContain("RETRY");
  });

  test("a genuinely absent title is stated as absent, with no retry advice", () => {
    const lines = factsFrom("find_title", { name: "Zbrlqx" }, { found: [], searched: "Zbrlqx" }).join("\n");
    expect(lines).toContain("not in the index");
    expect(lines).not.toContain("RETRY");
  });

  test("hidden_by_floor survives with the escape hatch, not as 'no results'", () => {
    const lines = factsFrom(
      "browse_titles",
      { year: 1901 },
      { titles: [], total: 0, hidden_by_floor: { titles: 1132, min_votes: 1000 } },
    ).join("\n");
    expect(lines).toContain("1132");
    expect(lines).toContain("min_votes:0");
    // Not a negative match on "nothing matches" -- the line legitimately contains that
    // phrase as the INSTRUCTION ("do not report that nothing matches"). Asserting its
    // absence was a test that would have failed the correct behaviour.
    expect(lines).toContain("RETRY");
    expect(lines).toContain("do not report");
  });

  test("budget_exhausted keeps the resume handle and refuses to read as 'unconnected'", () => {
    const lines = factsFrom(
      "find_connections",
      { from: "tt1", to: "tt2" },
      { paths: [], spent: 100, status: "budget_exhausted", resume: "abc123" },
    ).join("\n");
    expect(lines).toContain("abc123");
    expect(lines).toContain("does NOT mean they are unconnected");
  });

  test("a COMPLETE walk with no paths is stated as a real answer, not as a budget problem", () => {
    const lines = factsFrom(
      "find_connections",
      { from: "tt1", to: "tt2" },
      { paths: [], spent: 12, status: "complete" },
    ).join("\n");
    expect(lines).toContain("genuinely no connection");
    expect(lines).not.toContain("resume");
  });

  test("an error keeps the refusal verbatim, because it names the tool that fixes it", () => {
    const lines = factsFrom("list_cast", {}, { error: "Expected tt… ids -- call find_title first." }).join(
      "\n",
    );
    expect(lines).toContain("find_title");
  });
});

describe("ids and the facts a later turn needs", () => {
  test("a resolved title keeps its id, year and kind on one line", () => {
    const lines = factsFrom(
      "find_title",
      { name: "Furious" },
      {
        found: [{ tconst: "tt36303968", title: "Furious", year: 2026, kind: "tvSeries", votes: 14556 }],
        searched: "Furious",
      },
    ).join("\n");
    expect(lines).toContain("tt36303968");
    expect(lines).toContain("Furious");
    expect(lines).toContain("2026");
    expect(lines).toContain("tvSeries");
  });

  test("a person keeps the birth year, which is the whole disambiguator", () => {
    const lines = factsFrom(
      "find_person",
      { name: "Emmy Rossum" },
      {
        found: [{ nconst: "nm0002536", name: "Emmy Rossum", birth_year: 1986, death_year: null }],
        searched: "Emmy Rossum",
      },
    ).join("\n");
    expect(lines).toContain("nm0002536");
    expect(lines).toContain("b.1986");
  });

  test("a connection path keeps every id in it, so the answer can cite them", () => {
    const lines = factsFrom(
      "find_connections",
      { from: "tt36303968", to: "tt14452776" },
      {
        paths: [
          {
            path: [
              { id: "tt36303968", name: "Furious", kind: "title" },
              { id: "nm0002536", name: "Emmy Rossum", kind: "person" },
              { id: "tt1586680", name: "Shameless", kind: "title" },
            ],
            strength: 338017,
          },
        ],
        spent: 8,
        status: "complete",
      },
    ).join("\n");
    for (const id of ["tt36303968", "nm0002536", "tt1586680"]) expect(lines).toContain(id);
  });

  test("compaction is a real reduction, not a reformatting", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      nconst: `nm${1000000 + i}`,
      name: `Person Number ${i}`,
      role: "actor",
      billing: i + 1,
      seen_in: ["tt36303968"],
    }));
    const raw = JSON.stringify(rows).length;
    const compacted = factsFrom("list_cast", { tconst: ["tt36303968"] }, rows).join("\n").length;
    expect(compacted).toBeLessThan(raw * 0.75);
  });
});

describe("the ledger", () => {
  test("lists the calls already made, which is what stops a model re-resolving", () => {
    const msg = ledgerMessage(["tt1 = a"], ['find_title(name="Furious")']);
    expect(msg).toContain("do not repeat");
    expect(msg).toContain('find_title(name="Furious")');
  });

  test("omits the call list entirely when there is nothing to forbid", () => {
    expect(ledgerMessage(["tt1 = a"], [])).not.toContain("do not repeat");
  });

  test("a call signature spells arrays out, so two different id sets never look alike", () => {
    expect(callSignature("list_cast", { tconst: ["tt1", "tt2"] })).toBe("list_cast(tconst=[tt1,tt2])");
  });
});
