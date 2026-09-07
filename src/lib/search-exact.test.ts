/**
 * What happens when the reader types a title's whole name.
 *
 * THE BUG THIS EXISTS FOR, found on the live index 2026-09-05: `heart of the beast` put
 * `tt7526136` -- a film whose title is exactly that string -- at position **112**, behind
 * "In the Heart of the Sea", "Transformers: Rise of the Beasts" and a hundred others. The
 * reader's report was that the film "doesn't show up at all", which at 112 is the same
 * thing.
 *
 * Two separate defects in `rank()` produced it and both are pinned below:
 *
 *   1. The exact-title branch scaled its bonus by votes (`14 * ln(votes+10)/ln(50_000)`),
 *      so at zero votes it paid **2.98** -- LESS than the flat **12** the coverage branch
 *      pays a title that merely contains every query word. The three branches measure the
 *      same thing and the code's own comment says to take the strongest signal, never the
 *      sum; the strongest was silently the weakest.
 *   2. The popularity term spans 5.5 to 30.3 unconditionally, so no exact match on an
 *      unvoted title could clear a popular partial one whatever the first defect did.
 *
 * Tested as POLICY against a handful of rows in a temp file, never against
 * `data/titles.db` -- a test pinned to the real index measures the IMDb dump and goes red
 * on the next rebuild. Same rule `browse.test.ts` and `rank.test.ts` follow. The canary
 * suite is what guards the real corpus, and it stays at 42/42 across this change.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { buildTitleSearchIndex, SCHEMA } from "./index-builder";
import { despace, normalizeStripped } from "./normalize";
import { anticipationWeight } from "./query-parser";
import { popularity, SearchEngine } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-exact-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  tconst: string;
  title: string;
  year: number;
  votes: number;
  kind?: string;
}

/**
 * An index shaped like the real one, down to the normalized columns.
 *
 * The three derived columns are the build's own derivation rather than a test-local
 * approximation: `rank()` compares the query against `ntitle`/`norig` and FTS matches on
 * `dtitle` too, so a fixture that filled them differently would be measuring a different
 * engine from the one that ships.
 */
function engineOf(rows: Row[]): SearchEngine {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  const insert = db.prepare(
    "insert into title (tconst, kind, title, orig, year, votes, rating, genres, ntitle, norig, dtitle) " +
      "values (?,?,?,?,?,?,0,'',?,?,?)",
  );
  for (const r of rows) {
    insert.run(
      r.tconst,
      r.kind ?? "movie",
      r.title,
      r.title,
      r.year,
      r.votes,
      normalizeStripped(r.title),
      normalizeStripped(r.title),
      `${despace(r.title)} ${despace(r.title)}`.trim(),
    );
  }
  buildTitleSearchIndex(db);
  db.close();
  return new SearchEngine(path, loadConfig());
}

/** The live case, reduced: an unvoted exact match against a famous near-miss. */
const HEART_OF_THE_BEAST: Row[] = [
  { tconst: "tt-exact", title: "Heart of the Beast", year: 2026, votes: 0 },
  { tconst: "tt-sea", title: "In the Heart of the Sea", year: 2015, votes: 160_542 },
  { tconst: "tt-transformers", title: "Transformers: Rise of the Beasts", year: 2023, votes: 133_774 },
  { tconst: "tt-whisper", title: "Whisper of the Heart", year: 1995, votes: 84_650 },
];

describe("an exact title match", () => {
  // Relative to the real current year for the reason the anticipation block below gives:
  // `rank()` reads the clock, so a hardcoded year drifts into a different part of the curve.
  const thisYear = new Date().getUTCFullYear();

  test("wins even with no votes at all, against a far more popular partial match", () => {
    // The reported bug, stated as the thing a reader would say: I typed the film's whole
    // name and the film was not on the page. Nothing here is about the 2026 film being
    // good -- it is about "no votes yet" not being evidence that the reader meant
    // something else, when the reader named the title exactly.
    const engine = engineOf(HEART_OF_THE_BEAST);
    try {
      const hits = engine.search("heart of the beast", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-exact");
    } finally {
      engine.close();
    }
  });

  test("is never worth less than merely containing every query word", () => {
    // Defect 1 in isolation, and the reason it is a defect rather than a tuning choice:
    // "the whole title IS the query" strictly implies "every query word appears", so a
    // scoring branch that pays the first less than the second is incoherent whatever the
    // constants are. Both candidates here have the same (zero) popularity, so the branch
    // is the only thing separating them.
    const engine = engineOf([
      { tconst: "tt-exact", title: "Heart of the Beast", year: 2026, votes: 0 },
      { tconst: "tt-covers", title: "The Beast at the Heart of Everything", year: 2026, votes: 0 },
    ]);
    try {
      const hits = engine.search("heart of the beast", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-exact");
    } finally {
      engine.close();
    }
  });

  test("still loses to a BETTER-KNOWN title carrying the same exact name", () => {
    // The guard on the fix. Lifting an unvoted exact match must not flatten the ordering
    // AMONG exact matches -- somebody typing "Dune" means the Dune everybody means, and
    // popularity is the only thing that can say which one that is.
    const engine = engineOf([
      { tconst: "tt-dune-short", title: "Dune", year: 2019, votes: 0 },
      { tconst: "tt-dune-2021", title: "Dune", year: 2021, votes: 850_000 },
      { tconst: "tt-dune-1984", title: "Dune", year: 1984, votes: 187_000 },
    ]);
    try {
      const hits = engine.search("dune", { limit: 10 }).hits;
      expect(hits.map((h) => h.tconst)).toEqual(["tt-dune-2021", "tt-dune-1984", "tt-dune-short"]);
    } finally {
      engine.close();
    }
  });

  test("does not outrank a popular SEQUEL the reader is more likely to mean", () => {
    // The cost of the fix, bounded. An unvoted exact match now clears a popular partial
    // one -- but only just, and a title that both covers the query and is watched by
    // millions still comes first. This is the assertion that would catch a floor set too
    // high: at 50k votes' worth of credit the unvoted short would bury "Part Two".
    const engine = engineOf([
      { tconst: "tt-dune-short", title: "Dune", year: 2019, votes: 0 },
      { tconst: "tt-dune-part-two", title: "Dune: Part Two", year: 2024, votes: 600_000 },
    ]);
    try {
      const hits = engine.search("dune", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-dune-part-two");
    } finally {
      engine.close();
    }
  });

  test("loses to a same-named title with a SMALL but real audience, once both are old", () => {
    // THE GAP THE TEST ABOVE LEAVES OPEN, and the live bug that fell through it. Its rivals
    // carry 187k and 850k votes, both far above the ~2,300 where the unvoted floor used to
    // stop mattering -- so it asserted "votes still decide among exact matches" while votes
    // decided nothing at all anywhere below that line.
    //
    // From the search log, 2026-09-08: two shows called "Reel Rivals", a 2013 one with zero
    // votes and a 2025 one with 25, and a reader who wanted the 2025 one had to look past
    // the 2013 one to find it. Thirteen years with nobody rating it is not an absent
    // measurement, and `anticipationWeight` already says so.
    const engine = engineOf([
      { tconst: "tt-forgotten", title: "Reel Rivals", year: thisYear - 13, votes: 0 },
      { tconst: "tt-small", title: "Reel Rivals", year: thisYear - 1, votes: 25 },
    ]);
    try {
      expect(engine.search("reel rivals", { limit: 5 }).hits[0]?.tconst).toBe("tt-small");
    } finally {
      engine.close();
    }
  });

  test("keeps its lift while it is still NEAR RELEASE, which is the whole of the claim", () => {
    // The other side of the same gate, so nobody reads the test above as "the unvoted lift
    // was deleted". It was dated, not deleted: a title out this year with no votes yet is
    // genuinely unmeasured, and it still beats a same-named title with a small old audience.
    const engine = engineOf([
      { tconst: "tt-soon", title: "Reel Rivals", year: thisYear, votes: 0 },
      { tconst: "tt-small", title: "Reel Rivals", year: thisYear - 13, votes: 25 },
    ]);
    try {
      expect(engine.search("reel rivals", { limit: 5 }).hits[0]?.tconst).toBe("tt-soon");
    } finally {
      engine.close();
    }
  });

  test("an explicit year still beats it, which is the one gate that was already right", () => {
    // `The Matrix 2021` -> Resurrections, canary case and stated intent of the year gate.
    // The fix must not reach around it: an exact match whose year contradicts the query is
    // not treated as exact at all, so nothing here gets a popularity floor either.
    const engine = engineOf([
      { tconst: "tt-matrix", title: "The Matrix", year: 1999, votes: 2_000_000 },
      { tconst: "tt-resurrections", title: "The Matrix Resurrections", year: 2021, votes: 250_000 },
    ]);
    try {
      const hits = engine.search("the matrix 2021", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-resurrections");
    } finally {
      engine.close();
    }
  });
});

/**
 * The anticipation curve, through the whole engine.
 *
 * Years are stated RELATIVE to the real current year, because `rank()` reads the clock and
 * a fixture with hardcoded years would drift into a different part of the curve every
 * January. The curve's own shape is pinned against a fixed `now` in
 * `query-parser.test.ts`; these are about what it does to an ordering.
 */
describe("a title that has not come out yet", () => {
  const thisYear = new Date().getUTCFullYear();

  test("outranks an equally unvoted title from years ago", () => {
    // aannarr, 2026-09-05: a reader is MORE likely to be looking for the new thing. The
    // live index has exactly this pair -- two films called "Heart of the Beast", one from
    // 2017 and one still to come -- and before the curve they scored identically.
    const engine = engineOf([
      { tconst: "tt-old", title: "Heart of the Beast", year: thisYear - 9, votes: 0 },
      { tconst: "tt-soon", title: "Heart of the Beast", year: thisYear, votes: 0 },
    ]);
    try {
      expect(engine.search("heart of the beast", { limit: 5 }).hits[0]?.tconst).toBe("tt-soon");
    } finally {
      engine.close();
    }
  });

  test("a SERIES is anticipated exactly as a film is", () => {
    // aannarr asked for titles, not films. `year` is a first-air year, so a long-running
    // show is never in the future here and nothing needs to know the kind.
    const engine = engineOf([
      { tconst: "tt-film", title: "Ripcurrent", year: thisYear - 9, votes: 0, kind: "movie" },
      { tconst: "tt-series", title: "Ripcurrent", year: thisYear + 1, votes: 0, kind: "tvSeries" },
    ]);
    try {
      expect(engine.search("ripcurrent", { limit: 5 }).hits[0]?.tconst).toBe("tt-series");
    } finally {
      engine.close();
    }
  });

  test("a distant announcement gets no lift, so it cannot jump a real film", () => {
    // The taper's whole job. A slate entry five years out is speculative, and treating it
    // as anticipated would let anything anybody ever announced outrank released work.
    const engine = engineOf([
      { tconst: "tt-slate", title: "Ripcurrent", year: thisYear + 5, votes: 0 },
      { tconst: "tt-real", title: "Ripcurrent", year: thisYear - 20, votes: 4_000 },
    ]);
    try {
      expect(engine.search("ripcurrent", { limit: 5 }).hits[0]?.tconst).toBe("tt-real");
    } finally {
      engine.close();
    }
  });

  test("it cannot outrank a genuinely popular title, which is the bound that matters", () => {
    // The lift is capped at what 1,500 votes are worth, so anything above that line still
    // wins on popularity alone. This is the assertion that fails first if the prior is
    // ever raised carelessly.
    const engine = engineOf([
      { tconst: "tt-soon", title: "Ripcurrent", year: thisYear + 1, votes: 0 },
      { tconst: "tt-loved", title: "Ripcurrent", year: thisYear - 20, votes: 300_000 },
    ]);
    try {
      expect(engine.search("ripcurrent", { limit: 5 }).hits[0]?.tconst).toBe("tt-loved");
    } finally {
      engine.close();
    }
  });

  test("the lift SELF-EXTINGUISHES once the votes it stands in for arrive", () => {
    // `max(0, prior - actual)` rather than an added bonus: a title releasing next year that
    // already has 50k votes is scored on those votes and gets nothing extra, so there is no
    // moment where anticipation and real popularity are both being counted.
    const engine = engineOf([
      { tconst: "tt-soon-big", title: "Ripcurrent", year: thisYear + 1, votes: 50_000 },
      { tconst: "tt-old-big", title: "Ripcurrent", year: thisYear - 20, votes: 50_000 },
    ]);
    try {
      const hits = engine.search("ripcurrent", { limit: 5 }).hits;
      const soon = hits.find((h) => h.tconst === "tt-soon-big");
      const old = hits.find((h) => h.tconst === "tt-old-big");
      // Identical votes, and the only thing left between them is `recencyScore`'s small
      // nudge -- NOT twelve points of anticipation.
      expect((soon?.score ?? 0) - (old?.score ?? 0)).toBeLessThan(2);
    } finally {
      engine.close();
    }
  });
});

describe("the order is TOTAL", () => {
  test("two titles that tie on score do not depend on which arrived first", () => {
    // Score alone left ties to the candidate order out of FTS, which is a bm25-and-votes
    // artefact rather than a decision. Year then tconst makes it total, so the same query
    // twice is the same answer twice -- the rule the rest of this codebase calls fair.
    const rows = [
      { tconst: "tt-b", title: "Ripcurrent", year: 1999, votes: 0 },
      { tconst: "tt-a", title: "Ripcurrent", year: 1999, votes: 0 },
    ];
    const forward = engineOf(rows);
    const backward = engineOf([...rows].reverse());
    try {
      const order = (e: SearchEngine) => e.search("ripcurrent", { limit: 5 }).hits.map((h) => h.tconst);
      expect(order(forward)).toEqual(order(backward));
      expect(order(forward)).toEqual(["tt-a", "tt-b"]);
    } finally {
      forward.close();
      backward.close();
    }
  });
});

/**
 * A PREMIERE MUST NEVER LOOK LIKE A DEMOTION.
 *
 * aannarr, 2026-09-05, naming the one behaviour he did not want: a title that is
 * anticipated, disappears in premiere week, and comes back afterwards. These pin that it
 * cannot happen -- as a property of the scoring shape rather than of today's constants.
 */
describe("a title crossing its own release", () => {
  // THE ENGINE'S OWN `popularity`, not a copy of it. This used to be a re-implementation with
  // the three constants inlined, and it silently drifted: it never carried the unvoted-exact
  // floor the real function applied, so these four tests were pinning a curve nothing shipped.
  // The floor is gone now and the two agree again -- which is exactly the moment to stop
  // keeping two of them.
  const popularityOf = (votes: number, year: number, now: Date) =>
    popularity(votes, anticipationWeight(year, now));

  test("the score only ever RISES as votes arrive through the release year", () => {
    // The heart of it. Through the whole release year the weight is 1, so the blend is
    // max(actual, prior) -- monotonic in votes by construction. A premiere adds votes, so a
    // premiere can only help. Walked across a real mid-year premiere, day by day.
    const release = new Date("2026-06-15T00:00:00Z");
    let previous = Number.NEGATIVE_INFINITY;
    for (let day = 0; day < 365; day++) {
      const on = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
      const elapsed = (on.getTime() - release.getTime()) / 86_400_000;
      const votes = elapsed < 0 ? 0 : Math.round(80_000 * (1 - Math.exp(-elapsed / 30)));
      const score = popularityOf(votes, 2026, on);
      expect(score).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = score;
    }
  });

  test("a title that finds an audience never steps down at the year turn either", () => {
    // Its own votes have overtaken the prior long before New Year, so the weight going from
    // 1 to 0.5 changes a `max(0, ...)` that was already zero. The step only exists for
    // titles the imputation was still carrying.
    const dec31 = new Date("2026-12-31T00:00:00Z");
    const jan1 = new Date("2027-01-01T00:00:00Z");
    expect(popularityOf(60_000, 2026, jan1)).toBeGreaterThanOrEqual(popularityOf(60_000, 2026, dec31) - 1e-9);
  });

  test("the New Year step is BOUNDED for the worst case, a late release nobody rated", () => {
    // This is the one real discontinuity and the reason `PAST_SCALE_YEARS` is 1 rather than
    // 0.5: the calendar grace after release is twelve months for a January title and four
    // days for a 27 December one, so the worst case has to be sized rather than wished away.
    // It was 10.23 points. Anything above 6 means the past scale has been narrowed again.
    const step =
      popularityOf(6, 2026, new Date("2026-12-31T00:00:00Z")) -
      popularityOf(6, 2026, new Date("2027-01-01T00:00:00Z"));
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(6);
  });

  test("and it never comes back: past the release year the curve only decays", () => {
    // The other half of "disappears and comes back". Monotonic decay behind means there is
    // no year in which an unrated title regains anything it lost.
    const votes = 0;
    let previous = Number.POSITIVE_INFINITY;
    for (let year = 2026; year >= 2020; year--) {
      const score = popularityOf(votes, year, new Date("2026-06-01T00:00:00Z"));
      expect(score).toBeLessThanOrEqual(previous + 1e-9);
      previous = score;
    }
  });
});
