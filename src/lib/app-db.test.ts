/*
  THE APP DB HAS TWO WRITERS IN TWO PROCESSES, AND UNTIL 2026-09-07 IT HAD NO `busy_timeout`.

  This is not a hypothetical. `src/jobs/build-index.ts` opens `new DumpStateStore(p.appDb)`
  -- the SAME `finderr.db` the running server holds open -- and `src/server/index-build.ts`
  runs that job through `Bun.spawn`, as a separate OS process. So the boot rebuild and the
  live server write the same file concurrently, by design, and the design is right: the
  build genuinely needs to record which dumps it fetched.

  What was wrong is that neither connection set `busy_timeout`, and SQLite's default is
  ZERO. WAL lets a reader proceed against a writer; it does NOT let two writers overlap, and
  with a zero timeout the loser does not wait, it THROWS immediately.

  MEASURED ON THE LIVE NAS, 2026-09-07, on the boot rebuild after the deploy of `35779fd`:
  8 `SQLITE_BUSY: database is locked`, 3 of them `[finderr] unhandled` -- because
  `touchSession` is called from `principal()` on the auth path with nothing catching it, so
  a lost lock race on a session bookkeeping write surfaced as an unhandled exception.

  The test spawns a REAL second process, because that is the real shape. Two `Database`
  handles inside one process serialise on SQLite's own connection mutex and would not
  reproduce it -- a single-process reproduction would pass against the broken code and
  prove nothing.
*/

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DB_BUSY_TIMEOUT_MS, openAppDb } from "./app-db";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finderr-appdb-"));
  path = join(dir, "finderr.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/*
  A second PROCESS that takes the write lock and holds it for `holdMs`, then commits.

  `begin immediate` is what makes this deterministic: it acquires the write lock at BEGIN
  rather than at the first write, so by the time the child prints `locked` the lock is
  genuinely held and the parent is not racing the child's own first statement.
*/
function holdWriteLock(dbPath: string, holdMs: number) {
  const script = `
    const { Database } = require("bun:sqlite");
    const db = new Database(${JSON.stringify(dbPath)}, { create: true });
    db.run("pragma journal_mode = wal");
    db.run("create table if not exists probe (k text primary key, v text)");
    db.run("begin immediate");
    db.run("insert or replace into probe values ('child', 'held')");
    process.stdout.write("locked\\n");
    await Bun.sleep(${holdMs});
    db.run("commit");
    db.close();
  `;
  return Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
}

/** Read from the child's stdout until it says it holds the lock. */
async function awaitLocked(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("locked")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`child exited before taking the lock: ${seen}`);
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
}

describe("the app DB survives a second process holding the write lock", () => {
  test("a write WAITS for the other process instead of throwing SQLITE_BUSY", async () => {
    // Create the table first, so the parent's write is the only thing contending.
    const setup = openAppDb(path);
    setup.run("create table if not exists probe (k text primary key, v text)");
    setup.close();

    const child = holdWriteLock(path, 400);
    try {
      await awaitLocked(child);

      const db = openAppDb(path);
      const started = Bun.nanoseconds();
      /*
        THIS IS THE ASSERTION THE BUG FAILED. With `busy_timeout` unset it throws
        `SQLITE_BUSY: database is locked` in under a millisecond. With it set, the call
        blocks until the child commits and then succeeds.
      */
      expect(() => db.run("insert or replace into probe values ('parent', 'ok')")).not.toThrow();
      const waitedMs = (Bun.nanoseconds() - started) / 1e6;
      db.close();

      /*
        It must actually have WAITED, not merely not-thrown. A future change that swallowed
        the error, or dropped WAL and let the write land somewhere else, would pass the line
        above and fail this one. 200ms is half the hold, so the check is not tight enough to
        flake on a loaded machine while still being impossible for an instant failure.
      */
      expect(waitedMs).toBeGreaterThan(200);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("the timeout is bounded, so a stuck writer cannot hang the process forever", () => {
    const db = openAppDb(path);
    const timeout = db.query("pragma busy_timeout").get() as { timeout: number };
    db.close();
    expect(timeout.timeout).toBe(APP_DB_BUSY_TIMEOUT_MS);
    expect(APP_DB_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("every app-DB connection is WAL, so a reader is never blocked by the writer", () => {
    const db = openAppDb(path);
    const mode = db.query("pragma journal_mode").get() as { journal_mode: string };
    db.close();
    expect(mode.journal_mode).toBe("wal");
  });
});

/*
  The regression this file exists to prevent is a SECOND opener that forgets the pragmas.
  Both writers of `finderr.db` must go through `openAppDb`, or the one that does not
  inherits the original bug -- and it would fail exactly where this one did, on the live
  NAS, under a boot rebuild, and nowhere in the suite.
*/
describe("nothing opens the app DB behind openAppDb's back", () => {
  test("Store and DumpStateStore both route through openAppDb", async () => {
    for (const file of ["./store.ts", "./dumps.ts"]) {
      const src = await Bun.file(new URL(file, import.meta.url).pathname).text();
      expect(src).toContain("openAppDb");
      // `new Database(` on the app path is the shape that skips the pragmas.
      expect(src).not.toMatch(/new Database\(\s*(paths\(cfg\)\.appDb|path,\s*\{\s*create)/);
    }
  });
});

/*
  A plain `new Database` with no busy_timeout is what the bug WAS. Pinning that it still
  fails proves this suite can go RED -- a test that cannot fail is not a test.
  See CLAUDE.md: "a check that passes is not a check that works".
*/
test("the unguarded shape still throws, so the check above is real", async () => {
  const setup = new Database(path, { create: true });
  setup.run("pragma journal_mode = wal");
  setup.run("create table if not exists probe (k text primary key, v text)");
  setup.close();

  const child = holdWriteLock(path, 400);
  try {
    await awaitLocked(child);
    const bare = new Database(path); // no busy_timeout -- SQLite's default is 0
    expect(() => bare.run("insert or replace into probe values ('parent', 'ok')")).toThrow(
      /database is locked/i,
    );
    bare.close();
  } finally {
    child.kill();
    await child.exited;
  }
});
