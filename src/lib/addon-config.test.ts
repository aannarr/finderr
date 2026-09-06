/**
 * Per-addon configuration, asserted rather than asserted-in-a-docstring.
 *
 * Two things this module promises and nothing else can check for it:
 *
 *   1. PRECEDENCE. A stored value beats the env seed, a CLEARED field beats it too (which is
 *      the trap -- an empty row is present, so falling back to the env there would put the
 *      variable back in charge of a value an operator had just taken away), and the
 *      declaration's own default is the floor.
 *   2. A SECRET NEVER COMES BACK OUT. Not through the report an admin GET is built from, and
 *      not through a log line, INCLUDING the one `FacetResolver` prints from a thrown
 *      provider error. `plugins.test.ts` drives that last one through the real loader and the
 *      real resolver; what is here is the unit half.
 *
 * A `Map` stands in for the `kv` table and a literal for the environment, which is what
 * injecting both is for: no database, no `process.env`, no order between tests.
 */

import { describe, expect, test } from "bun:test";
import {
  type AddonConfigDeclaration,
  AddonConfigStore,
  type AddonEnv,
  configFingerprint,
  MIN_REDACTABLE_SECRET,
  parseAddonConfigPatch,
  REDACTED,
  redactingLog,
  redactSecrets,
} from "./addon-config";
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

const FIELDS: AddonConfigDeclaration = [
  { key: "apiKey", type: "secret", label: "API key", env: "FAKE_API_KEY", required: true },
  { key: "region", type: "string", label: "Region", env: "FAKE_REGION", default: "US" },
  { key: "pageSize", type: "number", label: "Page size", default: 20 },
  { key: "verbose", type: "boolean", label: "Verbose", default: false },
];

function storeWith(rows: Record<string, string> = {}, env: AddonEnv = {}): AddonConfigStore {
  const config = new AddonConfigStore(memoryKv(rows), env);
  config.declare("demo", FIELDS);
  return config;
}

describe("precedence", () => {
  test("a stored value beats the env seed", () => {
    const config = storeWith({ "addon_config:demo:region": "TH" }, { FAKE_REGION: "GB" });
    expect(config.values("demo").region).toBe("TH");
    expect(config.report("demo").fields.find((f) => f.key === "region")?.source).toBe("store");
  });

  test("the env seeds a field nobody has ever saved", () => {
    const config = storeWith({}, { FAKE_REGION: "GB" });
    expect(config.values("demo").region).toBe("GB");
    expect(config.report("demo").fields.find((f) => f.key === "region")?.source).toBe("env");
  });

  test("the declaration's default is the floor", () => {
    expect(storeWith().values("demo").region).toBe("US");
    expect(
      storeWith()
        .report("demo")
        .fields.find((f) => f.key === "region")?.source,
    ).toBe("default");
  });

  test("a field with no value and no default reads unset", () => {
    const report = storeWith().report("demo");
    expect(report.fields.find((f) => f.key === "apiKey")).toMatchObject({ set: false, source: "unset" });
  });

  /*
    The one that would be got wrong by deleting the row instead of emptying it: a cleared
    field is PRESENT in the store, so the env variable must stay out of it. Otherwise an
    operator clearing a key would find it back at the next restart with nothing on any screen
    to explain why.
  */
  test("clearing a field keeps the env seed out and falls to the default", () => {
    const config = storeWith({}, { FAKE_REGION: "GB" });
    config.write("demo", "region", null);
    expect(config.values("demo").region).toBe("US");
    expect(config.report("demo").fields.find((f) => f.key === "region")?.source).toBe("default");
  });

  test("clearing a field that has no default leaves it unset", () => {
    const config = storeWith({}, { FAKE_API_KEY: "0123456789abcdef" });
    config.write("demo", "apiKey", null);
    expect(config.values("demo").apiKey).toBeUndefined();
  });

  test("a stored row that will not parse falls through to the seed, never to a coerced value", () => {
    const config = storeWith({ "addon_config:demo:pageSize": "not a number" }, {});
    expect(config.values("demo").pageSize).toBe(20);
  });

  test("false and zero beat the default, which `||` would not", () => {
    const config = storeWith();
    config.write("demo", "verbose", true);
    config.write("demo", "pageSize", 0);
    expect(config.values("demo")).toMatchObject({ verbose: true, pageSize: 0 });
  });

  test("an addon that declares nothing resolves to nothing rather than throwing", () => {
    expect(new AddonConfigStore(memoryKv(), {}).values("unknown")).toEqual({});
  });
});

describe("the reader an addon is handed", () => {
  test("answers each declared field in its own kind", () => {
    const config = storeWith({ "addon_config:demo:apiKey": "0123456789abcdef" });
    const reader = config.reader("demo");
    expect(reader.string("apiKey")).toBe("0123456789abcdef");
    expect(reader.string("region")).toBe("US");
    expect(reader.number("pageSize")).toBe(20);
    expect(reader.boolean("verbose")).toBe(false);
  });

  test("reads undefined for a key of the wrong kind or no key at all", () => {
    const reader = storeWith().reader("demo");
    expect(reader.number("region")).toBeUndefined();
    expect(reader.string("nothingLikeThis")).toBeUndefined();
  });
});

describe("a secret is write-only", () => {
  const config = storeWith({ "addon_config:demo:apiKey": "s3cret-key-value" });

  test("the report says it is set and where it came from, and carries no value", () => {
    const field = config.report("demo").fields.find((f) => f.key === "apiKey");
    expect(field).toMatchObject({ set: true, source: "store" });
    expect(field).not.toHaveProperty("value");
    // Nothing anywhere in the serialised report, which is what an admin GET actually sends.
    expect(JSON.stringify(config.report("demo"))).not.toContain("s3cret-key-value");
  });

  test("a non-secret field does carry its value", () => {
    expect(config.report("demo").fields.find((f) => f.key === "region")).toMatchObject({ value: "US" });
  });

  test("`configured` tracks whether every required field has a value", () => {
    expect(config.report("demo").configured).toBe(true);
    expect(storeWith().report("demo").configured).toBe(false);
  });
});

describe("redaction", () => {
  test("replaces a configured secret wherever it appears", () => {
    const config = storeWith({ "addon_config:demo:apiKey": "s3cret-key-value" });
    const text = "GET https://api.example/x?api_key=s3cret-key-value answered 401";
    expect(redactSecrets(text, config.secrets())).toBe(
      `GET https://api.example/x?api_key=${REDACTED} answered 401`,
    );
  });

  test("replaces the longer of two overlapping secrets first", () => {
    // Sorted longest-first by `secrets()`; replacing the short one first would leave the
    // tail of the long one -- "[redacted]-value" -- in the log.
    const config = storeWith({ "addon_config:demo:apiKey": "s3cret-key-value" });
    config.declare("other", [{ key: "k", type: "secret", label: "K" }]);
    config.write("other", "k", "s3cret-key");
    expect(redactSecrets("s3cret-key-value", config.secrets())).toBe(REDACTED);
  });

  test("a log wrapper reads the secrets at call time, so a key saved later is still covered", () => {
    const config = storeWith();
    const lines: string[] = [];
    const log = redactingLog(
      (m) => lines.push(m),
      () => config.secrets(),
    );

    log("nothing to hide");
    config.write("demo", "apiKey", "s3cret-key-value");
    log("boom: s3cret-key-value");

    expect(lines).toEqual(["nothing to hide", `boom: ${REDACTED}`]);
  });

  test("an env-seeded secret is redacted too", () => {
    const config = storeWith({}, { FAKE_API_KEY: "env-seeded-key" });
    expect(redactSecrets("key=env-seeded-key", config.secrets())).toBe(`key=${REDACTED}`);
  });
});

describe("a patch off the wire", () => {
  test("takes a value per declared kind and leaves absent fields alone", () => {
    const parsed = parseAddonConfigPatch(FIELDS, { region: "TH", pageSize: 5, verbose: true });
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect([...parsed.patch]).toEqual([
      ["region", "TH"],
      ["pageSize", 5],
      ["verbose", true],
    ]);
  });

  test("null clears, which is the only way to un-set a secret nothing can read back", () => {
    const parsed = parseAddonConfigPatch(FIELDS, { apiKey: null });
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.patch.get("apiKey")).toBeNull();
  });

  test("refuses a key the addon does not declare", () => {
    expect(parseAddonConfigPatch(FIELDS, { nope: "x" })).toEqual({
      error: "nope is not a setting this addon declares",
    });
  });

  test("refuses a value of the wrong kind", () => {
    expect(parseAddonConfigPatch(FIELDS, { pageSize: "twenty" })).toEqual({
      error: "pageSize must be a number",
    });
  });

  /*
    Storing a secret shorter than the redaction floor would be a hole in the one promise this
    module makes about secrets: it would reach a log line and nothing could take it out again.
  */
  test("refuses a secret too short to redact", () => {
    const parsed = parseAddonConfigPatch(FIELDS, { apiKey: "ab" });
    expect(parsed).toEqual({ error: `apiKey must be at least ${MIN_REDACTABLE_SECRET} characters` });
  });
});

describe("the fingerprint a configVersion is built from", () => {
  test("is stable across key order and changes with a value", () => {
    expect(configFingerprint({ b: 2, a: "x" })).toBe(configFingerprint({ a: "x", b: 2 }));
    expect(configFingerprint({ a: "x" })).not.toBe(configFingerprint({ a: "y" }));
  });

  test("ignores unconfigured fields, so declaring one changes nothing until it is set", () => {
    expect(configFingerprint({ a: "x", b: undefined })).toBe(configFingerprint({ a: "x" }));
  });
});
