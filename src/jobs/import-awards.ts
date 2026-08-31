#!/usr/bin/env bun
/**
 * Import every Academy Award nomination into the app database.
 *
 * A JOB, never a request path. The data changes once a year, the download is 2.2 MB, and
 * the governing rule says a render path touches nothing but local SQLite -- so this runs
 * on a timer beside the index refresh and every page reads the rows it wrote.
 *
 * ```
 * bun run awards:import          # fetch and replace
 * bun run awards:import --file oscars.tsv   # from a local copy, no network
 * ```
 *
 * Idempotent: the store swaps the whole award in one transaction, so re-running it is
 * free and interrupting it leaves the previous set intact.
 */

import { mkdirSync } from "node:fs";
import { AWARD_SOURCE, type AwardSourceMeta, fetchAwards, OSCARS, parseAwards } from "../lib/awards";
import { loadConfig, paths } from "../lib/config";
import { Store } from "../lib/store";

/** Where the provenance lives. One key, so a page can state its source in one read. */
export const AWARD_SOURCE_KEY = `awards:${OSCARS}:source`;

const log = (m: string) => console.log(`[awards] ${m}`);

export async function importAwards(store: Store, opts: { file?: string } = {}): Promise<AwardSourceMeta> {
  let text: string;
  let sha: string | null = null;
  let sourceDate: string | null = null;
  let url: string;

  if (opts.file) {
    // The local path exists so a test, or a machine with no route to GitHub, can still
    // exercise the whole import. It records no sha, because there is nothing to record
    // -- a file on disk cannot say which commit it came from, and inventing one would be
    // the provenance line lying.
    text = await Bun.file(opts.file).text();
    url = `file:${opts.file}`;
  } else {
    const fetched = await fetchAwards();
    text = fetched.text;
    sha = fetched.sha;
    sourceDate = fetched.sourceDate;
    url = fetched.url;
  }

  // Throws `AwardsSchemaDriftError` on a changed header, BEFORE anything is written. The
  // stored nominations are then untouched, which is the same contract `SchemaDriftError`
  // gives the index build.
  const rows = parseAwards(text, OSCARS);
  const written = store.replaceAwards(OSCARS, rows);

  const meta: AwardSourceMeta = {
    sha,
    url,
    licence: AWARD_SOURCE.licence,
    attribution: AWARD_SOURCE.attribution,
    importedAt: new Date().toISOString(),
    sourceDate,
    rows: written,
  };
  store.setKv(AWARD_SOURCE_KEY, JSON.stringify(meta));
  return meta;
}

/** The provenance behind the stored rows, or null before the first import. */
export function awardSourceMeta(store: Store): AwardSourceMeta | null {
  const raw = store.getKv(AWARD_SOURCE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AwardSourceMeta;
  } catch {
    // A malformed value means the page says "source unknown" rather than throwing on a
    // render path. It is one kv row and the next import replaces it.
    return null;
  }
}

if (import.meta.main) {
  const fileArg = process.argv.indexOf("--file");
  const cfg = loadConfig();
  // The server creates the data directory at boot; this job can be the FIRST thing that
  // ever opens it (a fresh checkout running the import before `bun start`), and SQLite's
  // answer to a missing directory is `SQLITE_CANTOPEN`, which names neither the path nor
  // the reason.
  mkdirSync(paths(cfg).root, { recursive: true });
  const store = new Store(cfg);
  try {
    const started = Date.now();
    const meta = await importAwards(store, {
      file: fileArg === -1 ? undefined : process.argv[fileArg + 1],
    });
    log(
      `${meta.rows.toLocaleString()} nominations in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `from ${meta.sha ? meta.sha.slice(0, 10) : "main (sha unknown)"} -- ${meta.licence}`,
    );
  } catch (err) {
    console.error(`[awards] import failed -- ${(err as Error).message}`);
    process.exit(1);
  } finally {
    store.close();
  }
}
