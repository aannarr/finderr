/**
 * A list you keep, that downloads nothing.
 *
 * "Save this for later" is the one concrete Seerr feature finderr did not have, and it is
 * deliberately the HALF of the watchlist idea that carries no risk: saving a title writes one
 * row here and calls no arr, spends no quota and starts no search. Nothing in this file may
 * ever reach `src/lib/arr.ts` -- a timer that turned a saved title into a download is the
 * archived `finderr-watchlist-auto-request-from-plex-or-trakt` card, which was archived
 * because a dead OAuth token had already auto-added unattended once.
 *
 * IT IS ITS OWN MODULE RATHER THAN A TABLE IN `store.ts` OR `auth-store.ts`, and the split is
 * along the line those two already draw: `auth-store.ts` is identity plus the things that die
 * with an account, `store.ts` is the mirrors of somebody else's machine. This is neither -- it
 * is content one reader owns -- so it gets its own schema, its own class and its own tests,
 * and `Store`'s constructor applies it exactly as it applies the auth schema.
 *
 * Every method is synchronous, like `AuthStore`'s: `bun:sqlite` is synchronous and the render
 * path is not allowed to await anything.
 */

import type { Database } from "bun:sqlite";
import { isoNow } from "./auth";

/**
 * > [!IMPORTANT] `applyAuthSchema` MUST have run first
 * > `on delete cascade` here is the whole reason a private list disappears with the account
 * > that kept it, and SQLite resolves a foreign key at INSERT time rather than at CREATE
 * > time -- so declaring this against a missing `app_user` fails silently now and loudly on
 * > the first save. `Store`'s constructor calls the two in order; `open()` in the tests does
 * > the same, so the ordering is exercised rather than assumed.
 *
 * The primary key is (user_id, tconst), which is what makes saving twice a no-op instead of a
 * second row -- there is no "already saved?" read anywhere in this file, because the schema
 * answers it. Two readers saving the same film are two rows, correctly: the list is private.
 *
 * NOTE: no backticks in this string -- it is a template literal, and one would end it.
 */
export const WATCHLIST_SCHEMA = `
create table if not exists watchlist (
  user_id  text not null references app_user(id) on delete cascade,
  tconst   text not null,
  added_at text not null,
  primary key (user_id, tconst)
);
-- Newest first is the ONLY order this list is ever read in, so the index carries it. The
-- primary key already covers "is this one mine"; this covers the page.
create index if not exists ix_watchlist_user_added on watchlist(user_id, added_at desc);
`;

export function applyWatchlistSchema(db: Database): void {
  db.run(WATCHLIST_SCHEMA);
}

/** One saved title, as stored. The title itself is looked up in the index by `tconst`. */
export interface WatchlistEntry {
  tconst: string;
  /** ISO 8601. What the list is ordered by, newest first. */
  added_at: string;
}

/**
 * What `/api/health` reports, and the shape of it is the point.
 *
 * COUNTS, never identities -- the same rule `auth` and `push` already follow on that
 * endpoint. It says the feature is being used without saying whose list holds what, which is
 * the only honest thing to publish about a list whose whole promise is that it is private.
 */
export interface WatchlistStats {
  /** Saved titles across every account. */
  rows: number;
  /** How many accounts have saved at least one thing. */
  readers: number;
}

export class WatchlistStore {
  constructor(private readonly db: Database) {}

  /**
   * Save a title. Returns whether this was NEW, so a caller can tell a save from a re-save.
   *
   * `insert or ignore` rather than a read-then-write: the composite primary key is what makes
   * a double-click one row, and doing it in one statement means there is no window between
   * the check and the insert for a second tab to slip through.
   *
   * `now` is injected rather than read here so a test can pin the ordering the list depends
   * on, which is the same reason `listDecades` takes a year.
   */
  add(userId: string, tconst: string, now: Date = new Date()): boolean {
    const { changes } = this.db.run(
      "insert or ignore into watchlist (user_id, tconst, added_at) values (?,?,?)",
      [userId, tconst, isoNow(now)],
    );
    return Number(changes) > 0;
  }

  /** Un-save a title. Returns whether there was anything to remove. */
  remove(userId: string, tconst: string): boolean {
    const { changes } = this.db.run("delete from watchlist where user_id = ? and tconst = ?", [
      userId,
      tconst,
    ]);
    return Number(changes) > 0;
  }

  /**
   * One reader's whole list, newest save first.
   *
   * UNBOUNDED, DELIBERATELY, and it is the one query in the product that is. A watchlist is
   * maintained by hand one title at a time, so its natural ceiling is human patience rather
   * than a number anybody could pick -- and a limit here would be worse than no limit: the
   * rows past it could never be drawn, so they could never be removed either, which is a
   * dead end on the only page that can undo a save. If a real list ever grows past what one
   * page should draw, paging it is a card, not a silent truncation.
   */
  list(userId: string): WatchlistEntry[] {
    return this.db
      .query("select tconst, added_at from watchlist where user_id = ? order by added_at desc, tconst asc")
      .all(userId) as WatchlistEntry[];
  }

  /** Counts only -- see `WatchlistStats` for why it can never be anything else. */
  stats(): WatchlistStats {
    // Aliased `n` rather than `rows`: ROWS is a keyword in SQLite's window-function grammar,
    // and a column alias that is only sometimes legal is not worth the two saved characters.
    const row = this.db
      .query("select count(*) as n, count(distinct user_id) as readers from watchlist")
      .get() as { n: number; readers: number };
    return { rows: row.n, readers: row.readers };
  }
}
