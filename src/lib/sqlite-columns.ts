/**
 * Columns added to a table after its first release, applied to databases that already exist.
 *
 * `create table if not exists` is a no-op on a live database, so a column added to a schema
 * string reaches a fresh install and NO deployed one. Every schema in this app therefore
 * declares a late column here rather than in its `create table`, and this is the one place
 * that applies them.
 *
 * > [!IMPORTANT] ONE SPELLING PER COLUMN, and that is the whole reason this is shared
 * > A column written into BOTH a `create table` and an ALTER has two spellings, and only the
 * > `create table` is exercised by tests -- every suite here opens an empty in-memory
 * > database. The ALTER is then the untested half, running for the first time against the
 * > live file. Declaring the column only here means the test databases and the deployed one
 * > take the same path.
 */

import type { Database } from "bun:sqlite";

export interface AddedColumn {
  table: string;
  column: string;
  ddl: string;
  /**
   * One statement run ONCE, immediately after the column is added, and never again.
   *
   * For a column whose correct value on an existing row is not its default. Without this a
   * migration can only say "unknown" about history, and the reader pays for it -- see
   * `request.available_seen_at`, where the default would announce every request the
   * instance has ever completed as unread news.
   */
  backfill?: string;
}

/** Idempotent: adds any column in `columns` that `db` does not already have. */
export function addMissingColumns(db: Database, columns: readonly AddedColumn[]): void {
  for (const { table, column, ddl, backfill } of columns) {
    const cols = db.query(`pragma table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) continue;
    db.run(ddl);
    // Inside the same branch, so it runs exactly once -- on the boot that adds the column
    // and never on any boot after it. A backfill outside this guard would be a statement
    // re-run against live data every restart.
    if (backfill) db.run(backfill);
  }
}
