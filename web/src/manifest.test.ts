import { describe, expect, test } from "bun:test";

/**
 * The web app manifest is a static JSON file nothing imports, so no other test in this
 * suite can notice when a field goes missing -- and the symptom of a broken one is only
 * visible on a device somebody has to install the app onto. These tests are the standing
 * check that "add to home screen" still produces the app rather than a browser bookmark.
 *
 * Only the fields that CHANGE BEHAVIOUR are pinned. Wording and colour are taste and are
 * deliberately left alone.
 */

const MANIFEST = (await Bun.file(new URL("../public/site.webmanifest", import.meta.url)).json()) as {
  id?: string;
  name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  icons?: { src: string; sizes: string; type: string; purpose: string }[];
};

describe("web app manifest", () => {
  /**
   * WITHOUT `id`, THE APP'S IDENTITY IS ITS `start_url`.
   *
   * That is the spec's fallback, and it means changing `start_url` later -- to land an
   * installed launch on a shelf rather than on search, say -- reads as a DIFFERENT app to
   * the browser: the installed copy is orphaned, keeps its old start page forever, and a
   * fresh install appears beside it. `id` is the stable name that makes `start_url` an
   * ordinary editable field. It costs one line now and cannot be added retroactively
   * without the same orphaning it prevents.
   */
  test("it declares a stable id, so start_url stays editable", () => {
    expect(MANIFEST.id).toBe("/");
  });

  /**
   * `display: standalone` is what removes the browser chrome. Drop it and the installed
   * icon opens a tab with an address bar -- a bookmark, not an app -- and every other
   * decision on this card (the safe-area insets, the service worker's offline shell, web
   * push, which iOS serves ONLY to an installed app) is aimed at a window that never opens.
   */
  test("it opens as an app, not as a tab", () => {
    expect(MANIFEST.display).toBe("standalone");
    expect(MANIFEST.scope).toBe("/");
    expect(MANIFEST.start_url).toBe("/");
  });

  /**
   * Android draws the icon inside a shape of its own choosing and CROPS anything outside
   * the safe circle. A set with no `maskable` entry gets the `any` icon shrunk into a white
   * rounded square instead -- the "icon in a box" look that says nobody checked.
   *
   * The 192 and 512 pair is the installability floor every engine agrees on.
   */
  test("it ships the icon sizes an installer needs, including a maskable one", () => {
    const icons = MANIFEST.icons ?? [];
    expect(icons.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  /**
   * Icons are DERIVED from `assets/brand/*.svg` by `bun run icons:build`. A manifest naming
   * a file that is not in `web/public/` installs an app with no icon at all, and nothing in
   * the build fails -- the browser just gives up quietly at install time.
   */
  test("every icon it names is actually on disk", async () => {
    for (const icon of MANIFEST.icons ?? []) {
      const file = Bun.file(new URL(`../public${icon.src}`, import.meta.url));
      expect(await file.exists()).toBe(true);
    }
  });
});
