/**
 * Where each reader stopped: a play position per title, and per episode for a series.
 *
 * ITS OWN MODULE, applied by `Store`'s constructor, for the reason `watchlist.ts` gives: this
 * is content one reader owns, not a mirror of somebody else's machine and not identity. It
 * cascades off `app_user`, so an account that is deleted takes its history with it.
 *
 * > [!IMPORTANT] ON A HOT-ISH PATH: the player writes here every ~15 s per viewer
 * > So every statement goes through `db.query`, which compiles once and caches, and the write is
 * > ONE upsert that reads nothing first -- the primary key decides insert versus update.
 * > Measured numbers for the write and the per-title read are on the card.
 *
 * Synchronous throughout, like every store here: `bun:sqlite` is synchronous and no handler
 * may await its own database.
 */

import type { Database } from "bun:sqlite";
import { isoNow } from "./auth";
import { NOT_AN_EPISODE } from "./media-file";
import { isFinished, type WatchEntry, type WatchHistoryPage } from "./watch-progress";

/**
 * > [!IMPORTANT] `applyAuthSchema` MUST have run first -- see `WATCHLIST_SCHEMA` for why.
 *
 * WITHOUT ROWID, because the primary key IS the row's address and every read seeks it: a rowid
 * table would store the key twice and pay a second lookup per row.
 *
 * TWO access paths and only one extra index:
 *  - "every entry of this title for this reader" is the PRIMARY KEY's own prefix
 *    `(user_id, tconst)`, already ordered by season then episode -- a second index there would
 *    be the same b-tree kept twice.
 *  - history is `ix_watch_state_user_updated`. The trailing key columns are declared so the
 *    tie-break in `history()` is served by the index too, and `watch-state.test.ts` pins that
 *    neither read builds a temp b-tree.
 *
 * NOTE: no backticks in this string -- it is a template literal, and one would end it.
 */
export const WATCH_STATE_SCHEMA = `
create table if not exists watch_state (
  user_id      text    not null references app_user(id) on delete cascade,
  tconst       text    not null,
  season       integer not null,
  episode      integer not null,
  position_sec real    not null,
  duration_sec real    not null,
  finished     integer not null check (finished in (0, 1)),
  updated_at   text    not null,
  primary key (user_id, tconst, season, episode)
) without rowid;
create index if not exists ix_watch_state_user_updated
  on watch_state(user_id, updated_at desc, tconst, season, episode);
`;

export function applyWatchStateSchema(db: Database): void {
  db.run(WATCH_STATE_SCHEMA);
}

/** Which playable thing: a film is `FILM_KEY`, an episode its own numbers. */
export interface WatchKey {
  season: number;
  episode: number;
}

/** The key of a film. Spelled through the sentinel so a reader finds `NOT_AN_EPISODE`'s comment. */
export const FILM_KEY: WatchKey = { season: NOT_AN_EPISODE, episode: NOT_AN_EPISODE };

interface WatchRow {
  tconst: string;
  season: number;
  episode: number;
  position_sec: number;
  duration_sec: number;
  finished: number;
  updated_at: string;
}

const COLUMNS = "tconst, season, episode, position_sec, duration_sec, finished, updated_at";

/** Exported so `watch-state.test.ts` EXPLAINs the exact statement the store runs, not a copy. */
export const FOR_TITLE_SQL = `select ${COLUMNS} from watch_state where user_id = ? and tconst = ? order by season asc, episode asc`;

/** Same reason. `limit + 1` is bound by `history()`. */
export const HISTORY_SQL =
  `select ${COLUMNS} from watch_state where user_id = ? ` +
  "order by updated_at desc, tconst asc, season asc, episode asc limit ? offset ?";

function toEntry(r: WatchRow): WatchEntry {
  const film = r.season === NOT_AN_EPISODE;
  return {
    tconst: r.tconst,
    season: film ? null : r.season,
    episode: film ? null : r.episode,
    positionSec: r.position_sec,
    durationSec: r.duration_sec,
    finished: r.finished === 1,
    updatedAt: r.updated_at,
  };
}

export class WatchStateStore {
  constructor(private readonly db: Database) {}

  /**
   * Store where this reader is. Returns the entry as stored, so a caller needs no second read.
   *
   * `finished` is decided on EVERY write rather than latched: a reader who restarts a finished
   * episode is watching it again, and a latched flag would then disagree with the position
   * stored beside it. `now` is injected so ordering tests describe data rather than the clock.
   */
  upsert(
    userId: string,
    tconst: string,
    at: WatchKey & { positionSec: number; durationSec: number },
    now: Date = new Date(),
  ): WatchEntry {
    const row: WatchRow = {
      tconst,
      season: at.season,
      episode: at.episode,
      position_sec: at.positionSec,
      duration_sec: at.durationSec,
      finished: isFinished(at.positionSec, at.durationSec) ? 1 : 0,
      updated_at: isoNow(now),
    };
    this.db
      .query(
        "insert into watch_state (user_id, tconst, season, episode, position_sec, duration_sec, finished, updated_at) " +
          "values (?,?,?,?,?,?,?,?) on conflict (user_id, tconst, season, episode) do update set " +
          "position_sec = excluded.position_sec, duration_sec = excluded.duration_sec, " +
          "finished = excluded.finished, updated_at = excluded.updated_at",
      )
      .run(
        userId,
        tconst,
        row.season,
        row.episode,
        row.position_sec,
        row.duration_sec,
        row.finished,
        row.updated_at,
      );
    return toEntry(row);
  }

  /** One entry, or null. */
  get(userId: string, tconst: string, at: WatchKey): WatchEntry | null {
    const r = this.db
      .query(
        `select ${COLUMNS} from watch_state where user_id = ? and tconst = ? and season = ? and episode = ?`,
      )
      .get(userId, tconst, at.season, at.episode) as WatchRow | null;
    return r ? toEntry(r) : null;
  }

  /** Every entry this reader has for one title, season then episode. A film is one row. */
  forTitle(userId: string, tconst: string): WatchEntry[] {
    const rows = this.db.query(FOR_TITLE_SQL).all(userId, tconst) as WatchRow[];
    return rows.map(toEntry);
  }

  /**
   * One page of this reader's plays, newest first, one row per film or episode.
   *
   * Reads `limit + 1` so `hasMore` costs no count. The tie-break is on the key, so two writes in
   * one millisecond still page stably.
   */
  history(userId: string, page: { limit: number; offset: number }): WatchHistoryPage {
    const rows = this.db.query(HISTORY_SQL).all(userId, page.limit + 1, page.offset) as WatchRow[];
    return { entries: rows.slice(0, page.limit).map(toEntry), hasMore: rows.length > page.limit };
  }

  /** Forget one entry, or every entry for the title when `at` is omitted. Returns rows removed. */
  remove(userId: string, tconst: string, at?: WatchKey): number {
    const { changes } = at
      ? this.db
          .query("delete from watch_state where user_id = ? and tconst = ? and season = ? and episode = ?")
          .run(userId, tconst, at.season, at.episode)
      : this.db.query("delete from watch_state where user_id = ? and tconst = ?").run(userId, tconst);
    return Number(changes);
  }
}
