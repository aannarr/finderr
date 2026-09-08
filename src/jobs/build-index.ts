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
import { CROSSWALK_SOURCES, fetchCrosswalk } from "../lib/crosswalk";
import { DumpStateStore, fetchDump, SchemaDriftError } from "../lib/dumps";
import { buildIndex, gateCapabilities, gateVolume, promote } from "../lib/index-builder";
import { describeStale, staleStagesOf } from "../lib/index-stages";
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
    // principals last: it is 744 MB, five times the other four combined, so a failure
    // in a cheap dump surfaces before we have spent ten minutes on the expensive one.
    // title.episode (52 MB) rides in front of it for the same reason.
    for (const dump of [
      "title.ratings",
      "title.basics",
      "name.basics",
      "title.episode",
      "title.principals",
    ] as const) {
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
      The id crosswalks are dumps like the four above, and are fetched like them.

      Neither sets `anyChanged`: a fresher crosswalk is not a reason to spend six minutes
      rebuilding an index whose titles have not moved. They ride along with the next build
      that happens for its own reasons, which for a week-long cache window is every build --
      and the stage stamp a few lines below is what makes a build happen at all on the day
      a crosswalk is the ONLY thing that moved.
    */
    for (const source of CROSSWALK_SOURCES) await fetchCrosswalk(source, p.dumps, { log });
  } else {
    anyChanged = true;
    log("--no-fetch: building from the dumps already on disk");
  }

  const haveLive = existsSync(p.db);

  /*
    A STAGE THIS BUILD KNOWS AND THE LIVE INDEX DOES NOT IS A REASON TO BUILD.

    Upstream drift was the only reason until 2026-09-01, and that left the upgrade path
    depending on IMDb's publishing schedule. The crosswalk is fetched a few lines above and
    deliberately does NOT set `anyChanged` -- a fresher crosswalk is not worth six minutes
    on its own -- so on a day when every IMDb dump answers 304 the file was downloaded and
    then ignored, by an index that had no `title_ids` table at all.

    It self-healed within a day because IMDb publishes daily. That is an accident rather
    than an upgrade path, and it is exactly what somebody who pulls a new image and
    restarts is entitled to have happen without waiting on a third party.
  */
  if (!anyChanged && haveLive) {
    const stale = staleStagesOf(p.db, cfg);
    if (stale.length > 0) {
      log(`the live index is missing: ${describeStale(stale)} -- building for that`);
      anyChanged = true;
    }
  }

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

  /*
    --- gate: capabilities. The rows can survive intact while a whole FEATURE does not.

    This is the gate that was missing when a Mac build promoted an index with no spellfix
    vocabulary over one that had it: same row count to six figures, every stage stamped, and
    the canary excluding its five typo cases rather than failing them. `gateCapabilities` owns
    the argument; here it only matters that it runs BEFORE the canary, because a candidate
    that lost a tier makes the canary's verdict about that tier meaningless.
  */
  const caps = gateCapabilities(p.dbNew, p.db);
  log(`gate capabilities: ${caps.ok ? "PASS" : "FAIL"} -- ${caps.detail}`);
  if (!caps.ok) {
    log("ABORT: refusing to promote a less capable index. The live index is untouched.");
    state.close();
    return 5;
  }

  /*
    --- gate: canary. A structurally perfect dump can still wreck ranking.

    IT GATES ON ACCURACY ONLY, AND THE TIMING HALF IS A REPORT. `canary.ts` owns the argument
    at length; the operational half of it is that this is the WORST MOMENT on the machine to
    measure query latency -- the candidate was written seconds ago and has never been
    prefaulted, and the process has just finished a build and a VACUUM. On 2026-09-06 the
    single boolean threw away a 455-second build that scored 46/46 at 127 ms slowest when
    somebody re-ran the suite against the same file by hand.

    So a slow candidate is PROMOTED and SAID SO, loudly, on its own line. It also reaches
    `/api/health` through `index.reload.canary.slow`, because a log line on an unattended
    09:00 UTC refresh is a fact nobody reads.
  */
  const { runCanary, slowLine } = await import("../lib/canary");
  const canary = runCanary(p.dbNew, cfg);
  log(
    `gate canary: ${canary.accurate ? "PASS" : "FAIL"} -- ${canary.passed}/${canary.total} ` +
      `(${(canary.ratio * 100).toFixed(0)}%, floor ${(canary.floor * 100).toFixed(0)}%)`,
  );
  if (canary.degraded) log(`    ${canary.degraded}`);
  if (canary.failures.length > 0) {
    for (const f of canary.failures.slice(0, 10))
      log(`    miss: "${f.query}" wanted ~${f.want}, got ${f.got}`);
  }
  // Named whether or not it is about to abort: on an abort it says the timing was NOT the
  // reason, and on a pass it is the only place the breach is ever mentioned.
  const slow = slowLine(canary.slow);
  if (slow) log(`gate canary TIMING: ${slow} Not a promote failure -- see \`CanaryResult\`.`);
  if (!canary.accurate) {
    log("ABORT: search quality regressed -- the ACCURACY floor was not met. The live index is untouched.");
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
