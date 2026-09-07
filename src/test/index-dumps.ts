/**
 * A directory of real gzipped IMDb dumps, and a `Config` the real builder will accept.
 *
 * Three test files drive `buildIndex` end to end -- the cast stage, the episode stage and
 * the statistics the build leaves -- and the first two held a byte-identical copy of both
 * helpers below. The dump writer is pure ceremony (headers, tabs, gzip) and the config is a
 * list of every field the builder reads, which is the copy that actually rots: `as Config`
 * silences the compiler, so a NEW field is missing in every copy and nothing says so until
 * one of them goes red for a reason that looks unrelated. `cast-build.test.ts` records that
 * happening on the day `rankPriorVotes` landed.
 *
 * Test-only, and in `src/test/` rather than `src/lib/` to say so -- nothing the app ships
 * imports it. Same rule and same reason as `./nomination.ts`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../lib/config";
import { EXPECTED_HEADERS } from "../lib/dumps";

/**
 * Every `index` field the builder reads, with defaults a caller then bends.
 *
 * The defaults are deliberately the PERMISSIVE ones -- all four title types, no cast
 * categories, a floor low enough that a small fixture keeps its rows -- so a test that says
 * nothing about a knob gets the shape that hides the least. A test that cares states it.
 */
export function indexConfig(over: Partial<Config["index"]> = {}): Config {
  return {
    index: {
      fuzzyMinVotes: 100,
      titleTypes: ["movie", "tvSeries", "tvMiniSeries", "tvMovie"],
      includeAdult: false,
      castMinVotes: 1000,
      castCategories: [],
      episodeSeriesMinVotes: 1000,
      rankPriorVotes: 25_000,
      refreshCron: "",
      refreshOnBoot: false,
      ...over,
    },
  } as Config;
}

/** The dumps a fixture may provide, under the short names the tests already use. */
export interface DumpRows {
  ratings: string[][];
  basics: string[][];
  principals?: string[][];
  names?: string[][];
  episodes?: string[][];
}

/** Which file each short name is written to. One owner of the mapping. */
const DUMP_FILES: Record<keyof DumpRows, keyof typeof EXPECTED_HEADERS> = {
  ratings: "title.ratings",
  basics: "title.basics",
  principals: "title.principals",
  names: "name.basics",
  episodes: "title.episode",
};

/**
 * Write one dump directory under `root` and return its path.
 *
 * Rows are given WITHOUT the header -- the header comes from `EXPECTED_HEADERS`, so a
 * fixture cannot drift from what the builder's own guard demands. The directory is named
 * with a uuid, so a test file can call this as many times as it likes under one root and
 * clean up by removing the root.
 */
export function dumpDir(root: string, dumps: DumpRows): string {
  const dir = join(root, crypto.randomUUID());
  mkdirSync(dir, { recursive: true });
  for (const key of Object.keys(DUMP_FILES) as (keyof DumpRows)[]) {
    const rows = dumps[key];
    if (!rows) continue;
    const file = DUMP_FILES[key];
    const text = [EXPECTED_HEADERS[file], ...rows.map((r) => r.join("\t"))].join("\n");
    Bun.write(join(dir, `${file}.tsv.gz`), Bun.gzipSync(Buffer.from(`${text}\n`)));
  }
  return dir;
}
