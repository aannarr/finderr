/*
  THE ONE OWNER OF HOW `finderr.db` IS OPENED.

  There are TWO writers of the app database and they are in TWO PROCESSES. That is not an
  accident to be designed away:

    - the server, through `Store` (sessions, requests, the facet cache, both mirrors)
    - `src/jobs/build-index.ts`, through `DumpStateStore`, which records which IMDb dumps
      it fetched -- and which `src/server/index-build.ts` and `src/server/index-refresh.ts`
      both run via `Bun.spawn`, as a child process, precisely so a 6-minute build cannot
      block the event loop that is serving pages.

  So the boot rebuild writes `dump_state` while the server writes `session`. Two processes,
  one SQLite file, concurrently, by design.

  > [!CAUTION] WAL DOES NOT MAKE TWO WRITERS SAFE, AND SQLITE'S DEFAULT TIMEOUT IS ZERO
  > This was measured on the live NAS on 2026-09-07, on the boot rebuild triggered by the
  > deploy of `35779fd`: 8 `SQLITE_BUSY: database is locked`, three of them logged as
  > `[finderr] unhandled`, plus five facet writes lost for one title.
  >
  > WAL buys a reader that never blocks on a writer. It buys NOTHING for writer-vs-writer:
  > there is still exactly one write lock. With `busy_timeout` unset the loser of that race
  > does not wait its turn -- it throws immediately, in under a millisecond.
  >
  > The one that hurt was `AuthStore.touchSession`, called from `principal()` on the auth
  > path with nothing catching it. A session's `last_seen_at` is bookkeeping; losing a lock
  > race on it took down the request.

  The fix is the boring one and it is the right one: WAIT. Every writer of this file sets
  the same timeout from the same constant.
*/
import { Database } from "bun:sqlite";

/*
  HOW LONG A WRITER WAITS FOR THE OTHER PROCESS BEFORE GIVING UP.

  Five seconds, and the number is a trade rather than a default. `bun:sqlite` is
  SYNCHRONOUS, so a blocked write blocks this process's event loop for as long as it waits
  -- which is why an unbounded timeout is wrong even though it would never throw.

  Five seconds is safe because of what the contending writes actually ARE: `dump_state` is
  five rows over a whole build, one per IMDb dump, each a single-row upsert. Nothing on
  either side holds the write lock for a meaningful time, so the REALISTIC wait is
  sub-millisecond and the timeout is a ceiling nobody reaches, not a budget anybody spends.

  A write that genuinely waits five seconds means something is stuck, and throwing then is
  correct -- it is a real fault, and it reaches a log instead of hanging the server for
  ever. Do not raise this to paper over a slow write; find the slow write.
*/
export const APP_DB_BUSY_TIMEOUT_MS = 5_000;

/**
 * Open a connection to the app database with the pragmas every writer of it must have.
 *
 * `create` defaults to true because both real callers want the file made on a fresh data
 * directory; a reader that must not create one passes `false`.
 *
 * This does NOT apply a schema. `Store` owns the app schema and applies it after opening;
 * `DumpStateStore` owns its own one table. Putting the schema here would make the build
 * subprocess apply the whole app schema, which is a much bigger claim than it needs.
 */
export function openAppDb(path: string, opts?: { create?: boolean }): Database {
  const db = new Database(path, { create: opts?.create ?? true });
  /*
    ORDER MATTERS ONLY IN THAT `busy_timeout` MUST BE SET BEFORE ANY CONTENDED STATEMENT.
    Setting the journal mode is itself a write on a fresh file, so the timeout goes FIRST
    -- otherwise the very statement that turns on WAL is the one that can lose the race,
    on exactly the cold-boot path where both processes start at once.
  */
  db.run(`pragma busy_timeout = ${APP_DB_BUSY_TIMEOUT_MS}`);
  db.run("pragma journal_mode = wal");
  db.run("pragma synchronous = normal");
  return db;
}
