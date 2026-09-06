/**
 * Plugin loader and provider registry.
 *
 * A plugin exports `meta` and `init`. `init` receives its context once and RETURNS its
 * extension points as an object -- `{ facets: { ratings, cast } }` -- so the keys are the
 * declaration and a handler closes over the context instead of being handed it again.
 * Core asks every provider for a facet in parallel and merges the answers.
 *
 * TWO WAYS IN, one loader. A file in the plugins directory is the local case -- drop it
 * in and it contributes, delete it and its facts go, no core edit and no build either
 * way. A MODULE SPECIFIER in `modules` is the installed case: `bun add` a package and
 * name it in config. Both are resolved to an absolute path, imported, and validated down
 * the same path, so a published addon has no capability a local file lacks and no rule
 * relaxed for it.
 *
 * The two rules that make that safe:
 *   - A bad plugin is skipped, never fatal. Malformed meta, a throwing `init`, a facet
 *     it did not declare, a specifier that resolves to nothing: logged, and the host
 *     carries on with the plugins that work.
 *   - A plugin only reaches hosts it declared, through the wrapper in `./plugin-fetch`.
 *
 * Loading arbitrary JS is arbitrary code execution by definition, and `meta.hosts` gates
 * `c.fetch` rather than the module. That is fine for local files you wrote yourself. A published
 * package is SOMEONE ELSE'S code with the same privileges as the server -- read `ADDONS.md`
 * before naming one -- and it would emphatically not be fine for anything user-uploaded
 * once finderr is internet-facing.
 */

import type { EntityKind, FacetContribution, FacetEntity, FacetName } from "./facets";
import { FACETS, isFacetName } from "./facets";
import { isPaneSlot, type PaneDeclaration, type RegisteredPane } from "./panes";
import type { OutboundPolicy, PluginFetch } from "./plugin-fetch";
import { createPluginFetch, DEFAULT_OUTBOUND_POLICY, HostPacer } from "./plugin-fetch";
import type { KeyValueStore } from "./store";

/** A plugin's own scratch space, namespaced so two plugins can never collide. */
export interface PluginKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * What a plugin is handed once, at load, and closes over for the rest of its life.
 *
 * ONE context rather than a wider one for `init` and a narrower one for providers. The
 * split existed to keep `provide` out of a provider's reach; nothing registers imperatively
 * any more, so there is no capability to withhold and no second interface to explain.
 */
export interface PluginContext {
  readonly pluginId: string;
  /** Refuses any host the plugin did not declare. See `./plugin-fetch`. */
  fetch: PluginFetch;
  /**
   * Permanent per-plugin storage for the expensive half of a lookup -- a resolved
   * `rtId`, a `tconst -> tvdbId` crosswalk. Facet data belongs in the facet cache; this
   * is for the identifiers that never change and must survive a facet expiring.
   */
  readonly kv: PluginKv;
  log(message: string): void;
}

/**
 * One facet's provider. Takes the entity, and a signal it may ignore -- the context is
 * closed over from `init`, which is what a factory returning its handlers buys.
 *
 * `signal` ABORTS WHEN THE HOST HAS STOPPED CARING: the per-provider deadline expired, or
 * the work was cancelled upstream. It is **optional to honour and free to ignore**, so
 * every provider written before it existed still type-checks and still works -- the host
 * stops waiting either way. Honouring it is strictly better: passing it to `c.fetch` as
 * `{ signal }` closes the socket instead of leaving a dead request to finish into nothing.
 * A provider doing expensive local work between fetches should check `signal.aborted`
 * between steps for the same reason.
 */
export type FacetProvider<F extends FacetName = FacetName> = (
  entity: FacetEntity,
  signal?: AbortSignal,
) => Promise<FacetContribution<F> | null>;

/**
 * What `init` returns: the plugin's extension points, grouped by vocabulary.
 *
 * The KEYS ARE THE DECLARATION. There is no separate list of what a plugin provides to
 * disagree with what it actually provides, which is why three guards this loader used to
 * need no longer exist: a facet not declared in `meta`, a second provider for one facet
 * (an object literal cannot express it), and the staged-then-committed registration dance
 * that existed only because a half-run `init` could leave junk behind.
 *
 * GROUPED so the next vocabulary lands beside this one rather than inside it. Lifecycle
 * events would be `on: { itemDidBecomeAvailable }` -- facet names and event names are two
 * namespaces, and Astro's `astro:config:setup` prefixes are what merging them costs.
 *
 * An unknown group is logged and ignored, never fatal: a plugin written against a newer
 * finderr must degrade rather than take the host down.
 */
export interface PluginExports {
  facets?: { [F in FacetName]?: FacetProvider<F> };
  /**
   * Panes this plugin draws on the title page. See `./panes`.
   *
   * The SECOND group, and the first proof that grouping was the right shape: it landed
   * beside `facets` without touching a line of the facet path. A plugin with a FACT
   * contributes a facet; one with something to SAY that core's vocabulary has no name for
   * contributes a pane.
   */
  panes?: PaneDeclaration[];
}

/** The groups this host understands. Anything else in `PluginExports` is ignored. */
const EXPORT_GROUPS = ["facets", "panes"] as const;

export interface PluginMeta {
  /** Namespace for this plugin's contributions and its storage. Kebab-case. */
  id: string;
  entities: readonly EntityKind[];
  /** Hosts this plugin may fetch. Anything else is refused by core. */
  hosts?: readonly string[];
}

export interface PluginModule {
  meta: PluginMeta;
  init(ctx: PluginContext): PluginExports | Promise<PluginExports>;
}

export interface LoadedPlugin {
  meta: PluginMeta;
  /** Absolute path it was loaded from, for the log line and for `/api/health`. */
  file: string;
  /**
   * A hash of the plugin's own source, and part of every contribution's cache key.
   *
   * Editing what a plugin contributes therefore invalidates what it already contributed.
   * This was pinned to `"0"` for every plugin, which meant the mechanism the primary key
   * was designed around never fired once: a corrected mapping stayed invisible until the
   * facet's own TTL, up to 90 days for anything the freshness ladder calls settled.
   *
   * See `configVersionFor`, including why it hashes the plugin's directory too.
   */
  configVersion: string;
}

/**
 * The version a plugin gets when its source cannot be hashed.
 *
 * Only reachable if the file vanishes between being listed and being read. Kept distinct
 * from any real hash so such a plugin does not silently adopt another's cached rows.
 */
export const DEFAULT_CONFIG_VERSION = "0";

export interface RegisteredProvider {
  pluginId: string;
  facet: FacetName;
  /** Already bound to its plugin's context by the closure `init` returned it from. */
  run: FacetProvider;
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Plugin files live beside this module unless the config points somewhere else. */
export const BUILTIN_PLUGINS_DIR = new URL("../plugins/", import.meta.url).pathname;

/**
 * Everything that loaded successfully, and who provides what.
 *
 * The registry is the authority on which plugin ids exist: the facet cache is filtered
 * through it on read, which is how deleting a plugin file removes its contributions
 * without deleting any rows.
 */
export class PluginRegistry {
  private readonly byFacet = new Map<FacetName, RegisteredProvider[]>();
  private readonly plugins = new Map<string, LoadedPlugin>();
  /** Flat and in load order: slot placement is decided at render, not here. */
  private readonly declaredPanes: RegisteredPane[] = [];

  /**
   * Register a plugin and its providers, unless something already owns the id.
   *
   * Returns the INCUMBENT when it refuses, so the caller can name it in the log line.
   * First registration wins, and the loader walks the directory before the configured
   * modules -- so a local file always beats an installed package claiming its id, which
   * is the way round that lets a local copy override a published addon.
   *
   * This used to accept the collision: the id was overwritten in `plugins` while BOTH
   * sets of providers went into `byFacet`, so both ran and wrote a cache row under their
   * own `configVersion`, and `liveRows` then kept whichever version the surviving
   * registration carried. The id is what namespaces a plugin's data; two owners of one
   * namespace is not a state this can represent.
   */
  add(
    plugin: LoadedPlugin,
    providers: RegisteredProvider[],
    panes: RegisteredPane[] = [],
  ): LoadedPlugin | null {
    const incumbent = this.plugins.get(plugin.meta.id);
    if (incumbent) return incumbent;

    this.plugins.set(plugin.meta.id, plugin);
    for (const p of providers) {
      const list = this.byFacet.get(p.facet);
      if (list) list.push(p);
      else this.byFacet.set(p.facet, [p]);
    }
    // Refused together with the providers: an id collision must not leave HALF a plugin
    // registered, which is the bug `add()` returning the incumbent exists to prevent.
    this.declaredPanes.push(...panes);
    return null;
  }

  /** Every pane every loaded plugin declared, in load order (`found.sort()`, so stable). */
  panes(): readonly RegisteredPane[] {
    return this.declaredPanes;
  }

  /** Providers that can answer for this facet on this kind of entity. */
  providersFor(facet: FacetName, kind: EntityKind): RegisteredProvider[] {
    if (!FACETS[facet].entities.includes(kind)) return [];
    return (this.byFacet.get(facet) ?? []).filter((p) =>
      this.plugins.get(p.pluginId)?.meta.entities.includes(kind),
    );
  }

  /** Facets any loaded plugin can answer for this kind of entity. */
  facetsFor(kind: EntityKind): FacetName[] {
    return [...this.byFacet.keys()].filter((f) => this.providersFor(f, kind).length > 0);
  }

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  configVersionOf(pluginId: string): string {
    return this.plugins.get(pluginId)?.configVersion ?? DEFAULT_CONFIG_VERSION;
  }

  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * Every loaded plugin's id -> the `configVersion` it is RUNNING.
   *
   * The bulk form of what `isLiveContribution` asks one row at a time, and the input to
   * `Store.pruneFacetContributions`. It reports only what is registered, which is what makes
   * the prune safe: a plugin that failed to load contributes no entry, so the sweep leaves
   * its rows alone rather than mistaking a broken import for a deletion.
   */
  currentVersions(): Map<string, string> {
    return new Map([...this.plugins].map(([id, p]) => [id, p.configVersion]));
  }
}

export interface LoadPluginsOptions {
  dir?: string;
  /**
   * Installed addons, as module specifiers -- `finderr-addon-foo`, `@scope/bar`, or a
   * path. Loaded AFTER the directory, so a local file wins a clash of ids.
   */
  modules?: readonly string[];
  /**
   * Where a bare specifier is resolved from. The app root by default, which is `/app`
   * in the container: an addon is a dependency of the deployment, so it resolves out of
   * the same `node_modules` `bun install` wrote, not out of wherever this file happens
   * to sit. Injected so a test can hand over a directory it built.
   */
  resolveFrom?: string;
  kv: KeyValueStore;
  log?: (message: string) => void;
  policy?: Partial<OutboundPolicy>;
  /** Injected so tests never touch the network. */
  fetchImpl?: PluginFetch;
}

/**
 * Where a plugin came from.
 *
 * Both forms end up as an absolute path to import, and the only thing the rest of the
 * loader does differently is how it VERSIONS them: a directory file hashes its own
 * source, an installed package has a name and a version that already say what it is.
 */
interface PluginOrigin {
  /** Absolute path to import. A specifier is resolved before it gets here. */
  path: string;
  /** How to name it in a log line: the path for a file, the specifier as written. */
  label: string;
  module: boolean;
}

/**
 * Load every plugin in the directory, then every configured module.
 *
 * Neither a missing directory nor an unresolvable specifier is an error -- finderr with
 * no plugins is a working finderr that simply knows fewer facts, and an addon that was
 * not installed must not take the server down on boot.
 *
 * NOTE: modules are cached by path for the life of the process, so EDITING a plugin
 * needs a restart. Adding and deleting do not, which is what the acceptance turns on.
 */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginRegistry> {
  const dir = opts.dir ?? BUILTIN_PLUGINS_DIR;
  const log = opts.log ?? (() => {});
  const registry = new PluginRegistry();
  const pacer = new HostPacer(
    opts.policy?.minIntervalMsPerHost ?? DEFAULT_OUTBOUND_POLICY.minIntervalMsPerHost,
  );

  const origins = [
    ...(await fileOrigins(dir)),
    ...moduleOrigins(opts.modules ?? [], opts.resolveFrom ?? process.cwd(), log),
  ];

  for (const origin of origins) {
    try {
      const mod = (await import(origin.path)) as Partial<PluginModule>;
      const loaded = await loadOne(mod, origin, { ...opts, log, pacer });
      if (!loaded) continue;

      const incumbent = registry.add(loaded.plugin, loaded.providers, loaded.panes);
      if (incumbent) {
        log(
          `plugin ${origin.label} ignored: id '${loaded.plugin.meta.id}' is already registered by ${incumbent.file}`,
        );
        continue;
      }
      log(`plugin ${loaded.plugin.meta.id}: provides ${loaded.providers.map((p) => p.facet).join(", ")}`);
    } catch (err) {
      // A plugin that will not even import must not stop the ones that would.
      log(`plugin ${origin.label} failed to load: ${(err as Error).message}`);
    }
  }
  return registry;
}

/**
 * A plugin's `configVersion`: a hash of the SOURCE that decides what it contributes.
 *
 * `facet_contribution`'s primary key has carried `config_version` from the start, and the
 * resolver already skips rows whose version does not match -- but nothing ever bumped it,
 * so every plugin was stamped `"0"` forever and the whole invalidation mechanism was dead
 * code. The symptom: correct a provider's mapping, rebuild, and the OLD value keeps being
 * served until the facet's own TTL expires. For a facet the freshness ladder calls
 * `immutable` or `settled` that is up to 90 days, so in practice never.
 *
 * Content-addressed rather than a number a human remembers to increment, because the
 * failure mode of a manual version is silence: you fix a mapping, forget the bump, and
 * the fix simply does not appear.
 *
 * **The whole plugin, not just its entry file.** `servarr-metadata` is one file plus
 * `servarr/` beside it, and the mapping functions that actually decide the facet values
 * live in the DIRECTORY -- so hashing only the entry file would miss exactly the edits
 * most likely to change what is contributed.
 *
 * Cost of a false positive: a whitespace change re-fetches that plugin's facets on next
 * view. Paced, one click deep, and self-limiting. Cost of a false negative is a wrong
 * value served for three months. Not a close call.
 */
async function configVersionFor(origin: PluginOrigin): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  try {
    for (const part of await sourceParts(origin)) {
      // The RELATIVE name, never the absolute path: the same plugin lives at
      // /app/src/plugins in the container and under the developer's home directory
      // locally, and both can meet the same persisted database. Hashing the absolute
      // path would invalidate every contribution merely by changing where it runs.
      hash.update(part.name);
      hash.update(await Bun.file(part.path).text());
    }
  } catch {
    // The file vanished between listing and reading. Better a stamp that matches nothing
    // than one that accidentally matches another plugin's cached rows.
    return DEFAULT_CONFIG_VERSION;
  }
  // Short: this lands in a primary key on every contribution row, and 12 hex chars is
  // 48 bits -- collision here would mean silently keeping a stale row, and at the number
  // of plugin versions this product will ever see that is not a risk worth more bytes.
  return hash.digest("hex").slice(0, 12);
}

/**
 * What the config version is computed over, as `(name, file)` pairs.
 *
 * A DIRECTORY plugin is its entry file plus everything in the sibling directory named
 * after it -- every source whose content decides what it contributes.
 *
 * An INSTALLED module is its package identity (`name@version`) plus its entry file. The
 * identity is the honest key: republishing bumps the version, which is the same promise
 * a lockfile already relies on. Hashing the entry too catches a dist rebuilt in place.
 *
 * > The gap, stated rather than hidden: an UNBUNDLED package whose entry only re-exports
 * > other files, edited in place under a version that does not move, hashes the same. In
 * > practice that is a `bun link`ed addon under development -- bump the version, or point
 * > at it as a directory plugin while you work on it.
 *
 * Sorted, so the hash is stable across filesystems that enumerate in different orders --
 * an unstable hash would invalidate every contribution on every boot.
 */
async function sourceParts(origin: PluginOrigin): Promise<{ name: string; path: string }[]> {
  const file = origin.path;
  if (origin.module) {
    return [{ name: (await packageIdentity(file)) ?? origin.label, path: file }];
  }

  const partsDir = file.replace(/\.(ts|js|mjs)$/, "");
  const parts = [{ name: file.slice(file.lastIndexOf("/") + 1), path: file }];
  try {
    const glob = new Bun.Glob("**/*.{ts,js,mjs,json}");
    const found: string[] = [];
    for await (const name of glob.scan({ cwd: partsDir })) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.js") || name.endsWith(".d.ts")) continue;
      found.push(name);
    }
    for (const name of found.sort()) parts.push({ name, path: `${partsDir}/${name}` });
  } catch {
    // Single-file plugin: no sibling directory, nothing more to hash.
  }
  return parts;
}

/**
 * `name@version` of the package an entry file belongs to, from the NEAREST package.json.
 *
 * Nearest rather than outermost: `node_modules/foo/dist/index.js` belongs to `foo`, and
 * walking further up would find finderr's own manifest and stamp every addon with it.
 * Null when there is no readable manifest, and the caller falls back to the specifier.
 */
async function packageIdentity(entry: string): Promise<string | null> {
  let dir = entry.slice(0, entry.lastIndexOf("/"));
  while (dir.includes("/")) {
    const manifest = `${dir}/package.json`;
    if (await Bun.file(manifest).exists()) {
      try {
        const pkg = JSON.parse(await Bun.file(manifest).text()) as { name?: string; version?: string };
        return typeof pkg.name === "string" ? `${pkg.name}@${pkg.version ?? "0.0.0"}` : null;
      } catch {
        return null; // unreadable manifest -- the entry file's own content still hashes
      }
    }
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return null;
}

/**
 * Resolve each configured specifier to a file, dropping the ones that are not installed.
 *
 * `Bun.resolveSync` is the same resolver the runtime's own `import` uses, so a bare
 * specifier finds the package `bun install` wrote and `./relative` and absolute paths
 * work without a second code path. A specifier that resolves to nothing is a
 * configuration mistake, and the loud log line at boot is the whole remedy: the server
 * still starts, and every other addon still loads.
 */
function moduleOrigins(
  specifiers: readonly string[],
  from: string,
  log: (message: string) => void,
): PluginOrigin[] {
  const origins: PluginOrigin[] = [];
  for (const specifier of specifiers) {
    try {
      origins.push({ path: Bun.resolveSync(specifier, from), label: specifier, module: true });
    } catch (err) {
      log(`plugin module ${specifier} could not be resolved from ${from}: ${(err as Error).message}`);
    }
  }
  return origins;
}

/** Plugin files in load order. Tests and type declarations are not plugins. */
async function fileOrigins(dir: string): Promise<PluginOrigin[]> {
  const glob = new Bun.Glob("*.{ts,js,mjs}");
  const found: string[] = [];
  try {
    for await (const name of glob.scan({ cwd: dir })) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.js") || name.endsWith(".d.ts")) continue;
      found.push(`${dir.replace(/\/$/, "")}/${name}`);
    }
  } catch {
    return []; // no plugins directory -- see the note on loadPlugins
  }
  return found.sort().map((path) => ({ path, label: path, module: false }));
}

/**
 * Validate one module, run its `init`, and take the providers it returned.
 *
 * Nothing needs staging any more. `init` either returns its exports or throws, and a
 * throw means the caller never sees a partial set -- which is what the staged-then-
 * committed dance was for back when a plugin registered by side effect.
 */
async function loadOne(
  mod: Partial<PluginModule>,
  origin: PluginOrigin,
  deps: {
    kv: KeyValueStore;
    log: (m: string) => void;
    policy?: Partial<OutboundPolicy>;
    fetchImpl?: PluginFetch;
    pacer: HostPacer;
  },
): Promise<{
  plugin: LoadedPlugin;
  providers: RegisteredProvider[];
  panes: RegisteredPane[];
} | null> {
  const problem = metaProblem(mod.meta);
  if (problem) {
    deps.log(`plugin ${origin.label} ignored: ${problem}`);
    return null;
  }
  const meta = mod.meta as PluginMeta;

  if (typeof mod.init !== "function") {
    deps.log(`plugin ${meta.id} ignored: no init() export`);
    return null;
  }

  const ctx: PluginContext = {
    pluginId: meta.id,
    fetch: createPluginFetch({
      pluginId: meta.id,
      hosts: meta.hosts ?? [],
      pacer: deps.pacer,
      policy: deps.policy,
      fetchImpl: deps.fetchImpl,
    }),
    kv: namespacedKv(deps.kv, meta.id),
    log: (message: string) => deps.log(`plugin ${meta.id}: ${message}`),
  };

  const exports = await mod.init(ctx);
  if (!exports || typeof exports !== "object") {
    deps.log(`plugin ${meta.id} ignored: init() returned nothing to register`);
    return null;
  }

  for (const group of Object.keys(exports)) {
    // Forward compatibility, and the reason it is a log rather than a throw: a plugin
    // written for a finderr that has lifecycle hooks must still load on one that does not.
    if (!(EXPORT_GROUPS as readonly string[]).includes(group)) {
      deps.log(`plugin ${meta.id}: ignoring unknown export group '${group}'`);
    }
  }

  const providers = facetProviders(meta.id, exports.facets, deps.log);
  const panes = declaredPanes(meta.id, exports.panes, deps.log);
  // A plugin that draws a pane but provides no facet is a REAL plugin, not an empty one.
  // The old "no providers" test predates the second group and would have refused exactly
  // the fixture the pane acceptance is written against.
  if (providers.length === 0 && panes.length === 0) {
    deps.log(`plugin ${meta.id} ignored: init() returned nothing to register`);
    return null;
  }
  return {
    plugin: { meta, file: origin.path, configVersion: await configVersionFor(origin) },
    providers,
    panes,
  };
}

/**
 * The `panes` group, checked declaration by declaration.
 *
 * Same rule as `facetProviders` one level up: a bad entry costs itself and nothing else, so
 * a plugin declaring three panes and fumbling one still draws two. **An unknown slot logs
 * once and no-ops** -- the forward-compatibility promise the whole declarative surface is
 * built on, applied to slots: a plugin written for a finderr with more slots than this one
 * loses that pane and keeps the rest.
 */
function declaredPanes(
  pluginId: string,
  panes: PluginExports["panes"],
  log: (m: string) => void,
): RegisteredPane[] {
  if (panes === undefined) return [];
  if (!Array.isArray(panes)) {
    log(`plugin ${pluginId}: panes is not an array -- dropped`);
    return [];
  }

  const out: RegisteredPane[] = [];
  const seen = new Set<string>();

  for (const pane of panes) {
    if (typeof pane !== "object" || pane === null) continue;
    const { slot, id, needs, render } = pane as Partial<PaneDeclaration>;

    if (typeof id !== "string" || id.length === 0) {
      log(`plugin ${pluginId}: a pane has no id -- dropped`);
      continue;
    }
    if (typeof slot !== "string" || !isPaneSlot(slot)) {
      log(`plugin ${pluginId}: pane '${id}' names unknown slot '${String(slot)}' -- dropped`);
      continue;
    }
    if (typeof render !== "function") {
      log(`plugin ${pluginId}: pane '${id}' has no render function -- dropped`);
      continue;
    }
    if (needs !== undefined && !Array.isArray(needs)) {
      log(`plugin ${pluginId}: pane '${id}' has a non-array needs -- dropped`);
      continue;
    }
    // Two panes sharing an id would collide in the client's key space, and the second is
    // the author's mistake rather than a state to represent -- same judgement `add()` makes
    // about two plugins claiming one plugin id.
    if (seen.has(id)) {
      log(`plugin ${pluginId}: pane id '${id}' is declared twice -- second dropped`);
      continue;
    }

    seen.add(id);
    out.push({ pluginId, slot, id, needs: needs ?? [], render });
  }
  return out;
}

/**
 * The `facets` group, checked against the vocabulary key by key.
 *
 * A bad KEY costs its own entry and nothing else -- a plugin naming one facet core does
 * not have still provides the twelve it named correctly. That is the same rule the
 * resolver applies to a bad ANSWER, one level up.
 */
function facetProviders(
  pluginId: string,
  facets: PluginExports["facets"],
  log: (m: string) => void,
): RegisteredProvider[] {
  const providers: RegisteredProvider[] = [];

  for (const [facet, run] of Object.entries(facets ?? {})) {
    if (typeof run !== "function") {
      log(`plugin ${pluginId}: facets.${facet} is not a function -- dropped`);
      continue;
    }
    if (!isFacetName(facet)) {
      log(`plugin ${pluginId}: '${facet}' is not a facet core declares -- dropped`);
      continue;
    }
    // WHY a facet is core-owned is written beside the facet, not here -- see `coreOnly` and
    // the `availability` entry in `facets.ts`. This is the enforcement, and it reads the flag.
    if (FACETS[facet].coreOnly) {
      log(`plugin ${pluginId}: '${facet}' is core-owned and cannot be provided -- dropped`);
      continue;
    }
    providers.push({ pluginId, facet, run: run as FacetProvider });
  }
  return providers;
}

/** Why this meta is unusable, or null if it is fine. */
function metaProblem(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return "no meta export";
  const m = meta as Partial<PluginMeta>;

  if (typeof m.id !== "string" || !PLUGIN_ID.test(m.id)) {
    return `meta.id ${JSON.stringify(m.id)} must be kebab-case -- it namespaces the plugin's data`;
  }
  // What a plugin provides is not checked here any more: the keys `init` returns ARE the
  // declaration, so there is no `provides` list that can disagree with them. See
  // `facetProviders`, which validates the real thing rather than a promise about it.
  if (!Array.isArray(m.entities) || m.entities.length === 0) return "meta.entities must be a non-empty array";
  if (m.hosts !== undefined && (!Array.isArray(m.hosts) || m.hosts.some((h) => typeof h !== "string"))) {
    return "meta.hosts must be an array of hostnames";
  }
  return null;
}

/** `plugin:<id>:<key>`, so collisions between plugins are structurally impossible. */
function namespacedKv(kv: KeyValueStore, pluginId: string): PluginKv {
  const prefix = `plugin:${pluginId}:`;
  return {
    get: (key) => kv.getKv(prefix + key),
    set: (key, value) => kv.setKv(prefix + key, value),
  };
}
