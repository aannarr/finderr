/**
 * The promote gate that would have caught the vocabulary-less index of 2026-09-07.
 *
 * Everything here runs against a REAL index the real builder produced, because the defect
 * being guarded was invisible to exactly the checks that read stamps and counts: the file had
 * the right number of rows, a complete stage stamp and a green canary, and had lost the whole
 * fuzzy tier. A fixture hand-rolling its own schema could not reproduce that.
 *
 * WHETHER THE FIXTURE COMES OUT WITH A VOCABULARY DEPENDS ON THE BOX, and that is the trap
 * this file has to design around rather than ignore. `buildVocabulary` needs spellfix1, which
 * a fresh worktree does not carry -- so the same source produces an index with the vocabulary
 * on one machine and without it on another, and a test that read the build's own answer would
 * assert the opposite thing in the two places. `withVocabulary` / `withoutVocabulary` below
 * NORMALISE the file instead, so every case states which side of the incident it is testing.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpDir, indexConfig } from "../test/index-dumps";
import { buildIndex, gateCapabilities } from "./index-builder";
import { capabilitiesOf, capabilitiesOfFile, INDEX_CAPABILITIES } from "./index-capabilities";
import { loadSpellfix, SPELLFIX_MAP_TABLE, SPELLFIX_TABLE } from "./spellfix";

const root = mkdtempSync(join(tmpdir(), "finderr-caps-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tconst = (i: number) => `tt${String(i).padStart(7, "0")}`;

/** One real index, built once and copied per case -- the build is the expensive part. */
async function baseIndex(): Promise<string> {
  const rows = Array.from({ length: 40 }, (_, i) => i);
  const dir = dumpDir(root, {
    ratings: rows.map((i) => [tconst(i), "7.5", "5000"]),
    basics: rows.map((i) => [
      tconst(i),
      "movie",
      `Title ${i}`,
      `Title ${i}`,
      "0",
      "2000",
      "\\N",
      "100",
      "Drama",
    ]),
  });
  const dest = join(root, "base.db");
  await buildIndex(indexConfig(), dir, dest, () => {});
  return dest;
}

const BASE = await baseIndex();

/** A private copy of the built index, so a case may mutate it freely. */
function copyOf(name: string): string {
  const path = join(root, `${name}.db`);
  copyFileSync(BASE, path);
  return path;
}

/** Run `sql` against a fresh copy and hand back its path. */
function copyWith(name: string, ...sql: string[]): string {
  const path = copyOf(name);
  const db = new Database(path);
  try {
    for (const s of sql) db.run(s);
  } finally {
    db.close();
  }
  return path;
}

/**
 * A copy with the vocabulary tables definitively gone -- the shape the incident promoted.
 *
 * `loadSpellfix` first, and it is not optional where the tables DO exist: `vocab` is a
 * spellfix1 virtual table and SQLite refuses to drop one whose module it does not have. That
 * is measured behaviour rather than caution -- `src/jobs/build-vocab.ts` carries the same call
 * for the same reason, having died on its own first statement without it. Where the extension
 * is unavailable there is nothing to drop, so the failed load costs nothing.
 */
function withoutVocabulary(name: string): string {
  const path = copyOf(name);
  const db = new Database(path);
  try {
    loadSpellfix(db);
    db.run(`drop table if exists ${SPELLFIX_TABLE}`);
    db.run(`drop table if exists ${SPELLFIX_MAP_TABLE}`);
  } finally {
    db.close();
  }
  return path;
}

/**
 * A copy that definitively carries the vocabulary, as two ORDINARY tables.
 *
 * The gate reads `sqlite_master`, never the vocabulary's contents, and that is the property
 * that makes it work on the box that lost the tier -- so plain tables of the right names
 * exercise the real path and the test needs no extension to run.
 */
function withVocabulary(name: string): string {
  const path = withoutVocabulary(name);
  const db = new Database(path);
  try {
    db.run(`create table ${SPELLFIX_TABLE} (word text)`);
    db.run(`create table ${SPELLFIX_MAP_TABLE} (id integer primary key, rowid_ integer not null)`);
  } finally {
    db.close();
  }
  return path;
}

describe("capabilitiesOf", () => {
  /**
   * Every capability but the two spellfix ones, from ONE build of the real builder.
   *
   * Stated as "all of them" rather than as a hand-picked handful because that is what the
   * builder actually produces: a stage creates its tables whether or not its dump was on disk,
   * so a probe whose SQL stopped matching the schema goes red here rather than surviving until
   * the day it matters. The two exceptions are the ones that need an extension.
   */
  test("the real builder produces every capability this table names", () => {
    const db = new Database(BASE, { readonly: true });
    try {
      const caps = capabilitiesOf(db);
      const missing = Object.keys(INDEX_CAPABILITIES).filter(
        (c) => !caps.has(c as never) && c !== "fuzzy" && c !== "trigrams",
      );
      expect(missing).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a dropped table takes exactly its own capability with it", () => {
    const before = capabilitiesOfFile(BASE);
    const after = capabilitiesOfFile(copyWith("no-counts", "drop table browse_count"));
    expect(before?.has("browseCounts")).toBe(true);
    expect(after?.has("browseCounts")).toBe(false);
    expect([...(before ?? [])].filter((c) => !after?.has(c))).toEqual(["browseCounts"]);
  });
});

describe("capabilitiesOfFile", () => {
  test("`null` -- not a throw, not an empty set -- for a file that is not there", () => {
    expect(capabilitiesOfFile(join(root, "absent.db"))).toBeNull();
  });

  test("`null` for a file that is not a database at all", () => {
    const path = join(root, "garbage.db");
    writeFileSync(path, "this is not sqlite");
    expect(capabilitiesOfFile(path)).toBeNull();
  });
});

describe("gateCapabilities", () => {
  /**
   * THE 2026-09-07 INCIDENT, as a promote.
   *
   * The live index carries the vocabulary, the candidate does not, and every other signal
   * agrees the candidate is fine -- same rows, same stages, same everything, because both
   * files are copies of one build. This is the assertion the whole file exists for.
   */
  test("REFUSES a candidate that lost the spellfix vocabulary", () => {
    const result = gateCapabilities(withoutVocabulary("candidate-no-vocab"), withVocabulary("live-vocab"));
    expect(result.ok).toBe(false);
    expect(result.name).toBe("capabilities");
    expect(result.detail).toContain("fuzzy");
    // The remedy is in the message, because its reader is an unattended log at 09:00 UTC.
    expect(result.detail).toContain("spellfix:build");
  });

  test("names EVERY capability that went missing, not just the first", () => {
    const candidate = withoutVocabulary("lost-two");
    const db = new Database(candidate);
    db.run("drop table browse_count");
    db.close();
    const result = gateCapabilities(candidate, withVocabulary("live-full"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("fuzzy");
    expect(result.detail).toContain("browseCounts");
  });

  /**
   * The real 2026-09-07 pair is this shape, which is why the message names both halves: the
   * candidate lost `fuzzy` and `trigrams` while gaining `breakout`, so the two totals differ
   * by one and a reader given only totals would think the report was wrong.
   */
  test("a candidate that both lost and gained says so on the refusal", () => {
    const candidate = withVocabulary("mixed");
    const db = new Database(candidate);
    db.run("drop table browse_count");
    db.close();
    const result = gateCapabilities(candidate, withoutVocabulary("live-mixed"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("LOST browseCounts");
    expect(result.detail).toContain("It gained fuzzy");
  });

  test("passes an identical candidate", () => {
    expect(gateCapabilities(copyOf("same"), BASE).ok).toBe(true);
  });

  test("passes a candidate that GAINED a capability, and says which", () => {
    const result = gateCapabilities(withVocabulary("gained"), withoutVocabulary("live-plain"));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("It gained fuzzy");
  });

  /**
   * A first install has nothing to compare against and must not be blocked by that -- the same
   * rule `gateVolume` follows, and for the reason `staleStagesOf` gives: the boot-build path is
   * the deployment least able to absorb a refusal.
   */
  test("passes when there is no live index yet", () => {
    expect(gateCapabilities(BASE, join(root, "absent.db")).ok).toBe(true);
  });

  test("passes when the LIVE index is unreadable -- a broken old file cannot veto a good new one", () => {
    const live = join(root, "live-garbage.db");
    writeFileSync(live, "this is not sqlite");
    const result = gateCapabilities(BASE, live);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("nothing to compare");
  });

  test("REFUSES a candidate that cannot be opened", () => {
    const candidate = join(root, "candidate-garbage.db");
    writeFileSync(candidate, "this is not sqlite");
    expect(gateCapabilities(candidate, BASE).ok).toBe(false);
  });
});
