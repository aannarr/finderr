/**
 * Loading SQLite's spellfix1 extension, and the two platform traps that come with it.
 *
 * spellfix1 is what makes `brigerton` find *Bridgerton*. It replaced an in-RAM trigram
 * index that cost 1,514 MB and ~9M live objects; the measurements and the reasoning are
 * in `vendor/sqlite-spellfix/README.md`. Everything here is about GETTING it loaded --
 * the search logic lives in `search.ts`.
 *
 * TRAP 1 -- `setCustomSQLite` is process-wide and must run before ANY Database exists.
 * Apple's system SQLite is built with extension loading disabled, so on macOS Bun has
 * to be pointed at a different libsqlite3 entirely. That is a static, one-shot,
 * process-global switch: once any `new Database()` has been constructed, it is too late
 * and the call throws. So `prepareSqlite()` must be called at import time, before the
 * SearchEngine or the Store opens anything. This is why it is a separate function from
 * `loadSpellfix()` rather than one tidy call.
 *
 * TRAP 2 -- a missing extension must not take the product down. Search still works
 * without spellfix1; it just loses typo tolerance and falls back to FTS. A dev box with
 * no Homebrew SQLite, or an image built before the extension stage existed, should log
 * loudly and keep serving. Refusing to boot over a degraded search tier would be a
 * worse failure than the one it is guarding against.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/** Candidate libsqlite3 builds on macOS, in preference order. Homebrew, then MacPorts. */
const MAC_SQLITE_CANDIDATES = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon Homebrew
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Intel Homebrew
  "/opt/local/lib/libsqlite3.dylib", // MacPorts
];

/** Where the compiled extension might be, in preference order. */
function extensionCandidates(): string[] {
  const explicit = process.env.FINDERR_SPELLFIX_PATH;
  const ext = process.platform === "darwin" ? "dylib" : "so";
  return [
    ...(explicit ? [explicit] : []),
    // Where the Dockerfile's spellfix stage puts it.
    `${process.cwd()}/ext/spellfix1.${ext}`,
    // Where a local `bun run spellfix:build` puts it, for dev.
    `${process.cwd()}/vendor/sqlite-spellfix/spellfix1.${ext}`,
  ];
}

let prepared = false;
let customSqlitePath: string | null = null;

/**
 * Point Bun at a SQLite build that permits extensions, if the platform needs it.
 *
 * MUST be called before any `new Database()` in the process. Returns the path adopted,
 * or null if the platform's default is already fine (every Linux build is).
 */
export function prepareSqlite(log: (m: string) => void = () => {}): string | null {
  if (prepared) return customSqlitePath;
  prepared = true;

  if (process.platform !== "darwin") return null;

  for (const path of MAC_SQLITE_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      Database.setCustomSQLite(path);
      customSqlitePath = path;
      log(`sqlite: using ${path} (Apple's build disables extensions)`);
      return path;
    } catch (err) {
      // Almost always "a Database was already opened". Worth saying plainly, because
      // the symptom otherwise is a mysteriously missing fuzzy tier.
      log(`sqlite: could not adopt ${path} -- ${(err as Error).message}`);
      return null;
    }
  }

  log(
    "sqlite: no Homebrew/MacPorts libsqlite3 found; typo-tolerant search will be OFF on this dev box. " +
      "Fix with `brew install sqlite`.",
  );
  return null;
}

export interface SpellfixLoad {
  ok: boolean;
  path: string | null;
  error: string | null;
}

/**
 * How to obtain the extension, in one sentence.
 *
 * Named once and referred to everywhere, because the SAME missing binary surfaces in at
 * least three diagnostics -- the load failure here, the canary's degraded line, and the
 * `canary` job -- and three hand-written copies of the remedy would drift. The dev recipe
 * is macOS/Homebrew-specific (`package.json`'s `spellfix:build` shells out to `cc` with
 * `$(brew --prefix sqlite)`); the image builds the same source in its own stage into
 * `./ext`, so both routes are named rather than only the one that happens to fit the
 * reader's machine.
 */
export const SPELLFIX_BUILD_HINT =
  "build it with `bun run spellfix:build` (macOS/Homebrew), or take it from the Dockerfile's spellfix stage";

/**
 * What to tell a HUMAN when the extension is the thing that is missing.
 *
 * One string, so the search engine, the canary and anything else reporting the absence say
 * the same sentence -- and so a test can pin the wording in one place instead of chasing
 * three copies of it.
 */
export const SPELLFIX_MISSING = `spellfix1 is not loaded; ${SPELLFIX_BUILD_HINT}`;

/**
 * Load spellfix1 into an open database.
 *
 * `loadExtension` wants the path WITHOUT its file extension -- SQLite appends the
 * platform's own suffix. Passing `foo.so` makes it look for `foo.so.so`.
 */
export function loadSpellfix(db: Database, log: (m: string) => void = () => {}): SpellfixLoad {
  let lastError: string | null = null;

  for (const path of extensionCandidates()) {
    if (!existsSync(path)) continue;
    const withoutSuffix = path.replace(/\.(so|dylib)$/, "");
    try {
      db.loadExtension(withoutSuffix);
      // Prove it actually registered rather than trusting a silent no-op.
      db.query("select editdist3('a','b') d").get();
      log(`spellfix1: loaded from ${path}`);
      return { ok: true, path, error: null };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  log(
    `spellfix1: NOT loaded -- typo-tolerant search is off, FTS still works. ` +
      `Looked in ${extensionCandidates().join(", ")}${lastError ? ` -- last error: ${lastError}` : ""}. ` +
      `To enable it, ${SPELLFIX_BUILD_HINT}.`,
  );
  return { ok: false, path: null, error: lastError };
}

/** Name of the vocabulary table spellfix1 owns inside the index. */
export const SPELLFIX_TABLE = "vocab";

/** The companion table mapping a vocabulary row back to a title. */
export const SPELLFIX_MAP_TABLE = "vocab_map";
