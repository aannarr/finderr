#!/usr/bin/env bun
/**
 * Build (or rebuild) the title index.
 *
 *   bun src/jobs/build-index.ts             # fetch if changed, build, gate, promote
 *   bun src/jobs/build-index.ts --force     # ignore ETags, always download
 *   bun src/jobs/build-index.ts --no-fetch  # build from whatever is already on disk
 *   bun src/jobs/build-index.ts --dry-run   # build and gate, do NOT promote
 */

import { existsSync, mkdirSync } from "node:fs";
import { loadConfig, paths } from "../lib/config";
import { CROSSWALK_FILE, fetchCrosswalk } from "../lib/crosswalk";
import { DumpStateStore, fetchDump, SchemaDriftError } from "../lib/dumps";
import { buildIndex, gateVolume, promote } from "../lib/index-builder";
import { prepareSqlite } from "../lib/spellfix";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const noFetch = args.has("--no-fetch");
const dryRun = args.has("--dry-run");

const cfg = loadConfig();
const p = paths(cfg);
mkdirSync(p.root, { recursive: true });
mkdirSync(p.dumps, { recursive: true });

const log = (m: string) => console.log(`[index] ${m}`);

// BEFORE ANY DATABASE IS OPENED, and that is the whole point of it being here rather
// than inside buildIndex(). On macOS this swaps in Homebrew's libsqlite3, because Apple's
// build refuses to load extensions -- and `setCustomSQLite` is a process-global one-shot
// that throws once any connection exists. `main()` opens DumpStateStore long before the
// build starts, so calling it there meant it ALWAYS failed on macOS: no spellfix, no
// vocabulary, and then the canary gate failing 37/42 on exactly the five typo queries.
// Linux never saw it, because bun's bundled sqlite loads extensions without adoption.
prepareSqlite(log);

async function main(): Promise<number> {
  const state = new DumpStateStore(p.appDb);
  let anyChanged = force;

  if (!noFetch) {
    // principals last: it is 744 MB, five times the other three combined, so a failure
    // in a cheap dump surfaces before we have spent ten minutes on the expensive one.
    for (const dump of ["title.ratings", "title.basics", "name.basics", "title.principals"] as const) {
      let lastPct = -1;
      const res = await fetchDump(dump, p.dumps, state, (recv, total) => {
        if (!total) return;
        const pct = Math.floor((recv / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          process.stderr.write(`\r[index] ${dump}: ${pct}%   `);
        }
      });
      if (lastPct >= 0) process.stderr.write("\n");
      if (res.changed) {
        anyChanged = true;
        log(`${dump}: downloaded ${(res.bytes / 1e6).toFixed(1)} MB`);
      } else {
        log(`${dump}: unchanged upstream (304), skipped`);
      }
    }

    /*
      The id crosswalk is a dump like the four above, and is fetched like one.

      It does NOT set `anyChanged`: a fresher crosswalk is not a reason to spend six
      minutes rebuilding an index whose titles have not moved. It rides along with the
      next build that happens for its own reasons, which for a week-long cache window is
      every build.
    */
    await fetchCrosswalk(`${p.dumps}/${CROSSWALK_FILE}`, { log });
  } else {
    anyChanged = true;
    log("--no-fetch: building from the dumps already on disk");
  }

  const haveLive = existsSync(p.db);
  if (!anyChanged && haveLive) {
    log("no drift detected and a live index exists -- nothing to do");
    state.close();
    return 0;
  }
  if (!anyChanged && !haveLive) {
    log("no upstream change, but there is no live index yet -- building anyway");
  }

  const stats = await buildIndex(cfg, p.dumps, p.dbNew, log);

  // --- gate: volume
  const volume = gateVolume(p.dbNew, p.db);
  log(`gate volume: ${volume.ok ? "PASS" : "FAIL"} -- ${volume.detail}`);
  if (!volume.ok) {
    log("ABORT: refusing to promote. The live index is untouched.");
    state.close();
    return 2;
  }

  // --- gate: canary. A structurally perfect dump can still wreck ranking.
  const { runCanary } = await import("../lib/canary");
  const canary = runCanary(p.dbNew, cfg);
  log(
    `gate canary: ${canary.ok ? "PASS" : "FAIL"} -- ${canary.passed}/${canary.total} ` +
      `(${(canary.ratio * 100).toFixed(0)}%, floor ${(canary.floor * 100).toFixed(0)}%)`,
  );
  if (canary.failures.length > 0) {
    for (const f of canary.failures.slice(0, 10))
      log(`    miss: "${f.query}" wanted ~${f.want}, got ${f.got}`);
  }
  if (!canary.ok) {
    log("ABORT: search quality regressed. The live index is untouched.");
    state.close();
    return 3;
  }

  if (dryRun) {
    log(`--dry-run: built and verified ${p.dbNew}, not promoting`);
    state.close();
    return 0;
  }

  promote(cfg);
  log(`promoted -> ${p.db} (${stats.kept.toLocaleString()} titles, ${(stats.bytes / 1e6).toFixed(1)} MB)`);
  state.close();
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof SchemaDriftError) {
    console.error(`\n[index] SCHEMA DRIFT -- build aborted\n${err.message}\n`);
    process.exit(4);
  }
  console.error("[index] build failed:", err);
  process.exit(1);
}
