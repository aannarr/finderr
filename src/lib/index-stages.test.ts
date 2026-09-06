import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "./config";
import {
  currentStages,
  describeStale,
  INDEX_STAGES,
  STAGES_META_KEY,
  stagesOf,
  staleStagesOf,
  stampStages,
} from "./index-stages";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "finderr-stages-"));
}

/** A config with one index knob moved, without mutating the shared cached one. */
function withIndex(patch: Partial<Config["index"]>): Config {
  const cfg = loadConfig();
  return { ...cfg, index: { ...cfg.index, ...patch } };
}

/** An index file carrying just enough of the real shape to be stamped and read back. */
function indexAt(path: string, stamp?: (db: Database) => void): void {
  const db = new Database(path, { create: true });
  db.run("create table meta (key text primary key, value text not null)");
  db.query("insert into meta (key, value) values ('built_at', '2026-09-01T00:00:00.000Z')").run();
  stamp?.(db);
  db.close();
}

describe("index stages", () => {
  test("a freshly stamped index is not stale", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "titles.db");
      const cfg = loadConfig();
      indexAt(path, (db) => stampStages(db, cfg));

      expect(staleStagesOf(path, cfg)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an UNSTAMPED index reports every stage, so one rebuild brings it current", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "titles.db");
      indexAt(path);

      const stale = staleStagesOf(path, loadConfig());
      expect(stale.map((s) => s.stage).sort()).toEqual(Object.keys(INDEX_STAGES).sort());
      // `had: null` is what distinguishes "predates the stage" from "built differently".
      expect(stale.every((s) => s.had === null)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stage whose RECIPE moved is stale, not merely present", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "titles.db");
      const before = loadConfig();
      indexAt(path, (db) => stampStages(db, before));

      // Widening castCategories is the change that used to be swallowed until a dump
      // happened to drift -- the config said composers were indexed and the index
      // disagreed.
      const after = withIndex({ castCategories: [...before.index.castCategories, "archive_footage"] });

      const stale = staleStagesOf(path, after);
      expect(stale.map((s) => s.stage)).toEqual(["cast"]);
      expect(stale[0]?.had).not.toBeNull();
      expect(describeStale(stale)).toBe("cast (recipe changed)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("moving the fuzzy vote floor is a build reason, not only a boot-time warning", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "titles.db");
      const before = loadConfig();
      indexAt(path, (db) => stampStages(db, before));

      const after = withIndex({ fuzzyMinVotes: before.index.fuzzyMinVotes + 50 });
      expect(staleStagesOf(path, after).map((s) => s.stage)).toEqual(["vocab"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reordering a config list is the SAME recipe -- an unsorted stamp would rebuild nightly", () => {
    const a = withIndex({ castCategories: ["actor", "director", "writer"] });
    const b = withIndex({ castCategories: ["writer", "actor", "director", "actor"] });

    expect(INDEX_STAGES.cast(a)).toBe(INDEX_STAGES.cast(b));
  });

  test("a MISSING index is not a stale one -- that is the boot build's problem", () => {
    const dir = tempDir();
    try {
      expect(staleStagesOf(join(dir, "nope.db"), loadConfig())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt or non-object stamp reads as unstamped rather than throwing", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "titles.db");
      indexAt(path, (db) => {
        db.query("insert into meta (key, value) values (?, ?)").run(STAGES_META_KEY, "not json");
      });
      expect(stagesOf(path)).toEqual({});

      const arrayPath = join(dir, "array.db");
      indexAt(arrayPath, (db) => {
        db.query("insert into meta (key, value) values (?, ?)").run(STAGES_META_KEY, '["cast"]');
      });
      expect(stagesOf(arrayPath)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("currentStages covers every declared stage", () => {
    expect(Object.keys(currentStages(loadConfig())).sort()).toEqual(Object.keys(INDEX_STAGES).sort());
  });
});
