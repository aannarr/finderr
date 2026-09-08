/**
 * The keyframe cache, against a real SQLite database in memory.
 *
 * In memory rather than mocked, because the interesting behaviour IS the schema: the primary
 * key is what makes a replaced file a miss, and a test against a fake Map would prove nothing
 * about the thing that ships.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { applyKeyframeCacheSchema, KeyframeCacheStore, NEGATIVE_TTL_MS } from "./keyframe-cache";

let db: Database;
let clock: Date;
let cache: KeyframeCacheStore;

beforeEach(() => {
  db = new Database(":memory:");
  applyKeyframeCacheSchema(db);
  clock = new Date("2026-09-08T12:00:00.000Z");
  cache = new KeyframeCacheStore(db, () => clock);
});

describe("remembering where a file can be cut", () => {
  test("a file nobody has measured is a miss", () => {
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({ known: false });
  });

  test("what was written comes back, with how it was found", () => {
    cache.remember("/plex/a.mkv", 1000, { cuts: [11.011, 21.021], origin: "container" });
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({
      known: true,
      finding: { cuts: [11.011, 21.021], origin: "container" },
    });
  });

  test("writing twice replaces rather than conflicting", () => {
    cache.remember("/plex/a.mkv", 1000, { cuts: [12], origin: "probe" });
    cache.remember("/plex/a.mkv", 1000, { cuts: [12, 24], origin: "container" });
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({
      known: true,
      finding: { cuts: [12, 24], origin: "container" },
    });
  });

  /**
   * The arr stack replaces a release in place -- download the better one, verify it, delete the
   * old -- so this is the ordinary case rather than an edge, and a hit here would put a
   * boundary in the playlist that the new file cannot honour.
   */
  test("the same path at a different size is a MISS", () => {
    cache.remember("/plex/a.mkv", 1000, { cuts: [12, 24], origin: "container" });
    expect(cache.lookup("/plex/a.mkv", 2000)).toEqual({ known: false });
  });

  test("measuring the replacement forgets the release it replaced", () => {
    cache.remember("/plex/a.mkv", 1000, { cuts: [12, 24], origin: "container" });
    cache.remember("/plex/a.mkv", 2000, { cuts: [18], origin: "container" });
    const rows = db.query("select size from media_keyframe where path = ?").all("/plex/a.mkv");
    expect(rows).toEqual([{ size: 2000 }]);
  });

  test("two files are two rows", () => {
    cache.remember("/plex/a.mkv", 1000, { cuts: [12], origin: "container" });
    cache.remember("/plex/b.mkv", 1000, { cuts: [24], origin: "container" });
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({
      known: true,
      finding: { cuts: [12], origin: "container" },
    });
    expect(cache.lookup("/plex/b.mkv", 1000)).toEqual({
      known: true,
      finding: { cuts: [24], origin: "container" },
    });
  });
});

describe("remembering that there was nothing to find", () => {
  test("a measured failure is a hit, so the next play does not pay the probe again", () => {
    cache.remember("/plex/a.mp4", 1000, null);
    expect(cache.lookup("/plex/a.mp4", 1000)).toEqual({ known: true, finding: null });
  });

  /**
   * Unlike a cut list, a failure is not certain: the probe also fails on a timeout or an
   * unmounted share, and those clear up. So it expires and a positive answer does not.
   */
  test("it expires, and then the file is measured again", () => {
    cache.remember("/plex/a.mp4", 1000, null);
    clock = new Date(clock.getTime() + NEGATIVE_TTL_MS + 1);
    expect(cache.lookup("/plex/a.mp4", 1000)).toEqual({ known: false });
  });

  test("a cut list does NOT expire -- it is a fact about bytes that have not changed", () => {
    cache.remember("/plex/a.mkv", 1000, { cuts: [12], origin: "container" });
    clock = new Date(clock.getTime() + 100 * NEGATIVE_TTL_MS);
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({
      known: true,
      finding: { cuts: [12], origin: "container" },
    });
  });

  /** A clock that jumped backwards is not evidence, and re-measuring costs one probe. */
  test("a measurement from the future is not believed", () => {
    cache.remember("/plex/a.mp4", 1000, null);
    clock = new Date(clock.getTime() - 60_000);
    expect(cache.lookup("/plex/a.mp4", 1000)).toEqual({ known: false });
  });
});

describe("a row that cannot be trusted is a miss, never an answer", () => {
  const writeRow = (cuts: string | null, origin: string | null) =>
    db.run(
      "insert or replace into media_keyframe (path, size, cuts, origin, measured_at) values (?,?,?,?,?)",
      ["/plex/a.mkv", 1000, cuts, origin, clock.toISOString()],
    );

  test("cuts that are not JSON", () => {
    writeRow("not json", "container");
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({ known: false });
  });

  test("cuts that are not a list of numbers", () => {
    writeRow(JSON.stringify({ nope: true }), "container");
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({ known: false });
  });

  test("an origin this version does not know", () => {
    writeRow(JSON.stringify([12]), "sorcery");
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({ known: false });
  });

  test("a list with nothing usable in it", () => {
    writeRow(JSON.stringify([0, -3, "twelve", null]), "container");
    expect(cache.lookup("/plex/a.mkv", 1000)).toEqual({ known: false });
  });
});
