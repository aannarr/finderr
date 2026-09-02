import { describe, expect, test } from "bun:test";

/**
 * TWO FILES NAME THE WORKER'S URL, AND NOTHING ELSE MAKES THEM AGREE.
 *
 * `sw-register.ts` asks the browser for `/sw.js`; `vite.config.ts` decides that the `sw`
 * entry is the one chunk emitted unhashed at the root. They cannot share a constant --
 * importing one from the other would put the shared module in BOTH bundles and give the
 * worker an `import` of a hashed chunk, which is exactly the shape the unhashed name exists
 * to avoid.
 *
 * So they are checked against each other instead. The failure this prevents is silent and
 * total: change the name in one file and every browser registers nothing, `serviceWorker()`
 * swallows the rejection by design, and the app looks completely fine while offline, the
 * image cache and web push are all quietly gone.
 */

const REGISTER = await Bun.file(new URL("./sw-register.ts", import.meta.url)).text();
const VITE_CONFIG = await Bun.file(new URL("../../vite.config.ts", import.meta.url)).text();

describe("the service worker's URL", () => {
  test("the client asks for it at the root, unhashed", () => {
    expect(REGISTER).toContain('const SW_URL = "/sw.js"');
  });

  test("the build emits it there", () => {
    // The name is what the browser compares byte-for-byte to decide an update exists, and
    // a worker below the root can only ever claim the scope it is served from.
    expect(VITE_CONFIG).toContain('chunk.name === "sw" ? "sw.js"');
  });

  test("it is registered for the whole origin", () => {
    // Without this the scope is the directory the script came from. It is the root here
    // either way, so the argument is a statement of intent that survives the file moving.
    expect(REGISTER).toContain('scope: "/"');
  });
});
