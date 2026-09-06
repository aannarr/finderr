/**
 * The admin API for addon configuration, driven as a caller drives it.
 *
 * Two things are worth an HTTP-level test rather than a unit one. A `secret` must not come
 * back out of the GET -- the report owns that rule, but this is the surface that would
 * actually leak it -- and every route must be behind `asAdmin`, which is easy to leave off
 * one method of two and impossible to notice afterwards.
 *
 * `asAdmin` is injected, so this file never stands up an AuthService, a database or a
 * session: what is under test is whether the routes ASK, not who says yes.
 */

import { describe, expect, test } from "bun:test";
import { AddonConfigStore } from "../lib/addon-config";
import type { LoadedPlugin } from "../lib/plugins";
import { PluginRegistry } from "../lib/plugins";
import type { KeyValueStore } from "../lib/store";
import { ADDON_CONFIG_PATH, addonConfigRoutes } from "./addon-config-routes";

function memoryKv(): KeyValueStore {
  const rows = new Map<string, string>();
  return {
    getKv: (key) => rows.get(key) ?? null,
    setKv: (key, value) => {
      rows.set(key, value);
    },
  };
}

const DEMO: LoadedPlugin = {
  meta: { id: "demo", entities: ["movie"] },
  file: "demo.ts",
  configVersion: "abc123",
  config: [
    { key: "apiKey", type: "secret", label: "API key", required: true },
    { key: "region", type: "string", label: "Region", default: "US" },
  ],
};

function harness(opts: { admin?: boolean } = {}) {
  const registry = new PluginRegistry();
  registry.add(DEMO, []);
  const config = new AddonConfigStore(memoryKv(), {});
  config.declare("demo", DEMO.config);
  const logs: string[] = [];

  const routes = addonConfigRoutes({
    registry,
    config,
    log: (m) => logs.push(m),
    asAdmin: async (_req, fn) => (opts.admin === false ? new Response("no", { status: 403 }) : await fn()),
  });
  return { routes, config, logs };
}

/** `params` is Bun's, added by its router; a hand-built Request needs it spliced on. */
function patch(body: unknown, id = "demo"): Request {
  const req = new Request(`http://x${ADDON_CONFIG_PATH}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  Object.assign(req, { params: { id } });
  return req;
}

describe("GET /api/admin/addons", () => {
  test("lists every loaded addon and what it declares", async () => {
    const { routes } = harness();
    const res = await routes[ADDON_CONFIG_PATH].GET(new Request(`http://x${ADDON_CONFIG_PATH}`));
    const body = (await res.json()) as { addons: { pluginId: string; configured: boolean }[] };

    expect(body.addons).toHaveLength(1);
    expect(body.addons[0]).toMatchObject({ pluginId: "demo", configured: false });
  });

  test("never reads a secret back, whatever is stored", async () => {
    const { routes, config } = harness();
    config.write("demo", "apiKey", "s3cret-key-value");

    const res = await routes[ADDON_CONFIG_PATH].GET(new Request(`http://x${ADDON_CONFIG_PATH}`));
    const text = await res.text();

    expect(text).not.toContain("s3cret-key-value");
    // It still says the addon is configured, which is the whole point of reporting `set`.
    expect(JSON.parse(text).addons[0].configured).toBe(true);
  });

  test("is behind asAdmin", async () => {
    const { routes } = harness({ admin: false });
    const res = await routes[ADDON_CONFIG_PATH].GET(new Request(`http://x${ADDON_CONFIG_PATH}`));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/admin/addons/:id", () => {
  const route = `${ADDON_CONFIG_PATH}/:id`;

  test("saves the named fields and leaves the rest alone", async () => {
    const { routes, config } = harness();
    config.write("demo", "apiKey", "s3cret-key-value");

    const res = await routes[route].PATCH(patch({ region: "TH" }));
    expect(res.status).toBe(200);
    expect(config.values("demo")).toEqual({ apiKey: "s3cret-key-value", region: "TH" });
  });

  test("null clears a field, which is the only way to un-set a secret", async () => {
    const { routes, config } = harness();
    config.write("demo", "apiKey", "s3cret-key-value");

    await routes[route].PATCH(patch({ apiKey: null }));
    expect(config.values("demo").apiKey).toBeUndefined();
  });

  test("answers 400 with the reason for a value the declaration refuses", async () => {
    const { routes } = harness();
    const res = await routes[route].PATCH(patch({ apiKey: "ab" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "apiKey must be at least 4 characters" });
  });

  test("answers 404 for an addon that is not loaded", async () => {
    const { routes } = harness();
    const res = await routes[route].PATCH(patch({ region: "TH" }, "nope"));
    expect(res.status).toBe(404);
  });

  test("logs the keys that changed and never their values", async () => {
    const { routes, logs } = harness();
    await routes[route].PATCH(patch({ apiKey: "s3cret-key-value" }));

    expect(logs.join("\n")).toContain("addon demo configured -- apiKey");
    expect(logs.join("\n")).not.toContain("s3cret-key-value");
  });

  test("is behind asAdmin", async () => {
    const { routes, config } = harness({ admin: false });
    const res = await routes[route].PATCH(patch({ region: "TH" }));
    expect(res.status).toBe(403);
    expect(config.values("demo").region).toBe("US");
  });
});
