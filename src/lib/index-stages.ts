/**
 * Which stages an index carries, so an upgrade can notice it is missing one.
 *
 * ## The bug this exists to end
 *
 * Every stage added to the builder so far has been ADDITIVE and optional, and each one
 * grew its own capability probe in `SearchEngine` -- `hasPeople`, `hasRank`, `hasIds`. Those
 * probes are correct and they stay: an index built before a stage existed must keep serving
 * rather than throw `no such table`. But they only ever answer "can I read this?", and
 * nothing anywhere answered **"should this index have been able to?"**
 *
 * So the upgrade path was: pull the new image, restart, and run indefinitely on an index
 * that silently lacks the thing the release was about. Measured on 2026-09-01, on the live
 * deployment: the id crosswalk shipped, the container restarted onto it, `hasIds` was false,
 * and every render went on buying `/find` calls the crosswalk existed to remove. Nothing was
 * broken, nothing logged, and `/api/health` was entirely green.
 *
 * The daily refresh did not fix it either, and that is the second half. `build-index.ts`
 * only builds when a DUMP drifted upstream, and a newly downloaded crosswalk deliberately
 * does not count as drift. On a day when all four dumps answer 304, the crosswalk is
 * fetched and then ignored. It self-heals eventually because IMDb publishes daily -- by
 * accident, not by design, and an accident is not an upgrade path.
 *
 * ## What is stamped, and why a stage that found nothing still counts
 *
 * The build records every stage it RAN, with a recipe describing the configuration that
 * produced it. A stage that ran and found no source to read is still stamped: the crosswalk
 * being absent from disk is an answer, and re-running the build would produce the same
 * answer. Stamping only successful stages would mean a keyless or sourceless deployment
 * rebuilding its entire index on every single boot, forever.
 *
 * The recipe is what makes this more than a presence check. `cast` carries its categories
 * and vote floor, so widening `castCategories` is noticed at BOOT rather than whenever the
 * next dump happens to drift.
 *
 * ## Deliberately not a version number
 *
 * A monotonic `INDEX_VERSION` bumped by hand fails the same way a manual cache version
 * does -- silently, when somebody forgets. It also cannot express the case that actually
 * occurs here, which is one stage moving while the other four are untouched: a version
 * number would rebuild everything or nothing.
 */

import { Database } from "bun:sqlite";
import type { Config } from "./config";

/**
 * The `meta` key holding the stamp, as a JSON object of `stage -> recipe`.
 *
 * One key rather than one per stage, because the stamp is read as a SET -- "what does this
 * index carry?" is a single question, and answering it with `n` queries invites the two
 * halves to disagree about which stages exist.
 */
export const STAGES_META_KEY = "stages";

/**
 * Every stage this build knows how to produce, and what its output depends on.
 *
 * A stage belongs here once it can be ABSENT from an otherwise valid index -- which is the
 * same test as needing a capability probe in `SearchEngine`, and the three entries below
 * are exactly the three probes that exist (`hasPeople`, `hasRank`, `hasIds`). A stage that
 * every index has always had needs no stamp: there is no version of the file without it.
 *
 * The recipe is a canonical string. Two builds of the same configuration must produce the
 * same one, so anything set-like is sorted -- an unsorted list would report a difference
 * every time somebody reordered a config array, and a stamp that always disagrees is a
 * stamp nobody can act on.
 */
export const INDEX_STAGES = {
  /**
   * `person` + `title_principal`. Reuses the SAME derivation the carry-forward decision
   * uses (`castRecipe`), so the two cannot disagree about what "the same cast" means.
   */
  cast: (cfg) =>
    JSON.stringify({
      categories: [...new Set(cfg.index.castCategories)].sort(),
      minVotes: cfg.index.castMinVotes,
    }),

  /** The `rank` column on `title` and its copy on `title_genre`. */
  rank: (cfg) => JSON.stringify({ priorVotes: cfg.index.rankPriorVotes }),

  /**
   * `title_ids`, the bulk `tconst -> tmdb/tvdb` crosswalk.
   *
   * No configuration input at all, so the recipe is a constant -- present or absent is the
   * whole question. It is still a JSON object rather than a bare string so a knob arriving
   * later is an edit to this line and not a change of shape.
   */
  ids: () => JSON.stringify({ v: 1 }),
  // `satisfies` rather than an annotation: the keys stay literal, so `INDEX_STAGES.cast` is
  // a function rather than a possibly-undefined index read, and a typo in a caller is a
  // compile error instead of a stage that silently never matches.
} satisfies Record<string, (cfg: Config) => string>;

/** The stamp this configuration would write: every known stage at its current recipe. */
export function currentStages(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, recipe] of Object.entries(INDEX_STAGES)) out[name] = recipe(cfg);
  return out;
}

/**
 * Write the stamp into an index being built.
 *
 * Called once, at the end of the build, over every stage rather than by each stage as it
 * finishes. A stage that writes its own stamp can leave one behind after a later stage
 * throws, and a partially stamped index is worse than an unstamped one: it claims to carry
 * something the file does not have.
 */
export function stampStages(db: Database, cfg: Config): void {
  db.query("insert or replace into meta (key, value) values (?, ?)").run(
    STAGES_META_KEY,
    JSON.stringify(currentStages(cfg)),
  );
}

/**
 * The stamp an index file carries, or `{}` for one built before stamping existed.
 *
 * Never throws. This runs at boot against a file that may be missing, mid-promote or
 * simply older than this code, and a startup check that can itself take the server down is
 * worse than the drift it was added to notice.
 */
export function stagesOf(path: string): Record<string, string> {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query(`select value from meta where key = '${STAGES_META_KEY}'`).get() as
        | { value: string }
        | undefined;
      if (!row) return {};
      const parsed = JSON.parse(row.value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
      return out;
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

/** One stage the index does not carry at the recipe this build would produce. */
export interface StaleStage {
  stage: string;
  /** What the index has, or `null` when it has no stamp for this stage at all. */
  had: string | null;
  /** What this configuration would produce. */
  wants: string;
}

/**
 * Stages the index at `path` is missing or carries under a superseded recipe.
 *
 * Empty for an index that is up to date, and empty for a file that does not exist -- a
 * MISSING index is not a stale one, it is the boot-build path's problem, and reporting it
 * here would have the caller rebuilding a file it is already building.
 *
 * An UNSTAMPED index reports every stage. That is the correct answer rather than a
 * conservative one: the stamp landed alongside no stage of its own, so an index without it
 * predates the newest stage by definition and one rebuild brings it fully current.
 */
export function staleStages(path: string, cfg: Config): StaleStage[] {
  const db = new Database(path, { readonly: true, create: false });
  db.close();

  const had = stagesOf(path);
  const wants = currentStages(cfg);
  const out: StaleStage[] = [];
  for (const [stage, recipe] of Object.entries(wants)) {
    if (had[stage] !== recipe) out.push({ stage, had: had[stage] ?? null, wants: recipe });
  }
  return out;
}

/**
 * `staleStages` for a path that may not exist, as the one-line form every caller wants.
 *
 * Returns `[]` when there is no file. Both callers -- the build job and the boot check --
 * would otherwise write the same `existsSync` guard, and the failure of forgetting it is a
 * thrown exception on a fresh install: the exact deployment least able to absorb one.
 */
export function staleStagesOf(path: string, cfg: Config): StaleStage[] {
  try {
    return staleStages(path, cfg);
  } catch {
    return [];
  }
}

/** A log line naming what is stale, short enough for a boot line. */
export function describeStale(stale: StaleStage[]): string {
  return stale.map((s) => (s.had === null ? s.stage : `${s.stage} (recipe changed)`)).join(", ");
}
