#!/usr/bin/env bun
/**
 * Check `LIST_LANGUAGES` against the corpus it claims to describe.
 *
 * ```
 * bun run lists:audit                     # the index this machine has
 * bun run lists:audit path/to/titles.db   # a candidate, or somebody else's copy
 * ```
 *
 * `src/lib/lists.ts` says a language gets a list when it has at least `LIST_SIZE` ranked
 * non-English films, and claims the array is exactly the set over that floor. That claim was
 * prose checked once by hand, and the corpus moves under it -- twice already, and both times a
 * person happened to notice. This is the check that notices instead. `../lib/list-audit.ts`
 * owns the comparison and the argument for it.
 *
 * DELIBERATELY NOT PART OF `bun run test`, for the reason the canary is not: it needs a built
 * index, which CI, the Docker build and a fresh worktree do not have, so a red `bun run test`
 * there would be red for the wrong reason. `bun run gate` runs it anyway and treats the exit 2
 * below as NOT MEASURED, which is the same bargain the canary strikes.
 *
 * Exit 0 when the array and the corpus agree, 1 when they do not, and `NO_INDEX` when there is
 * no index to read.
 */

import { loadConfig, paths } from "../lib/config";
import { ORIGIN_WIDENED_CROSSWALK, recipeVersion, stagesOf } from "../lib/index-stages";
import { auditFailed, auditListLanguages, formatListLanguageAudit } from "../lib/list-audit";
import { LANGUAGE_LIST_KIND } from "../lib/lists";
import { SearchEngine } from "../lib/search";
import { findIndex, NO_INDEX } from "./canary";

/**
 * Does this file's `title_lang` come from the widened crosswalk?
 *
 * `null` for an unstamped file, which counts as NOT widened -- the stamp landed alongside no
 * stage of its own, so a file without it predates every recipe by definition.
 */
function crosswalkWidened(dbPath: string): boolean {
  return (recipeVersion(stagesOf(dbPath).origin) ?? 0) >= ORIGIN_WIDENED_CROSSWALK;
}

export function main(argv: readonly string[] = Bun.argv.slice(2)): number {
  const cfg = loadConfig();
  // The path is the first argument that is not a flag, matching `bun run canary`.
  const explicit = argv.find((a) => !a.startsWith("--"));
  const dbPath = explicit ?? findIndex(paths(cfg).db);

  if (!Bun.file(dbPath).size) {
    console.error(`[lists] no index at ${dbPath} -- build one with \`bun run index:build\``);
    return NO_INDEX;
  }

  const engine = new SearchEngine(dbPath, cfg);
  try {
    const counts = engine.rankedNonEnglishCounts(LANGUAGE_LIST_KIND);
    if (counts === null) {
      console.error(
        `[lists] ${dbPath} has no ranked languages to count -- it predates the origin stage, ` +
          "so /lists draws no language rows off it either. Nothing measured.",
      );
      return NO_INDEX;
    }

    const audit = auditListLanguages(counts, crosswalkWidened(dbPath));
    console.log(`[lists] ${dbPath}`);
    console.log(formatListLanguageAudit(audit));
    return auditFailed(audit) ? 1 : 0;
  } finally {
    engine.close();
  }
}

if (import.meta.main) process.exit(main());
