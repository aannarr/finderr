/**
 * Env-as-seed, DB-as-truth -- asserted rather than asserted-in-a-docstring.
 *
 * The whole module exists so that ONE thing decides which of two sources wins, so the tests
 * that matter are the ones about precedence: an unset key falls through to the seed, a set key
 * beats it, and a set key of ZERO beats it too. That last one is the bug this shape invites,
 * because zero is falsy and it is also the value that means "unlimited" -- a `||` anywhere in
 * `read()` would silently restore an operator's limit the moment they removed it.
 *
 * A `Map` stands in for the `kv` table, which is the whole point of `KeyValueStore` being a
 * two-method interface: no database, no config file, no clock.
 */

import { describe, expect, test } from "bun:test";
import type { Config } from "./config";
import { loadConfig } from "./config";
import {
  parseSiteSettingsPatch,
  type SiteSettings,
  SiteSettingsStore,
  siteSettingsSeed,
} from "./site-settings";
import type { KeyValueStore } from "./store";

function memoryKv(initial: Record<string, string> = {}): KeyValueStore & { rows: Map<string, string> } {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    getKv: (key) => rows.get(key) ?? null,
    setKv: (key, value) => {
      rows.set(key, value);
    },
  };
}

const SEED: SiteSettings = { requestQuotaPerDay: 7, assistantAllowedByDefault: true };

describe("the seed", () => {
  test("takes the request quota from the env-backed config", () => {
    // A hand-built config rather than the loader's, so this asserts the WIRING and not the
    // env of whichever machine runs it.
    const cfg = { requests: { quotaPerDay: 12 } } as Config;
    expect(siteSettingsSeed(cfg).requestQuotaPerDay).toBe(12);
  });

  test("the assistant default is on, matching the column default every account already has", () => {
    expect(siteSettingsSeed(loadConfig()).assistantAllowedByDefault).toBe(true);
  });
});

describe("reading", () => {
  test("with nothing stored, every value is the seed", () => {
    expect(new SiteSettingsStore(memoryKv(), SEED).read()).toEqual(SEED);
  });

  test("a stored value beats the seed", () => {
    const store = new SiteSettingsStore(memoryKv(), SEED);
    store.write({ requestQuotaPerDay: 3 });
    expect(store.read().requestQuotaPerDay).toBe(3);
  });

  /**
   * THE ONE THAT WOULD BREAK SILENTLY. Zero is "unlimited", and it is falsy -- a `||` in
   * `read()` would put the seed's limit back for an operator who had just removed it, and the
   * only symptom would be requests being refused that the admin page says are allowed.
   */
  test("a stored zero beats a non-zero seed, because zero means unlimited", () => {
    const store = new SiteSettingsStore(memoryKv(), SEED);
    store.write({ requestQuotaPerDay: 0 });
    expect(store.read().requestQuotaPerDay).toBe(0);
  });

  test("a stored `false` assistant default beats a `true` seed, for the same reason", () => {
    const store = new SiteSettingsStore(memoryKv(), SEED);
    store.write({ assistantAllowedByDefault: false });
    expect(store.read().assistantAllowedByDefault).toBe(false);
  });

  /**
   * A row that is not a number reads as ABSENT rather than as zero. Coercing it would turn a
   * corrupt value into "unlimited", which is the failure direction that removes a control
   * rather than the one that keeps it.
   */
  test("a corrupt stored number falls back to the seed instead of unlimiting everybody", () => {
    const kv = memoryKv({ site_request_quota_per_day: "not a number" });
    expect(new SiteSettingsStore(kv, SEED).read().requestQuotaPerDay).toBe(7);
  });

  test("nothing is cached -- a value written behind the store's back is read next call", () => {
    const kv = memoryKv();
    const store = new SiteSettingsStore(kv, SEED);
    expect(store.read().requestQuotaPerDay).toBe(7);
    kv.setKv("site_request_quota_per_day", "1");
    expect(store.read().requestQuotaPerDay).toBe(1);
  });
});

describe("writing", () => {
  test("an absent field is left alone rather than reset", () => {
    const store = new SiteSettingsStore(memoryKv(), SEED);
    store.write({ requestQuotaPerDay: 4, assistantAllowedByDefault: false });
    expect(store.write({ requestQuotaPerDay: 9 })).toEqual({
      requestQuotaPerDay: 9,
      assistantAllowedByDefault: false,
    });
  });

  test("it answers with the settings as they now stand, so a caller needs no second read", () => {
    const store = new SiteSettingsStore(memoryKv(), SEED);
    expect(store.write({ assistantAllowedByDefault: false })).toEqual(store.read());
  });
});

describe("parsing a patch off the wire", () => {
  test("an empty body changes nothing", () => {
    expect(parseSiteSettingsPatch({})).toEqual({ patch: {} });
  });

  test("both fields come through with their types intact", () => {
    expect(parseSiteSettingsPatch({ requestQuotaPerDay: 0, assistantAllowedByDefault: false })).toEqual({
      patch: { requestQuotaPerDay: 0, assistantAllowedByDefault: false },
    });
  });

  test("a fractional or negative quota is refused, with a reason a person can act on", () => {
    for (const bad of [2.5, -1, "3", null]) {
      const result = parseSiteSettingsPatch({ requestQuotaPerDay: bad });
      expect("error" in result && result.error).toContain("whole number");
    }
  });

  test("a non-boolean assistant default is refused rather than coerced", () => {
    const result = parseSiteSettingsPatch({ assistantAllowedByDefault: "yes" });
    expect("error" in result && result.error).toContain("true or false");
  });

  /**
   * A malformed value must never read as "not sent": the operator is looking at a form they
   * believe they just saved, and a silently dropped field is the one failure they cannot see.
   */
  test("a refusal is total -- a valid field beside a bad one is not saved either", () => {
    const store = new SiteSettingsStore(memoryKv(), SEED);
    const result = parseSiteSettingsPatch({ requestQuotaPerDay: 2.5, assistantAllowedByDefault: false });
    expect("error" in result).toBe(true);
    expect(store.read()).toEqual(SEED);
  });
});
