/**
 * Remembering where a file can be cut, so only the FIRST play of it ever pays to find out.
 *
 * `keyframes.ts` answers "where can this be cut" three ways, and the two that touch the disk
 * cost 4-53 ms (the container's own index) or up to a minute (the ffprobe seek probe, on a
 * cold file over the array). Neither of them is free, and **nothing cached either until this
 * table existed** -- the probe was paid again on every session start, for every title, forever.
 *
 * A cut list is a few thousand numbers, which is kilobytes. This is the third rule applied to
 * playback: precompute it, store the derived thing, and let a click read one row.
 *
 * > [!CAUTION] THE KEY IS `path` PLUS `size`, AND THE SIZE IS THE WHOLE INVALIDATION STORY
 * > The arr stack's rule is replacement-first -- download the better release, verify it, then
 * > delete -- so a title's file being REPLACED at the same path is the ordinary case here
 * > rather than an edge, and a replacement is a different size. `arr_file_id` would NOT do:
 * > the arrs reuse a file id across a replacement.
 * >
 * > A stale cut point is worse than no cut point. It puts a boundary in the playlist that the
 * > file cannot honour, which is exactly the uniform-grid failure the container reader exists
 * > to remove -- except silent, and except it would survive a restart.
 *
 * > [!IMPORTANT] A FAILURE IS CACHED TOO, AND ONLY FOR A WHILE
 * > "This file has no index we can read" is a real answer and re-deriving it means paying the
 * > 30 s probe timeout on every play of that title. But unlike a cut list it is not certain:
 * > the probe also fails on a timeout, an unmounted share or a machine having a bad minute, and
 * > those clear up. So a negative answer expires (`NEGATIVE_TTL_MS`) and a positive one does
 * > not -- a positive answer is a fact about bytes that have not changed.
 */

import type { Database } from "bun:sqlite";
import type { CutFinding, CutLookup, CutOrigin, CutPointCache } from "./keyframes";

/**
 * How long a "nothing usable in this file" answer is believed.
 *
 * Long enough that a title played twice in an evening does not pay the probe timeout twice,
 * short enough that a share which was unmounted this morning is not written off until
 * somebody notices. Six hours is a judgement rather than a measurement; the failure mode of
 * being wrong in either direction is one wasted probe, so it is not worth tuning.
 */
export const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * NOTE: no backticks in this string -- it is a template literal, and one would end it.
 *
 * `cuts` is JSON rather than a packed blob: a few thousand floats is kilobytes either way, and
 * a row a human can read in a SQLite shell is worth more than the bytes. NULL means the
 * measurement happened and found nothing usable, which is why `origin` is nullable with it --
 * one fact, not two that can disagree.
 */
export const KEYFRAME_CACHE_SCHEMA = `
create table if not exists media_keyframe (
  path        text not null,
  size        integer not null,
  cuts        text,
  origin      text,
  measured_at text not null,
  primary key (path, size)
);
`;

export function applyKeyframeCacheSchema(db: Database): void {
  db.run(KEYFRAME_CACHE_SCHEMA);
}

interface Row {
  cuts: string | null;
  origin: string | null;
  measured_at: string;
}

/**
 * The cut points this server has already learned, by file.
 *
 * Synchronous like every other store here: `bun:sqlite` is synchronous, and this is read on the
 * one path where a human is waiting.
 *
 * The clock is a constructor argument so the expiry can be tested without waiting six hours.
 */
export class KeyframeCacheStore implements CutPointCache {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  lookup(path: string, size: number): CutLookup {
    const row = this.db
      .query("select cuts, origin, measured_at from media_keyframe where path = ? and size = ?")
      .get(path, size) as Row | undefined;
    if (!row) return { known: false };

    if (row.cuts === null) {
      const age = this.now().getTime() - Date.parse(row.measured_at);
      // A measurement from the future is a clock that moved, not an answer worth trusting.
      return age >= 0 && age < NEGATIVE_TTL_MS ? { known: true, finding: null } : { known: false };
    }
    const finding = parseFinding(row);
    return finding ? { known: true, finding } : { known: false };
  }

  /**
   * Write down what a file answered, and forget what any OTHER size of the same path answered.
   *
   * The delete is the tidying half of the replacement story: the key already makes a replaced
   * file a miss, and this stops the row for the version that was replaced from sitting there
   * forever. One statement, in the same call, so there is no separate sweep to forget to run.
   */
  remember(path: string, size: number, finding: CutFinding): void {
    this.db.run(
      "insert or replace into media_keyframe (path, size, cuts, origin, measured_at) values (?,?,?,?,?)",
      [
        path,
        size,
        finding ? JSON.stringify(finding.cuts) : null,
        finding?.origin ?? null,
        this.now().toISOString(),
      ],
    );
    this.db.run("delete from media_keyframe where path = ? and size <> ?", [path, size]);
  }
}

/**
 * A stored row back into a finding, or null when it cannot be trusted.
 *
 * Anything unreadable is treated as a MISS rather than as an empty answer: the row was written
 * by an older version of this code or by something that went wrong, and re-measuring costs one
 * probe while believing a broken row costs a broken playlist.
 */
function parseFinding(row: Row): CutFinding {
  if (row.cuts === null) return null;
  if (row.origin !== "container" && row.origin !== "probe") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.cuts);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const cuts = parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  return cuts.length > 0 ? { cuts, origin: row.origin as CutOrigin } : null;
}
