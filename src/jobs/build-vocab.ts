#!/usr/bin/env bun
/**
 * Add (or rebuild) the spellfix1 vocabulary on an EXISTING index.
 *
 *   bun src/jobs/build-vocab.ts              # the live index
 *   bun src/jobs/build-vocab.ts path/to.db   # a specific one
 *
 * A full `index:build` also does this, but it re-downloads ~235 MB of IMDb dumps and
 * rebuilds 1.27M rows to get there. An index built before the vocabulary existed is
 * otherwise perfectly good -- it just has no fuzzy tier -- so upgrading it in place
 * takes a handful of seconds instead of half a minute: about four to build the vocabulary
 * and three more to re-`analyze` the file (measured on the real 1.9 GB index, M1 Max).
 *
 * Writes in place. That is safe on a stopped container and NOT safe on a running one:
 * a live server holds the index open, and SQLite's locking is documented as unreliable
 * on the FUSE-style filesystem a Docker Desktop bind mount provides. Stop finderr first.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { loadConfig, paths } from "../lib/config";
import { buildVocabulary } from "../lib/index-builder";
import {
  loadSpellfix,
  prepareSqlite,
  SPELLFIX_MAP_TABLE,
  SPELLFIX_MISSING,
  SPELLFIX_TABLE,
} from "../lib/spellfix";

const log = (m: string) => console.log(`[vocab] ${m}`);

const cfg = loadConfig();
const target = process.argv[2] ?? paths(cfg).db;

if (!existsSync(target)) {
  console.error(`[vocab] no index at ${target}`);
  process.exit(1);
}

// Must precede the first connection; no-op off macOS.
prepareSqlite(log);

const db = new Database(target, { readwrite: true });
try {
  // The extension must be loaded BEFORE the drop, not only before the build: `vocab` is a
  // spellfix1 virtual table, and SQLite refuses to drop a virtual table whose module it
  // does not have -- `no such module: spellfix1`. Measured 2026-09-06 on a real index: this
  // job died on its own first statement on exactly the index it exists to upgrade, and
  // `buildVocabulary` loading the extension itself did not help because that ran second.
  if (!loadSpellfix(db, log).ok) {
    console.error(`[vocab] ${SPELLFIX_MISSING}`);
    process.exit(1);
  }
  // Rebuilding must be idempotent -- this job exists to be re-run.
  db.run(`drop table if exists ${SPELLFIX_TABLE}`);
  db.run(`drop table if exists ${SPELLFIX_MAP_TABLE}`);
  buildVocabulary(db, cfg, log);
  // The same statistics `buildIndex` ends on, for the same reason and deliberately not
  // `pragma optimize` -- see the comment on that line. This job REWRITES part of an index a
  // build already analysed, so leaving the estimate here would mean a file's statistics
  // depend on which job touched it last: full for the tables the build wrote, capped at 2000
  // rows for the vocabulary. One owner of "what statistics does a finderr index carry".
  db.run("analyze");
  log(`done -> ${target}`);
} finally {
  db.close();
}
