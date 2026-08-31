/**
 * The canary suite: the gate that actually matters.
 *
 * A dump can be structurally perfect -- right headers, right row count -- and still
 * wreck results. A tokenizer change, a normalization bug, IMDb re-scoring votes.
 * Nothing except running real queries would catch that, so we run real queries
 * against the candidate index BEFORE promoting it. A bad build never reaches a user.
 *
 * These cases are also the regression suite for the search engine itself.
 */

import type { Config } from "./config";
import { SearchEngine } from "./search";
import { prepareSqlite } from "./spellfix";

export interface CanaryCase {
  query: string;
  /** Case-insensitive substring that must appear in the top hit's title or original title. */
  want: string;
  note?: string;
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
  { query: "interstelar", want: "Interstellar" },
  { query: "izombee", want: "iZombie" },
  { query: "matrics", want: "Matrix" },
  { query: "strager thigs", want: "Stranger Things" },
  { query: "brigerton", want: "Bridgerton" },
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
  total: number;
  ratio: number;
  floor: number;
  failures: { query: string; want: string; got: string; tier: string }[];
  ms: number;
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

  for (const c of CANARY_CASES) {
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

  const ratio = passed / CANARY_CASES.length;
  return {
    ok: ratio >= floor,
    passed,
    total: CANARY_CASES.length,
    ratio,
    floor,
    failures,
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
