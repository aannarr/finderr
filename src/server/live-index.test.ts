/**
 * The in-place index swap.
 *
 * The invariant worth guarding is not "a reload works". It is **a reload that should not
 * happen leaves the previous engine serving** -- because the whole argument for swapping
 * in-process rather than exiting and letting Docker restart is that a bad candidate costs
 * nothing. If a refusal could still retire the good engine, the restart route would be
 * the safer one and this file would be a mistake.
 *
 * The candidate is validated with the real canary, so these fixtures drive the floor
 * rather than mocking the gate: a three-row index passes at floor 0 and fails at floor 1,
 * which is exactly the two paths that need proving.
 *
 * ## What this file used to assert, and why it flaked
 *
 * Two tests here asserted that a promoted-away SQLite connection is uniformly fatal --
 * `expect(() => held.byTconst(...)).toThrow()`, and `expect(out.builtAt).toBeNull()` on
 * the refusal path, which is only true when the same read throws inside `safeMeta`. **It
 * is not uniformly fatal.** Measured 2026-08-31 under load, 1,000 first-reads through a
 * retired engine across five read paths: 918 threw `SQLITE_IOERR_VNODE`, **82 answered**.
 * That is the flake, one run in three, and the wording it came from is corrected on
 * `reload()`.
 *
 * So the tests below split what is guaranteed from what is not, and neither half is a
 * weakened assertion:
 *
 * - **Guaranteed by the OS, and asserted as a disjunction**: a retired engine either
 *   throws or answers out of the file it opened. It NEVER reflects the promoted file.
 *   `assertRetiredEngineNeverSeesThePromotedFile` runs that over many promotes so both
 *   branches actually occur, and fails loudly if a retired engine ever followed the
 *   rename -- which is the thing that would really be a bug.
 * - **Guaranteed by us, and asserted as a constant**: `LiveIndex` closes the outgoing
 *   engine at the swap and stops quoting a displaced engine's metadata, so a handler
 *   holding a stale reference gets an error every time rather than 92% of the time.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../lib/config";
import { SCHEMA } from "../lib/index-builder";
import { SearchEngine } from "../lib/search";
import { LiveIndex } from "./live-index";

const dir = mkdtempSync(join(tmpdir(), "finderr-live-index-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cfg = { index: { fuzzyMinVotes: 100 } } as unknown as Config;

/**
 * An index file with the real schema, one recognisable row, and a `built_at` the caller
 * chooses -- `built_at` is what `reload()` compares to decide whether anything is new.
 */
function writeIndex(path: string, opts: { builtAt: string; title: string; tconst: string }): void {
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  db.query(
    "insert into title (tconst, kind, title, ntitle, norig, dtitle, year, votes, rating, genres) " +
      "values (?, 'movie', ?, ?, '', ?, 1999, 900000, 8, 'Drama')",
  ).run(opts.tconst, opts.title, opts.title.toLowerCase(), opts.title.toLowerCase());
  // `tfts` is created by `buildIndex`, NOT by `SCHEMA` -- so a fixture that runs the
  // schema alone is not a searchable index, and every canary case dies on
  // "no such table: tfts" rather than failing honestly. Found by these tests.
  db.run(
    "create virtual table tfts using fts5(ntitle, norig, dtitle, content='title', content_rowid='rowid_', " +
      "tokenize='unicode61 remove_diacritics 2')",
  );
  db.run("insert into tfts(rowid, ntitle, norig, dtitle) select rowid_, ntitle, norig, dtitle from title");
  db.query("insert or replace into meta (key, value) values ('built_at', ?)").run(opts.builtAt);
  db.query("insert or replace into meta (key, value) values ('rows', '1')").run();
  db.close();
}

function freshPath(name: string): string {
  return join(dir, `${name}-${crypto.randomUUID()}.db`);
}

/**
 * `promote()`, exactly: move ours aside, then move the new one in.
 *
 * The order is `src/lib/index-builder.ts`'s, and it is what leaves the old bytes intact at
 * `titles.prev.db` for `rollback()` to put back.
 *
 * It does NOT keep the open handle usable, which a comment here used to claim. The file
 * surviving under a different name is not the same thing as the connection surviving:
 * SQLite compares the path it opened against what that path resolves to now, and mostly
 * refuses. Measured 2026-08-31: renaming ours BACK before reading through it does not
 * revive it either -- 382 of 400 still threw. The handle is gone once the rename lands,
 * whatever the bytes are doing.
 */
function promoteOver(livePath: string, opts: { builtAt: string; title: string; tconst: string }): void {
  const candidate = `${livePath}.new`;
  writeIndex(candidate, opts);
  renameSync(livePath, `${livePath}.prev`);
  renameSync(candidate, livePath);
}

/**
 * The honest post-promote invariant, asserted over enough promotes that both branches run.
 *
 * A single read here would be the old flake wearing a different assertion: on a quiet
 * machine it throws ~100% of the time, under load about 8% of reads answer instead. So
 * this drives many independent promotes and holds every one of them to the disjunction --
 * **throw, or answer out of the pre-promote file** -- and reports which branches it
 * actually saw, so a run where the environment only ever produced one is not silently
 * mistaken for proof of both.
 *
 * The assertion that matters is the third case: a retired engine answering out of the
 * PROMOTED file would mean a connection had transparently followed the rename, which is
 * the assumption `LiveIndex` is built to refuse. That has never been observed in 1,000
 * measured reads, and if it ever is, this fails.
 */
function assertRetiredEngineNeverSeesThePromotedFile(rounds: number): { threw: number; answered: number } {
  let threw = 0;
  let answered = 0;

  for (let i = 0; i < rounds; i++) {
    const path = freshPath("disjunction");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });
    const held = new SearchEngine(path, cfg);
    held.prepareFuzzy();
    // Warm the page cache and the statement cache, as a serving process would have.
    expect(held.byTconst("tt-before")?.title).toBe("Before");

    promoteOver(path, { builtAt: "2026-08-31T00:00:00.000Z", title: "After", tconst: "tt-after" });

    // Read first, assert after: an `expect` inside the `try` would be caught by our own
    // `catch` and re-reported as the wrong failure.
    let read: { title: string | null; builtAt: string | null } | null = null;
    let code: string | undefined;
    try {
      read = { title: held.byTconst("tt-before")?.title ?? null, builtAt: held.meta().built_at ?? null };
    } catch (err) {
      code = (err as { code?: string }).code ?? (err as Error).message;
    }
    try {
      held.close();
    } catch {
      // Already gone.
    }

    if (read) {
      answered++;
      // It answered. Then it MUST be answering out of the file it opened: `tt-before` is
      // gone from the promoted index, and `built_at` there is the 31st.
      expect(read).toEqual({ title: "Before", builtAt: "2026-08-30T00:00:00.000Z" });
    } else {
      threw++;
      // The other branch, and the only error we expect: SQLite refusing a path that now
      // resolves to a different file. Anything else is a real failure worth seeing.
      expect(code).toBe("SQLITE_IOERR_VNODE");
    }
  }

  expect(threw + answered).toBe(rounds);
  return { threw, answered };
}

describe("LiveIndex", () => {
  test("swaps to the promoted file, and `current` serves from it", () => {
    const path = freshPath("swap");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    // floor 0: any index passes, so this test is about the SWAP and not about the gate.
    const live = new LiveIndex({ path, cfg, floor: 0 });
    const first = live.current;
    expect(live.meta().built_at).toBe("2026-08-30T00:00:00.000Z");

    promoteOver(path, { builtAt: "2026-08-31T00:00:00.000Z", title: "After", tconst: "tt-after" });

    const out = live.reload();
    expect(out.ok).toBe(true);
    expect(out.swapped).toBe(true);
    expect(out.builtAt).toBe("2026-08-31T00:00:00.000Z");

    // The reference moved, and the new engine is the one answering.
    expect(live.current).not.toBe(first);
    expect(live.current.byTconst("tt-after")?.title).toBe("After");
    expect(live.current.byTconst("tt-before")).toBeNull();

    live.close();
  });

  test("a promoted-away engine either throws or serves the OLD file -- never the promoted one", () => {
    // 40 promotes rather than one: the two branches are load-dependent, and asserting a
    // single read is exactly the flake this replaces. See the helper.
    const seen = assertRetiredEngineNeverSeesThePromotedFile(40);

    // Both branches are legal, so neither count is asserted -- but every read has to have
    // landed in one of them, and none of them saw the promoted file. Printed because
    // "which branch did this machine take today" is the fact a future reader will want,
    // and it is the difference between an idle laptop and a busy one.
    expect(seen.threw + seen.answered).toBe(40);
    console.log(
      `retired-engine reads: ${seen.threw} threw, ${seen.answered} served the pre-promote file, 0 served the promoted one`,
    );
  });

  test("the swap closes the outgoing engine, so a stale reference fails EVERY time", () => {
    const path = freshPath("retire");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    const live = new LiveIndex({ path, cfg, floor: 0 });
    // The mistake `live.current` exists to make impossible: a reference held across a
    // swap. `LiveIndex`'s own doc comment forbids it, nothing enforces it, and the old
    // grace window meant
    // that when somebody made it anyway they got yesterday's data about 8% of the time.
    const held = live.current;
    expect(held.byTconst("tt-before")?.title).toBe("Before");

    promoteOver(path, { builtAt: "2026-08-31T00:00:00.000Z", title: "After", tconst: "tt-after" });
    expect(live.reload().swapped).toBe(true);

    // Deterministic, and deterministic for OUR reason. `toThrow()` alone would also pass
    // on the ~92% of runs where SQLite happens to catch the rename itself -- which is the
    // assertion this file used to make and the reason it flaked. Matching the message is
    // what distinguishes "we closed it" from "the OS noticed": SQLite's own refusal reads
    // "disk I/O error". If a future bun renames this error, fix the pattern; do not
    // loosen it back to a bare `toThrow()`.
    expect(() => held.byTconst("tt-before")).toThrow(/closed/i);
    expect(() => held.meta()).toThrow(/closed/i);
    expect(() => held.search("before")).toThrow(/closed/i);

    // And the live reference is unaffected -- it is the new engine.
    expect(live.current.byTconst("tt-after")?.title).toBe("After");

    live.close();
  });

  test("a refused candidate ROLLS BACK and serves the previous index again", () => {
    const path = freshPath("rollback");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    const live = new LiveIndex({
      path,
      cfg,
      floor: 0,
      // What `rollback()` does: put `titles.prev.db` back at the live path.
      recover: () => {
        rmSync(path, { force: true });
        renameSync(`${path}.prev`, path);
      },
    });

    // A promoted file that will not open at all -- the exact case that would crash-loop a
    // container if the answer to a bad index were "exit and let Docker restart me".
    renameSync(path, `${path}.prev`);
    writeFileSync(path, "this is not a sqlite file");

    const out = live.reload();
    // It swapped -- to the RESTORED file, not to the one it turned down. `ok` is true
    // because we are serving again; `reason` records what was rejected on the way.
    expect(out.ok).toBe(true);
    expect(out.swapped).toBe(true);
    expect(out.reason).toContain("rolled back");
    expect(out.builtAt).toBe("2026-08-30T00:00:00.000Z");

    // Yesterday's index, answering, with no restart.
    expect(live.current.byTconst("tt-before")?.title).toBe("Before");
    expect(live.current.byTconst("tt-after")).toBeNull();

    live.close();
  });

  test("with no rollback configured, a refusal is reported rather than hidden", () => {
    const path = freshPath("norecover");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    const live = new LiveIndex({ path, cfg, floor: 1 });
    promoteOver(path, { builtAt: "2026-08-31T00:00:00.000Z", title: "After", tconst: "tt-after" });

    const out = live.reload();
    expect(out.ok).toBe(false);
    expect(out.swapped).toBe(false);
    expect(out.reason).toContain("canary");

    // `builtAt` is null because `reload()` refuses to quote an engine whose file has been
    // renamed away -- a DELIBERATE null, not the incidental one this used to rely on.
    // It read the retired engine and reported whatever came back, which meant the same
    // scenario reported `null` or `2026-08-30` depending on machine load: measured
    // 399/400 and 1/400 respectively, the second latent flake in this file. `/api/health`
    // renders this as `index.reload`, the only place an operator sees a refusal without
    // tailing the log, so it saying two different things about one event was the bug.
    expect(out.builtAt).toBeNull();
    expect(out.rows).toBe(0);

    // Same reason, same answer, on the field the health probe reads at the top level.
    expect(live.meta()).toEqual({});

    live.close();
  });

  test("a file that is not a database is refused rather than thrown", () => {
    const path = freshPath("garbage");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    const live = new LiveIndex({ path, cfg, floor: 0 });
    const first = live.current;

    writeFileSync(path, "this is not a sqlite file");

    // A throw here would take down the cron callback and, with it, every later refresh.
    const out = live.reload();
    expect(out.ok).toBe(false);
    expect(out.swapped).toBe(false);
    expect(live.current).toBe(first);

    live.close();
  });

  test("an unchanged file costs nothing and is not a failure", () => {
    const path = freshPath("unchanged");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    // floor 1 would refuse any real candidate. That it returns ok here proves the
    // unchanged check short-circuited BEFORE the canary ran, rather than the canary
    // having somehow passed.
    const live = new LiveIndex({ path, cfg, floor: 1 });
    const first = live.current;

    const out = live.reload();
    expect(out.ok).toBe(true);
    expect(out.swapped).toBe(false);
    expect(out.canary).toBeUndefined();
    expect(live.current).toBe(first);
    // Nothing was renamed, so this is the one path where the engine we hold is still
    // known-good -- and the only reload outcome that may quote its metadata.
    expect(out.builtAt).toBe("2026-08-30T00:00:00.000Z");
    expect(live.meta().built_at).toBe("2026-08-30T00:00:00.000Z");

    live.close();
  });

  test("a rolled-back reload starts describing the index again", () => {
    const path = freshPath("recovered");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    const live = new LiveIndex({
      path,
      cfg,
      floor: 0,
      recover: () => {
        rmSync(path, { force: true });
        renameSync(`${path}.prev`, path);
      },
    });
    renameSync(path, `${path}.prev`);
    writeFileSync(path, "this is not a sqlite file");

    expect(live.reload().swapped).toBe(true);
    // `meta()` goes quiet the moment the file moves, and comes back when a swap gives us
    // an engine opened on the file that is actually there. A refusal must not leave the
    // health probe permanently mute once the system has recovered.
    expect(live.meta().built_at).toBe("2026-08-30T00:00:00.000Z");

    live.close();
  });

  test("lastReload starts null and then reports the most recent attempt", () => {
    const path = freshPath("last");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "Before", tconst: "tt-before" });

    const live = new LiveIndex({ path, cfg, floor: 0 });
    // `/api/health` renders this straight out; null means "no refresh has run yet in this
    // process", which is the normal state for most of a container's life.
    expect(live.lastReload).toBeNull();

    live.reload();
    expect(live.lastReload?.at).toBeString();
    expect(live.lastReload?.swapped).toBe(false);

    live.close();
  });
});

/**
 * The cold start: a holder that exists BEFORE the index does.
 *
 * This is the state the boot-time build serves from, and it is the one state in which
 * `current` is not answerable. The rules below are what let the server listen anyway.
 */
describe("LiveIndex with no index yet", () => {
  test("`allowMissing` constructs against a file that is not there", () => {
    const path = freshPath("cold");
    const live = new LiveIndex({ path, cfg, floor: 0, allowMissing: true });

    expect(live.ready).toBe(false);
    // Not an empty result, not a stub engine: an honest throw. Nothing is meant to catch
    // it -- the route gate refuses first -- so it exists to make a path that forgot the
    // gate fail loudly rather than quietly return nothing.
    expect(() => live.current).toThrow(/no title index is open yet/);
    // The reporting path must not throw even here, because `/api/health` reads it.
    expect(live.meta()).toEqual({});
    expect(live.lastReload).toBeNull();

    live.close();
  });

  test("without `allowMissing` a missing file is still fatal at construction", () => {
    // Everywhere but the boot-build path, a missing index is a fault. Constructing quietly
    // into a dead holder would turn it into a server that answers nothing and says nothing.
    const path = freshPath("cold-strict");
    expect(() => new LiveIndex({ path, cfg, floor: 0 })).toThrow();
  });

  test("open() adopts the index once something else has written it", () => {
    const path = freshPath("adopt");
    const live = new LiveIndex({ path, cfg, floor: 0, allowMissing: true });
    expect(live.ready).toBe(false);

    // What the build subprocess does, from this process's point of view: the file appears.
    writeIndex(path, { builtAt: "2026-08-31T00:00:00.000Z", title: "Fresh", tconst: "tt-fresh" });

    const out = live.open();
    expect(out.ok).toBe(true);
    expect(out.swapped).toBe(true);
    expect(out.builtAt).toBe("2026-08-31T00:00:00.000Z");
    expect(live.ready).toBe(true);
    expect(live.current.byTconst("tt-fresh")?.title).toBe("Fresh");
    expect(live.meta().built_at).toBe("2026-08-31T00:00:00.000Z");

    live.close();
  });

  test("open() on a file that is still not there refuses and stays not-ready", () => {
    const path = freshPath("adopt-missing");
    const live = new LiveIndex({ path, cfg, floor: 0, allowMissing: true });

    const out = live.open();
    expect(out.ok).toBe(false);
    expect(out.swapped).toBe(false);
    expect(out.reason).toBeString();
    expect(live.ready).toBe(false);
    // A refusal is reportable rather than silent -- `/api/health` carries `index.reload`.
    expect(live.lastReload?.ok).toBe(false);

    live.close();
  });

  test("open() applies the canary floor, and a refusal leaves nothing open", () => {
    const path = freshPath("adopt-canary");
    const live = new LiveIndex({ path, cfg, floor: 1, allowMissing: true });
    // A one-row index cannot answer 42 canary cases, so floor 1 refuses it. This is the
    // same bar `reload()` uses -- an index good enough to promote but not good enough to
    // serve is a state nobody should have to reason about. Written AFTER construction, so
    // this is the real shape: the holder came up empty and the build left something bad.
    writeIndex(path, { builtAt: "2026-08-31T00:00:00.000Z", title: "Thin", tconst: "tt-thin" });

    const out = live.open();
    expect(out.ok).toBe(false);
    expect(out.canary?.ratio).toBeLessThan(1);
    expect(live.ready).toBe(false);
    expect(() => live.current).toThrow();

    live.close();
  });

  test("close() on a holder that never opened anything is a no-op", () => {
    // SIGTERM during a first build reaches this. A clean stop must not print a stack trace.
    const live = new LiveIndex({ path: freshPath("cold-close"), cfg, floor: 0, allowMissing: true });
    expect(() => live.close()).not.toThrow();
  });

  test("an existing file is opened normally even with `allowMissing`", () => {
    // The flag says "tolerate absence", not "start empty". The boot path passes it whenever
    // the file was missing at the check, and a file appearing in between must still be used.
    const path = freshPath("cold-present");
    writeIndex(path, { builtAt: "2026-08-30T00:00:00.000Z", title: "There", tconst: "tt-there" });

    const live = new LiveIndex({ path, cfg, floor: 0, allowMissing: true });
    expect(live.ready).toBe(true);
    expect(live.current.byTconst("tt-there")?.title).toBe("There");

    live.close();
  });
});
