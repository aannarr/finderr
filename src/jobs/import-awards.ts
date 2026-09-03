#!/usr/bin/env bun
/**
 * Import every award finderr holds into the app database.
 *
 * A JOB, never a request path. The data changes once a year, one source is a 2.2 MB download
 * and the other is a public SPARQL endpoint that has taken ninety seconds to answer -- and
 * the governing rule says a render path touches nothing but local SQLite. So this runs on a
 * timer beside the index refresh, and every page reads the rows it wrote.
 *
 * ```
 * bun run awards:import                       # every award in the registry
 * bun run awards:import --award palme-dor     # just one
 * bun run awards:import --award oscars --file oscars.tsv   # from a local copy, no network
 * ```
 *
 * `--file` is the `oscar_data` loader's own escape hatch and every other loader ignores it,
 * so it is only meaningful beside `--award oscars`.
 *
 * Idempotent per award: the store swaps the whole award in one transaction, so re-running is
 * free and interrupting it leaves the previous set intact. One award failing does not stop
 * the others -- a Wikidata 502 must not cost the Oscars their nightly refresh.
 */

import { mkdirSync } from "node:fs";
import { type LoadDeps, loadAward } from "../lib/award-import";
import { AWARDS, type AwardDef, awardById } from "../lib/award-registry";
import type { AwardSourceMeta } from "../lib/awards";
import { loadConfig, paths } from "../lib/config";
import { Store } from "../lib/store";

/** Where one award's provenance lives, so a page can state its source in one read. */
export function awardSourceKey(award: string): string {
  return `awards:${award}:source`;
}

const log = (m: string) => console.log(`[awards] ${m}`);

/** Import ONE award: fetch, parse, swap the rows, record where they came from. */
export async function importAward(
  store: Store,
  def: AwardDef,
  deps: LoadDeps = {},
): Promise<AwardSourceMeta> {
  const { rows, meta } = await loadAward(def, deps);
  const written = store.replaceAwards(def.id, rows);
  const full: AwardSourceMeta = { ...meta, rows: written };
  store.setKv(awardSourceKey(def.id), JSON.stringify(full));
  return full;
}

/**
 * Import every award, and report each one's outcome rather than the first failure.
 *
 * The awards are independent sources with independent outages, so a rejected promise for one
 * would throw away the work already done for another. Each result carries its own error, and
 * the caller decides how loud to be about it.
 */
export async function importAwards(
  store: Store,
  deps: LoadDeps = {},
  defs: readonly AwardDef[] = AWARDS,
): Promise<{ def: AwardDef; meta?: AwardSourceMeta; error?: Error }[]> {
  const out: { def: AwardDef; meta?: AwardSourceMeta; error?: Error }[] = [];
  for (const def of defs) {
    try {
      out.push({ def, meta: await importAward(store, def, deps) });
    } catch (err) {
      out.push({ def, error: err as Error });
    }
  }
  return out;
}

/** The provenance behind one award's stored rows, or null before its first import. */
export function awardSourceMeta(store: Store, award: string): AwardSourceMeta | null {
  const raw = store.getKv(awardSourceKey(award));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AwardSourceMeta;
  } catch {
    // A malformed value means the page says "source unknown" rather than throwing on a
    // render path. It is one kv row and the next import replaces it.
    return null;
  }
}

/** How an import reads in a log line: what it wrote, and what it read it from. */
function describe(meta: AwardSourceMeta): string {
  const revision = meta.sha ? meta.sha.slice(0, 10) : meta.query ? "wikidata query" : "revision unknown";
  return `${meta.rows.toLocaleString()} rows from ${revision} -- ${meta.licence}`;
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };

  const only = arg("--award");
  const def = only ? awardById(only) : undefined;
  if (only && !def) {
    console.error(`[awards] unknown award '${only}' -- known: ${AWARDS.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  const cfg = loadConfig();
  // The server creates the data directory at boot; this job can be the FIRST thing that
  // ever opens it (a fresh checkout running the import before `bun start`), and SQLite's
  // answer to a missing directory is `SQLITE_CANTOPEN`, which names neither the path nor
  // the reason.
  mkdirSync(paths(cfg).root, { recursive: true });
  const store = new Store(cfg);
  try {
    const started = Date.now();
    const results = await importAwards(store, { file: arg("--file") }, def ? [def] : AWARDS);
    for (const r of results) {
      if (r.meta) log(`${r.def.id}: ${describe(r.meta)}`);
      else log(`${r.def.id}: FAILED -- ${r.error?.message}`);
    }
    log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    // A run where every award failed is a failed run: a zero exit would tell a cron job
    // nothing happened when nothing did.
    if (results.every((r) => r.error)) process.exit(1);
  } finally {
    store.close();
  }
}
