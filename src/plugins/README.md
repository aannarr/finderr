# Plugins

Every `.ts` file in this directory is loaded at boot and asked to register itself. Adding
one adds a source of facts; deleting one removes those facts. Neither needs a core edit.

**This is the contract, in brief. [`ADDONS.md`](../../ADDONS.md) at the repo root is the
guide** -- hello world, installing an addon as a package rather than a file, every facet
you can provide, and what the extension surface does not do yet. Read that one first if
you are writing an addon; read this one to check a rule.

```ts
import type { PluginContext, PluginExports } from "../lib/plugins";

export const meta = {
  id: "rotten-tomatoes",              // kebab-case; namespaces this plugin's data
  entities: ["movie", "series"],
  hosts: ["79frdp12pn-dsn.algolia.net"],
};

export function init(c: PluginContext): PluginExports {
  return {
    facets: {                                            // the KEYS are the declaration
      ratings: async (entity) => {                       // `c` is closed over, not passed
        const res = await c.fetch(`https://.../${entity.tconst}`);
        if (!res.ok) return null;                        // "nothing here" -- cached as empty
        return { data: [...], freshness: "settled" };    // core turns the class into a TTL
      },
    },
  };
}
```

## The contract

- **`init` RETURNS its extension points; it does not register by side effect.** The keys
  of the object are the declaration, so there is no second list to keep in step with them.
  An unknown top-level group is logged and ignored rather than fatal, so a plugin written
  for a newer finderr still loads on an older one and contributes what it can.
- **`src/lib/facets.ts` is the vocabulary.** A facet core does not declare cannot be
  provided, and a facet's shape is core's, not the plugin's. Two plugins contributing
  `ratings` merge into one list because they both fit that shape. A key core does not
  recognise costs that entry alone -- its siblings still register. One declared facet is
  nonetheless closed to plugins: `availability` is `coreOnly` and that key is dropped at
  load. The ruling and what would re-open it are beside `FACETS.availability` in that same
  file; [`ADDONS.md`](../../ADDONS.md) says what it means for an addon author.
- **Return a freshness class, never a duration.** A plugin knows what kind of fact it
  fetched; only core knows how settled this particular title is.
- **`c.fetch` is the only way out.** It refuses any host not in `meta.hosts`, refuses
  plain http, sets an honest `User-Agent`, applies a timeout, and paces calls per host so
  several plugins cannot burst onto one third party. `ALLOWED_HOSTS` in
  `src/server/artwork.ts` is unrelated -- that gates the image byte proxy.
- **Never throw at the host.** You can: a throw, a hang or a malformed answer is caught,
  logged, and leaves the facet resolved without your contribution. But returning `null`
  says "nothing here" explicitly, and it caches.
- **`c.kv` is permanent per-plugin storage**, for the expensive half of a lookup -- a
  resolved RT id, a `tconst -> tvdbId` crosswalk. Facet data belongs in the facet cache;
  ids that never change belong here so a facet expiring does not re-run a fuzzy match.
- **Providers run off the render path.** Take the time you need; the first view of a
  title may miss you and the next one will not.
- **A directory file is not the only way in.** `pluginModules` in config names installed
  packages, resolved from the app root and loaded through this same contract. The
  directory is walked first, so a local file wins a clash of ids and the loser is logged.

`*.test.ts` files here are tests, not plugins, and are skipped by the loader.

A plugin big enough to want more than one file puts the rest in a SUBDIRECTORY named after
it -- `servarr-metadata.ts` beside `servarr/`. The loader globs `*.ts` and `Bun.Glob`'s `*`
does not cross a `/`, so nothing nested is ever load-attempted; only the file at the top
level is a plugin. Fixtures a test reads go in there too, so nothing outside this directory
has to know a plugin is more than one file.
