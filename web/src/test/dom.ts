/**
 * Put a DOM on the globals, before anything that needs one is imported.
 *
 * ORDER IS EVERYTHING HERE, and it is why this is a `--preload` and not an import. ES modules
 * evaluate every import before the importing module's body, so a test file that called
 * `register()` in its own body would already have loaded `@testing-library/react` -- and
 * React DOM under it -- against a bare Bun global with no `document`. A preload runs before
 * any test file is read, which is the one position early enough. The same rule is why the
 * `cleanup` import at the bottom of this file is dynamic.
 *
 * Loaded by the `test:web` script rather than by each test that wants it, so the whole web
 * suite runs against ONE environment. Bun shares globals across the files in a run, so
 * per-file registration would mean a DOM that exists or not depending on which test file
 * happened to load first -- the same suite passing or failing on file order.
 *
 * > [!CAUTION] THE SERVER SUITE MUST NOT GET THIS, and that is what `./src` in the `test`
 * > script is for
 * > Registering happy-dom globally replaces Bun's own `fetch`, `Request`, `Response` and
 * > `Headers` with the browser's, and the server tests build real `Request`s and read cookies
 * > back off real `Response`s. Measured, not feared: 30 of them fail with the preload on --
 * > `auth-routes.test.ts` alone stops recognising a signed-in cookie and reports every
 * > authenticated caller as anonymous.
 * >
 * > A `bun test` positional is a SUBSTRING match on the path, not a directory, so the old
 * > `bun test src` swept `web/src` in as well and ran the whole web suite a second time
 * > inside the server environment. `./src` is what makes the two runs disjoint. Widen that
 * > argument back and this preload has to go global, and 30 server tests go red.
 */

import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

/*
  UNMOUNT WHATEVER THE LAST TEST RENDERED, and it has to be registered from HERE.

  Testing Library does this itself against a GLOBAL `afterEach`, which Bun does not have --
  its hooks only exist as `bun:test` imports. The obvious place to put it back is the module
  every behaviour test imports (`./interact.ts`), and that is WRONG in a way that is green
  until the suite grows: Bun evaluates a module once and shares it, so the hook would be
  registered only for whichever test file imported it FIRST and every later file would pile
  its renders into the same document. Measured -- seven ConfirmAction tests passed alone and
  failed in the suite with "Found multiple elements".

  A preload's hooks are the run's, so this one belongs to every file. The dynamic import is
  the same ordering rule as above: a static one would load React DOM before `register()`.
*/
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);
