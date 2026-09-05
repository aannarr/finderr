/**
 * `ATTRIBUTION.md` names every source this tree actually reads.
 *
 * The credits page is the one document where being out of date is a licence problem rather
 * than a stale sentence, and it is also the one nobody thinks to update -- a plugin lands,
 * it works, and a third party is uncredited until somebody notices. So the file is guarded
 * by the code rather than by a habit.
 *
 * > [!IMPORTANT] The check is on HOSTNAMES, not on prose
 * > A plugin's `meta.hosts` is the closed, machine-readable answer to "whose infrastructure
 * > are we on", declared where it is already enforced -- core refuses any other host. So a
 * > new provider fails this suite until its host is credited, and it cannot be satisfied by
 * > a vague sentence. There is deliberately no generated section: the WORDING is a human's
 * > job and a generator would produce a table nobody would ever have read.
 *
 * The alternative considered and rejected was a `name` field on `PluginMeta` to assert on.
 * It is a second place to state something the host already states, and it would be routinely
 * filled in with the id.
 */

import { describe, expect, test } from "bun:test";
import { AWARDS } from "./award-registry";
import { BUILTIN_PLUGINS_DIR, type PluginMeta } from "./plugins";
import { repoRoot } from "./tracked-markdown";

/**
 * The document, with markdown emphasis stripped.
 *
 * `**oscar_data** by DLu` contains the asterisks between the words, so a plain `includes`
 * of the attribution string the importer stamps would fail on formatting rather than on
 * the fact being absent. The check is about what is CREDITED, so the markup goes first.
 */
async function attributionText(): Promise<string> {
  const raw = await Bun.file(`${repoRoot}ATTRIBUTION.md`).text();
  return raw.replaceAll("*", "");
}

/**
 * Both of these are specified by the source and reproduced character for character.
 *
 * IMDb's non-commercial terms and TMDB's API terms each require their own sentence. They
 * are asserted here as literals so a well-meaning edit for tone fails the suite -- these
 * are the two strings in the product that are not ours to improve.
 */
/**
 * Every `meta.hosts` in the plugin directory, read by importing each module's `meta`.
 *
 * The directory is WALKED rather than listed, and with the loader's own rule -- top-level
 * modules only, `*` never crossing a `/`, so `src/plugins/servarr/` is a plugin's parts
 * and not three more plugins. A provider added tomorrow is covered by having been added.
 *
 * `init` is deliberately never run: it wants a key-value store and a fetch, and this test
 * has a question about a DECLARATION. Importing the module is enough to read `meta`, which
 * is exactly what the loader validates before it runs anything either.
 */
async function declaredHosts(): Promise<(readonly string[])[]> {
  const glob = new Bun.Glob("*.{ts,js,mjs}");
  const out: (readonly string[])[] = [];
  for await (const name of glob.scan({ cwd: BUILTIN_PLUGINS_DIR })) {
    if (name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
    const mod = (await import(`${BUILTIN_PLUGINS_DIR}${name}`)) as { meta?: PluginMeta };
    out.push(mod.meta?.hosts ?? []);
  }
  return out;
}

const REQUIRED_NOTICES = [
  "Information courtesy of IMDb (https://www.imdb.com). Used with permission.",
  "This product uses the TMDB API but is not endorsed or certified by TMDB.",
];

describe("ATTRIBUTION.md", () => {
  test.each(REQUIRED_NOTICES)("carries the required notice: %s", async (notice) => {
    expect(await attributionText()).toContain(notice);
  });

  test("names every host a plugin is allowed to fetch", async () => {
    const text = await attributionText();
    const hosts = (await declaredHosts()).flat();

    // A plugin with no declared hosts reaches no network and needs no credit, but ZERO
    // hosts across the whole directory means the loader found nothing and this test would
    // pass by vacuum -- which is the failure mode a coverage assertion has to rule out.
    expect(hosts.length).toBeGreaterThan(0);

    const uncredited = hosts.filter((h) => !text.includes(h));
    expect(uncredited).toEqual([]);
  });

  test("names the attribution every award import stamps", async () => {
    const text = await attributionText();
    const uncredited = AWARDS.map((a) => a.source.attribution).filter((a) => !text.includes(a));
    expect(uncredited).toEqual([]);
  });

  test("names the licence every award import stamps", async () => {
    const text = await attributionText();
    const missing = AWARDS.map((a) => a.source.licence).filter((l) => !text.includes(l));
    expect(missing).toEqual([]);
  });
});
