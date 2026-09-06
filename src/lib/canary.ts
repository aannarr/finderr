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

import { ioReadBytes } from "./bench-io";
import type { Config } from "./config";
import { type FuzzyAbsence, SearchEngine } from "./search";
import { prepareSqlite } from "./spellfix";

export interface CanaryCase {
  query: string;
  /**
   * Case-insensitive substring that must appear in the top hit's title or original title.
   *
   * **`null` means the search must find NOTHING**, and that is a real assertion rather than an
   * absent one. The fuzzy tier hands `rank()` up to 300 candidates and `rank()` scores them
   * mostly on votes, so a query with no match anywhere in the corpus used to return a
   * confident page of blockbusters -- `"andrenochrome"` returned Ender's Game, Andrei Rublev
   * and Antichrist, none of them within three edits of anything the reader typed. A suite that
   * can only say "the top hit must be X" cannot express the one thing that was wrong, so it
   * stayed 42/42 green through the whole bug.
   */
  want: string | null;
  note?: string;
  /**
   * Ceiling for THIS query in ms, over `CASE_BUDGET_MS`.
   *
   * Accuracy and cost are one question here: a fix that finds the right title by widening the
   * search until it scans the vocabulary is not a fix. Raising a budget is allowed and is
   * meant to be a visible edit with a measured number beside it -- never a silent drift.
   */
  budgetMs?: number;
  /**
   * Only answerable by the fuzzy tier -- MEASURED, not assumed.
   *
   * Set on exactly the cases that miss when `spellfix1` is absent, checked against the real
   * index -- five of them on 2026-09-05 and `andrenochrome` added on 2026-09-06, measured the
   * same way: with the extension it resolves, and with the extension gone it returns nothing
   * at all rather than the wrong thing. Most typos are NOT here -- `seven samuri` and `lord of
   * the rigns` are still found by FTS -- so an absent extension still leaves the large
   * majority of the suite doing real work. Re-measure before adding one; guessing which typos
   * need the tier is how the suite quietly stops testing things.
   *
   * A `want: null` case is never marked here. FTS finds nothing for nonsense too, so those
   * pass with or without the tier; `canary.test.ts` pins that.
   */
  fuzzyOnly?: true;
}

/**
 * The default ceiling for one query, in ms.
 *
 * MEASURED, not chosen: on the real 1.28M-row index (M1 Max, 2026-09-06) the slowest of the
 * original 42 was 176 ms and the median was single-digit. 400 leaves room for the two-stage
 * fuzzy escalation, which only a query with no close match ever pays for, and still fails
 * loudly on anything that starts scanning the vocabulary.
 *
 * A case needing more says so with `budgetMs` and a number somebody read off a machine.
 */
export const CASE_BUDGET_MS = 400;

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

  // --- a typo the PHONETIC SHORTLIST misses, and the junk it used to return instead
  //
  // Reported by aannarr on 2026-09-06 against the live deployment. `adrenochrome` is ONE edit
  // from the query (`editdist3` says 100) and is in the vocabulary -- and spellfix1 at its
  // default scope (three hash characters in the vendored source) did not return it among 300
  // candidates, because the shortlist is a scan of words sharing that PHONETIC prefix and the
  // inserted `n` moves the hash from `ADRMACRMA` to `AMDRMACRMA`. A letter added near the
  // front of a word leaves the bucket entirely, so no amount of ranking could have recovered
  // it. The trigram shortlist (`./vocab-trigrams.ts`) is what answers it now; an index built
  // before that table falls back to the wide `scope = 1` retry.
  {
    query: "andrenochrome",
    want: "Adrenochrome",
    fuzzyOnly: true,
    note: "1 edit away, but a different phonetic bucket -- needs the trigram shortlist (or the legacy wide retry)",
  },
  {
    query: "the godfater",
    want: "Godfather",
    note: "REGRESSION GUARD: scope=4 finds nothing within the distance floor here, yet the earlier tiers answer it correctly. The floor must not touch this.",
  },

  // --- nonsense must find NOTHING, and this is the assertion the suite could not make
  //
  // Both of these returned a confident first page before the floor existed, because the fuzzy
  // tier handed `rank()` 300 unrelated candidates and `rank()` scores mostly on votes. Neither
  // string is within three edits of anything in the corpus. Measured 2026-09-06.
  // They are deliberately NOT `fuzzyOnly`: with no fuzzy tier FTS finds nothing and they pass
  // trivially, so they are answerable either way and marking them would be the guess this
  // field's own note warns about. They only have anything to CATCH when the tier is present.
  { query: "xyzzyplughfoo", want: null, note: "returned Casablanca" },
  { query: "qwertzuiopasdf", want: null, note: "returned Spirited Away" },
];

export interface CanaryResult {
  ok: boolean;
  passed: number;
  /** Cases actually RUN. Below `CANARY_CASES.length` only when `degraded` says why. */
  total: number;
  ratio: number;
  floor: number;
  failures: { query: string; want: string; got: string; tier: string }[];
  /**
   * Cases that answered correctly but took longer than their budget.
   *
   * SEPARATE FROM `failures` on purpose. They are two different verdicts with two different
   * remedies -- a wrong hit is a ranking or candidate bug, a slow one is a cost bug -- and
   * folding a timing breach into the accuracy ratio would let a 90% floor absorb it silently.
   * Both block `ok`.
   */
  slow: { query: string; ms: number; budgetMs: number }[];
  /** Every case that ran, slowest first. The table this suite is meant to be filled with. */
  timings: { query: string; ms: number; tier: string }[];
  /**
   * Bytes this process pulled off the BLOCK DEVICE during the run, or null where unknowable.
   *
   * `ioReadBytes` is the owner of both the reading and the honesty: Linux only, and null
   * rather than 0 on macOS, because a zero would read as "no I/O happened" when it means "we
   * cannot see". Reused rather than reimplemented -- the same primitive every bench here uses.
   */
  readBytes: number | null;
  /** Cases that could not run at all. Empty whenever `degraded` is null. */
  skipped: { query: string; want: string | null }[];
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
  const io0 = ioReadBytes();
  const failures: CanaryResult["failures"] = [];
  const slow: CanaryResult["slow"] = [];
  const timings: CanaryResult["timings"] = [];
  let passed = 0;

  // Asked ONCE, before the loop: whether the fuzzy tier exists is a property of the engine,
  // not of a query, and re-deriving it per case would invite the two answers to disagree.
  const absence = engine.fuzzyOff;
  const skipped = absence ? CANARY_CASES.filter((c) => c.fuzzyOnly) : [];
  const runnable = absence ? CANARY_CASES.filter((c) => !c.fuzzyOnly) : CANARY_CASES;

  for (const c of runnable) {
    const t = Bun.nanoseconds();
    const res = engine.search(c.query, { limit: 5, facets: false });
    const ms = (Bun.nanoseconds() - t) / 1e6;
    timings.push({ query: c.query, ms, tier: res.tier });

    const top = res.hits[0];
    const hay = top ? `${top.title} ${top.orig ?? ""}`.toLowerCase() : "";
    // `want: null` asks the opposite question -- did we correctly find NOTHING -- so the
    // substring test cannot express it and must not be reached for those cases.
    const hit =
      c.want === null ? res.hits.length === 0 : top !== undefined && hay.includes(c.want.toLowerCase());

    if (hit) {
      passed++;
      // A case is only timed once it is CORRECT. Reporting a budget breach on a query that
      // returned the wrong title would send a reader after the cost of an answer nobody
      // wants; fix the answer, then measure it.
      const budget = c.budgetMs ?? CASE_BUDGET_MS;
      if (ms > budget) slow.push({ query: c.query, ms, budgetMs: budget });
    } else {
      failures.push({
        query: c.query,
        want: c.want ?? "(nothing)",
        got: top ? `${top.title} (${top.year})` : "(nothing)",
        tier: res.tier,
      });
    }
  }

  // `runnable` is never empty in practice -- only the five fuzzy-only cases can be skipped
  // -- but a suite that scored 0/0 as 100% would be a gate that passes by having nothing to
  // measure, which is the exact failure mode this file exists to prevent.
  const ratio = runnable.length === 0 ? 0 : passed / runnable.length;
  const io1 = ioReadBytes();
  return {
    // A budget breach is not graded on a curve. The accuracy floor tolerates a share of
    // misses because ranking is a judgement call; a query that got slower is a fact, and one
    // of them is enough to fail the run.
    ok: runnable.length > 0 && ratio >= floor && slow.length === 0,
    passed,
    total: runnable.length,
    ratio,
    floor,
    failures,
    slow,
    timings: timings.sort((a, b) => b.ms - a.ms),
    readBytes: io0 !== null && io1 !== null ? io1 - io0 : null,
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
