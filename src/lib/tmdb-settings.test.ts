/**
 * One TMDB key, two readers, and the drift that used to sit between them.
 *
 * The regression this file exists for: `FINDERR_TMDB_API_KEY` had two readers that each
 * picked a winner. The `tmdb` addon resolved it through `AddonConfigStore`, so a value saved
 * on the admin page won there; the upcoming-and-trending sync and the poster proxy read
 * `cfg.tmdb`, so they stayed on whatever the container was started with. An operator
 * rotating the key rotated half the product and nothing said so.
 *
 * So the assertions below are about AGREEMENT rather than about precedence alone -- the
 * precedence rule itself is `addon-config.test.ts`'s to prove. What is checked here is that
 * core's reader and the addon's `c.config` cannot disagree, and that they cannot disagree
 * BECAUSE they resolve one declaration from one row rather than because two copies happen to
 * be spelled the same today.
 */

import { describe, expect, test } from "bun:test";
import { meta } from "../plugins/tmdb";
import { AddonConfigStore, type AddonEnv } from "./addon-config";
import type { KeyValueStore } from "./store";
import {
  TMDB_ADDON_ID,
  TMDB_API_KEY_FIELD,
  TMDB_DEFAULT_IMAGE_BASE,
  TMDB_IMAGE_BASE_FIELD,
  TMDB_SHARED_CONFIG,
  TmdbSettingsStore,
} from "./tmdb-settings";

/** A `Map` for the `kv` table and a literal for the environment, as `addon-config.test.ts` does. */
function memoryKv(initial: Record<string, string> = {}): KeyValueStore {
  const rows = new Map(Object.entries(initial));
  return {
    getKv: (key) => rows.get(key) ?? null,
    setKv: (key, value) => {
      rows.set(key, value);
    },
  };
}

/** The store as the server builds it: core's settings, plus the addon having loaded. */
function bothReaders(rows: Record<string, string> = {}, env: AddonEnv = {}) {
  const config = new AddonConfigStore(memoryKv(rows), env);
  config.declare(TMDB_ADDON_ID, meta.config);
  return { config, core: new TmdbSettingsStore(config), addon: config.reader(TMDB_ADDON_ID) };
}

const KEY_ROW = `addon_config:${TMDB_ADDON_ID}:apiKey`;
const IMAGE_BASE_ROW = `addon_config:${TMDB_ADDON_ID}:imageBase`;

describe("core and the addon read one value", () => {
  test("a key saved through the admin store moves BOTH readers", () => {
    const { config, core, addon } = bothReaders({}, { FINDERR_TMDB_API_KEY: "from-the-environment" });
    expect(core.read().apiKey).toBe("from-the-environment");

    config.write(TMDB_ADDON_ID, "apiKey", "rotated-on-the-admin-page");

    expect(core.read().apiKey).toBe("rotated-on-the-admin-page");
    expect(addon.string("apiKey")).toBe("rotated-on-the-admin-page");
  });

  test("an image base saved through the admin store moves BOTH readers", () => {
    const { config, core, addon } = bothReaders();
    expect(core.read().imageBase).toBe(TMDB_DEFAULT_IMAGE_BASE);

    config.write(TMDB_ADDON_ID, "imageBase", "https://mirror.example/t/p");

    expect(core.read().imageBase).toBe("https://mirror.example/t/p");
    expect(addon.string("imageBase")).toBe("https://mirror.example/t/p");
  });

  test("they read the same rows, so neither can be moved without the other", () => {
    const { core, addon } = bothReaders(
      { [KEY_ROW]: "stored-key", [IMAGE_BASE_ROW]: "https://mirror.example/t/p" },
      // The env is deliberately DIFFERENT: a stored row wins for both readers, and a reader
      // that had kept its own env-first rule would show these values instead.
      { FINDERR_TMDB_API_KEY: "stale-env-key", FINDERR_TMDB_IMAGE_BASE: "https://stale.example" },
    );
    expect(core.read()).toEqual({ apiKey: "stored-key", imageBase: "https://mirror.example/t/p" });
    expect(addon.string("apiKey")).toBe("stored-key");
    expect(addon.string("imageBase")).toBe("https://mirror.example/t/p");
  });

  test("the addon declares core's own field objects rather than a copy of them", () => {
    // Identity, not equality: a second declaration spelled the same way is exactly the drift
    // this module removed, and it would pass a `toEqual`.
    expect(meta.config).toContain(TMDB_API_KEY_FIELD);
    expect(meta.config).toContain(TMDB_IMAGE_BASE_FIELD);
  });
});

describe("core reads without the addon", () => {
  /*
    Deleting a plugin file removes that addon's facts and must not stop the trending sync or
    the poster proxy. `sharedValue` takes core's declaration as an argument for exactly this:
    nothing has been declared to the store in these two tests.
  */
  test("an env-seeded key resolves with no declaration registered", () => {
    const config = new AddonConfigStore(memoryKv(), { FINDERR_TMDB_API_KEY: "from-the-environment" });
    expect(new TmdbSettingsStore(config).read().apiKey).toBe("from-the-environment");
  });

  test("a stored key outlives the addon that was the reason it was saved", () => {
    const config = new AddonConfigStore(memoryKv({ [KEY_ROW]: "stored-key" }), {});
    expect(new TmdbSettingsStore(config).read()).toEqual({
      apiKey: "stored-key",
      imageBase: TMDB_DEFAULT_IMAGE_BASE,
    });
  });
});

describe("the settings themselves", () => {
  test("no key configured anywhere means the syncs stay quiet", () => {
    expect(bothReaders().core.read().apiKey).toBeUndefined();
  });

  test("a cleared image base falls back to the default, never to the env var", () => {
    // An empty row is PRESENT, so the seed stays out -- the trap `addon-config.ts` states.
    const { core } = bothReaders(
      { [IMAGE_BASE_ROW]: "" },
      { FINDERR_TMDB_IMAGE_BASE: "https://stale.example" },
    );
    expect(core.read().imageBase).toBe(TMDB_DEFAULT_IMAGE_BASE);
  });

  test("the key is a secret, so the admin report never carries its value", () => {
    const { config } = bothReaders({ [KEY_ROW]: "stored-key" });
    const field = config.report(TMDB_ADDON_ID).fields.find((f) => f.key === "apiKey");
    expect(field).toMatchObject({ type: "secret", set: true, source: "store" });
    expect(field).not.toHaveProperty("value");
    // And it is redactable, which is what keeps it out of a log line an addon writes.
    expect(config.secrets()).toContain("stored-key");
  });

  test("both shared fields keep the environment variables a deployment already sets", () => {
    expect(TMDB_SHARED_CONFIG.map((f) => f.env)).toEqual(["FINDERR_TMDB_API_KEY", "FINDERR_TMDB_IMAGE_BASE"]);
  });
});
