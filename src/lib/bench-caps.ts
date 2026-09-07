/**
 * WHAT THIS INDEX AND THIS PROCESS CAN ACTUALLY DO -- one owner, both bench harnesses.
 *
 * `src/jobs/bench-index.ts` and `src/jobs/bench-memory.ts` run the SAME `scenarios()` list
 * against the same engine, so they need the same answer to "was the fuzzy tier there when
 * these numbers were taken?". This module is that answer: the field set, the wording of the
 * header lines, and the loud warning are defined once and printed identically by both.
 *
 * > [!IMPORTANT] `fuzzy` is here because a report of an ABSENT tier is otherwise identical to a fast one
 * > `search.fuzzy` comes back in microseconds either way -- 0.03 ms for a tier that returned
 * > `tier: "empty"` and zero candidates. Loading spellfix1 correctly is not enough on its own:
 * > the harness would still be silently wrong anywhere `prepareSqlite` finds no libsqlite3
 * > that permits extensions, or where the index carries no vocabulary -- a container, a CI
 * > runner, a fresh clone. Printing the capability is what makes two reports comparable
 * > instead of merely similar.
 *
 * `fuzzy` is a string rather than a boolean, because WHICH of the three things the tier needs
 * is missing decides the remedy -- see `FuzzyAbsence` in `search.ts`, which is the one owner
 * of that distinction and of the sentence explaining each cause.
 */

import type { FuzzyAbsence } from "./search";

/**
 * The slice of a `SearchEngine` this module reads.
 *
 * Narrower than the engine on purpose: capabilities are five readonly flags, so depending on
 * the whole class would mean a test needs a real index on disk to assert on a header line.
 * `SearchEngine` satisfies this structurally, with no declaration on its side.
 */
export interface CapabilitySource {
  readonly hasRank: boolean;
  readonly hasPeople: boolean;
  readonly hasIds: boolean;
  readonly hasEpisodes: boolean;
  readonly fuzzyOff: FuzzyAbsence | null;
}

/** What a harness carries into its `--json`, so a cell diffed months later still says. */
export interface BenchCapabilities {
  rank: boolean;
  people: boolean;
  ids: boolean;
  episodes: boolean;
  /** `on`, or `off:extension` / `off:vocabulary` / `off:unprepared`. */
  fuzzy: string;
}

export interface BenchCapabilityReport {
  caps: BenchCapabilities;
  /** Preamble lines to print verbatim, already `#`-prefixed like the rest of the header. */
  lines: string[];
}

/**
 * The capabilities and the exact lines that report them, together.
 *
 * Returned as one value rather than exposed as two functions because the header and the JSON
 * are two views of ONE reading: a harness that took them separately could print `fuzzy=on`
 * above a JSON that said otherwise, which is precisely the class of lie this file exists to
 * stop.
 */
export function readCapabilities(engine: CapabilitySource): BenchCapabilityReport {
  const absence = engine.fuzzyOff;
  const caps: BenchCapabilities = {
    rank: engine.hasRank,
    people: engine.hasPeople,
    ids: engine.hasIds,
    episodes: engine.hasEpisodes,
    fuzzy: absence ? `off:${absence.cause}` : "on",
  };
  const lines = [
    `# caps: rank=${caps.rank} people=${caps.people} ids=${caps.ids} ` +
      `episodes=${caps.episodes} fuzzy=${caps.fuzzy}`,
  ];
  if (absence) {
    // Loud, and not fatal -- the `# !! PROFILE DRIFT` shape. Every other scenario still
    // produces a usable number; the one that cannot be quoted without this caveat gets the
    // caveat printed beside it.
    lines.push(`# !! FUZZY TIER ABSENT -- search.fuzzy measures nothing. ${absence.detail}`);
  }
  return { caps, lines };
}
