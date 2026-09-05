import { describe, expect, test } from "bun:test";
import { profileDrift, STORAGE_PROFILES } from "./bench-profiles";
import { allIndexes } from "./index-builder";

/**
 * The one thing that can silently invalidate a storage-profile measurement.
 *
 * A profile is a list of `create index` statements written out by hand. Add an index to
 * `INDEXES` and forget to account for it here, and the variant profile INHERITS the wide
 * version -- so the run reports a smaller difference than the real one, in the direction that
 * argues against doing anything. The harness prints the drift, and this makes it fail instead.
 */
describe("storage profiles account for every shipped index", () => {
  const shipped = allIndexes();

  for (const profile of Object.values(STORAGE_PROFILES)) {
    test(`${profile.name} has no drift against INDEXES`, () => {
      const { missing, extra } = profileDrift(shipped, profile);
      expect({ name: profile.name, missing, extra }).toEqual({ name: profile.name, missing: [], extra: [] });
    });
  }

  test("the baseline declares no indexes of its own", () => {
    // `shipped` must stay a null passthrough rather than a copy of `allIndexes()`. A copy is a
    // second owner of the shipped shape and would drift from it the same way the variants can --
    // except silently, because a copy of the baseline cannot fail a drift check against itself.
    expect(STORAGE_PROFILES.shipped?.indexes).toBeNull();
  });

  test("every variant is strictly smaller than shipped, never a rename", () => {
    // A variant exists to REMOVE bytes. One that names an index the shipped build does not have
    // is measuring a shape nobody would ever deploy, which is a different experiment wearing
    // this one's clothes.
    const shippedNames = new Set(shipped.map((s) => s.match(/create index (?:\w+ )?(\w+)/i)?.[1]));
    for (const profile of Object.values(STORAGE_PROFILES)) {
      if (!profile.indexes) continue;
      expect(profile.indexes.length).toBeLessThanOrEqual(shipped.length);
      for (const sql of profile.indexes) {
        expect(shippedNames).toContain(sql.match(/create index (?:\w+ )?(\w+)/i)?.[1]);
      }
    }
  });

  test("slimPayload keeps ix_year's sort column and slim does not -- the difference IS the experiment", () => {
    // Pinned because it is the distinction the two variants exist to separate, and because
    // `slim` losing `votes desc` here was measured at 278x slower warm on `browse.decade`.
    // Somebody tidying these lists together would erase the finding.
    const yearOf = (p: keyof typeof STORAGE_PROFILES): string =>
      STORAGE_PROFILES[p]?.indexes?.find((s) => s.includes("ix_year")) ?? "";
    expect(yearOf("slimPayload")).toContain("votes desc");
    expect(yearOf("slim")).not.toContain("votes desc");
  });
});
