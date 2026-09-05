/**
 * The canary suite: the gate that actually matters.
 *
 * A dump can be structurally perfect -- right headers, right row count -- and still
 * wreck results. A tokenizer change, a normalization bug, IMDb re-scoring votes.
 * Nothing except running real queries would catch that, so we run real queries
 * against the candidate index BEFORE promoting it. A bad build never reaches a user.
 *
 * These cases are also the regression suite for the search engine itself.
 *
 * > [!IMPORTANT] A MISSING CAPABILITY IS NOT A RANKING REGRESSION
 * > `spellfix1.dylib` is a gitignored build artifact, so a FRESH WORKTREE does not have one
 * > and the fuzzy tier is structurally absent there. This suite used to answer that with
 * > `FAIL 37/42` and five typo queries listed as misses -- which reads exactly like a
 * > ranking bug the reader just wrote, and cost one seat a hunt through `rank()` for a bug
 * > that was never there. Cases that CANNOT run without the tier are now skipped and named
 * > (`skipped`, `degraded`) instead of scored, so the number means what it says.
 */

import type { Config } from "./config";
import { type FuzzyAbsence, SearchEngine } from "./search";
import { prepareSqlite } from "./spellfix";

export interface CanaryCase {
  query: string;
  /** Case-insensitive substring that must appear in the top hit's title or original title. */
  want: string;
  note?: string;
  /**
   * Only answerable by the fuzzy tier -- MEASURED, not assumed.
   *
   * Set on exactly the cases that miss when `spellfix1` is absent, checked against the real
   * 1.27M-row index on 2026-09-05: with the extension 42/42, without it these five and only
   * these five. Most typos are NOT here -- `seven samuri` and `lord of the rigns` are still
   * found by FTS -- so an absent extension still leaves 37 cases doing real work. Re-measure
   * before adding one; guessing which typos need the tier is how the suite quietly stops
   * testing things.
   */
  fuzzyOnly?: true;
}

export const CANARY_CASES: CanaryCase[] = [
  // --- exact and near-exact
  { query: "Silo", want: "Silo" },
  { query: "iZombie", want: "iZombie" },
  { query: "Bridgerton", want: "Bridgerton" },
  { query: "Interstellar", want: "Interstellar" },
  {
    query: "Solstollarna",
    want: "Solstollarna",
    note: "122 votes -- guards the fuzzy pool floor",
  },

  // --- popularity ranking: the common title must beat the obscure one
  { query: "The Matrix", want: "The Matrix" },
  { query: "Dune", want: "Dune" },
  { query: "The Office", want: "Office" },

  // --- year understanding
  { query: "The Matrix 1999", want: "The Matrix" },
  {
    query: "The Matrix 2021",
    want: "Resurrections",
    note: "year must beat the exact-title bonus",
  },
  { query: "dune 1984", want: "Dune" },
  { query: "dune 2021", want: "Dune" },
  { query: "twin peaks 1990", want: "Twin Peaks" },
  {
    query: "blade runner 2049",
    want: "Blade Runner 2049",
    note: "2049 is the title, not a year",
  },

  // --- type and season hints
  { query: "Silo series", want: "Silo" },
  { query: "stranger things s3", want: "Stranger Things" },
  { query: "the office tv series", want: "Office" },
  {
    query: "bridgerton 1080p x265",
    want: "Bridgerton",
    note: "release junk must be stripped",
  },

  // --- typos
  { query: "interstelar", want: "Interstellar", fuzzyOnly: true },
  { query: "izombee", want: "iZombie", fuzzyOnly: true },
  { query: "matrics", want: "Matrix", fuzzyOnly: true },
  { query: "strager thigs", want: "Stranger Things", fuzzyOnly: true },
  { query: "brigerton", want: "Bridgerton", fuzzyOnly: true },
  { query: "inglorius basterds", want: "Inglourious" },
  { query: "eternl sunshien of the spotles mind", want: "Eternal Sunshine" },
  { query: "seven samuri", want: "Seven Samurai" },
  { query: "lord of the rigns", want: "Lord of the Rings" },

  // --- word splits and joins
  { query: "budapest hotell", want: "Grand Budapest" },
  {
    query: "Budapest Hostel",
    want: "Grand Budapest",
    note: "typo + word order + missing word",
  },
  {
    query: "Nile City",
    want: "NileCity",
    note: "user adds a space the title does not have",
  },

  // --- unicode
  { query: "wall e", want: "WALL", note: "interpunct in WALL-E" },
  { query: "alien 1992", want: "Alien", note: "superscript 3 via NFKD" },

  // --- non-English originals resolved through originalTitle
  { query: "Låt den rätte komma in", want: "Right One In" },
  { query: "lat den ratte", want: "Right One In", note: "diacritics dropped" },
  { query: "fuckin amal", want: "Show Me Love" },
  { query: "En man som heter Ove", want: "Ove" },
  { query: "Hundraåringen", want: "100 Year-Old" },
  { query: "Jägarna", want: "Hunters" },
  { query: "jagarna", want: "Hunters" },
  { query: "Ondskan", want: "Evil" },
  { query: "Solsidan", want: "Solsidan" },
  { query: "Bron 2011", want: "Bridge" },
];

export interface CanaryResult {
  ok: boolean;
  passed: number;
  /** Cases actually RUN. Below `CANARY_CASES.length` only when `degraded` says why. */
  total: number;
  ratio: number;
  floor: number;
  failures: { query: string; want: string; got: string; tier: string }[];
  /** Cases that could not run at all. Empty whenever `degraded` is null. */
  skipped: { query: string; want: string }[];
  /**
   * What was missing, and which cases went with it -- or null when the whole suite ran.
   *
   * The ONE place this wording lives; `build-index`, `LiveIndex` and the `canary` job all
   * print this string rather than composing their own account of the same absence.
   */
  degraded: string | null;
  ms: number;
}

/** The `degraded` line: the cause, its remedy, and exactly what stopped being measured. */
function degradedLine(absence: FuzzyAbsence, skipped: readonly CanaryCase[]): string {
  const queries = skipped.map((c) => `"${c.query}"`).join(", ");
  return (
    `fuzzy tier absent -- ${absence.detail}. ` +
    `Excluded from the score rather than counted as ranking failures: ${queries}.`
  );
}

/**
 * The 42 cases against an engine SOMEBODY ELSE owns.
 *
 * Split out of `runCanary` so the same gate can be pointed at a live engine, not only
 * at a path. `LiveIndex` (`src/server/live-index.ts`) validates a candidate engine with
 * this before swapping it in, and validating the instance it is about to serve from is
 * the whole point -- opening a second connection to the same file would prove the FILE
 * is good while saying nothing about the engine that was actually constructed.
 *
 * It does NOT close the engine and it does NOT call `prepareSqlite`. Both belong to
 * whoever opened the thing.
 */
export function runCanaryOn(engine: SearchEngine, floor = 0.9): CanaryResult {
  const t0 = Bun.nanoseconds();
  const failures: CanaryResult["failures"] = [];
  let passed = 0;

  // Asked ONCE, before the loop: whether the fuzzy tier exists is a property of the engine,
  // not of a query, and re-deriving it per case would invite the two answers to disagree.
  const absence = engine.fuzzyOff;
  const skipped = absence ? CANARY_CASES.filter((c) => c.fuzzyOnly) : [];
  const runnable = absence ? CANARY_CASES.filter((c) => !c.fuzzyOnly) : CANARY_CASES;

  for (const c of runnable) {
    const res = engine.search(c.query, { limit: 5, facets: false });
    const top = res.hits[0];
    const hay = top ? `${top.title} ${top.orig ?? ""}`.toLowerCase() : "";
    if (top && hay.includes(c.want.toLowerCase())) {
      passed++;
    } else {
      failures.push({
        query: c.query,
        want: c.want,
        got: top ? `${top.title} (${top.year})` : "(nothing)",
        tier: res.tier,
      });
    }
  }

  // `runnable` is never empty in practice -- only the five fuzzy-only cases can be skipped
  // -- but a suite that scored 0/0 as 100% would be a gate that passes by having nothing to
  // measure, which is the exact failure mode this file exists to prevent.
  const ratio = runnable.length === 0 ? 0 : passed / runnable.length;
  return {
    ok: runnable.length > 0 && ratio >= floor,
    passed,
    total: runnable.length,
    ratio,
    floor,
    failures,
    skipped: skipped.map((c) => ({ query: c.query, want: c.want })),
    degraded: absence ? degradedLine(absence, skipped) : null,
    ms: (Bun.nanoseconds() - t0) / 1e6,
  };
}

/** The same gate, against a file this function opens and closes itself. */
export function runCanary(dbPath: string, cfg: Config, floor = 0.9): CanaryResult {
  // Before the SearchEngine opens anything: on macOS the fuzzy tier needs a libsqlite3
  // that permits extensions, and that choice is process-global and cannot be made once
  // a connection exists. Without it every typo case here fails for the wrong reason.
  prepareSqlite();
  const engine = new SearchEngine(dbPath, cfg);
  engine.prepareFuzzy();
  try {
    return runCanaryOn(engine, floor);
  } finally {
    engine.close();
  }
}
