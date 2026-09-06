/**
 * WHERE THE DELETE BUTTON IS ALLOWED TO APPEAR, enforced by reading the tree.
 *
 * > [!CAUTION] The regression this exists to catch is a one-line import that looks helpful
 * > aannarr's scoping for removal is that it lives on the QUEUE or the REQUESTS PAGE and
 * > nowhere else -- not on a title page, not on a card, not in search. The obvious next edit
 * > is somebody adding `RemoveMediaControl` to `TitleCard` "for convenience", which puts an
 * > irreversible verb beside a Request button on every grid in the product. No type error, no
 * > failing render test, and a reviewer would have to know the rule to object.
 *
 * A source scan rather than a render assertion, because the property is about the WHOLE tree:
 * a test that renders `TitleCard` and finds no Remove button proves nothing about the twelve
 * other components that could grow one tomorrow. Same idiom, and the same reason, as
 * `./runtime-deps.test.ts` -- a pure file read, no build and no DOM.
 *
 * It lives under `src/` rather than `web/` so it runs in `bun run test`, which is the suite
 * that already reads `web/src` off disk (`./doc-links.test.ts` does the same).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const WEB = new URL("../../web/src/", import.meta.url).pathname;

/** The component, and the only two routes entitled to draw it. */
const CONTROL = "RemoveMediaControl";
const ALLOWED = ["routes/LogRoute.tsx", "routes/RequestsRoute.tsx"];

/**
 * Every file under `web/src` matching `pattern`, ignoring tests and whichever modules are
 * entitled to it. Sorted, so a failure reads as a set rather than as a scan order.
 */
function filesMatching(pattern: RegExp, exempt: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of new Glob("**/*.{ts,tsx}").scanSync({ cwd: WEB }) as Iterable<string>) {
    if (exempt.includes(file) || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    if (pattern.test(readFileSync(`${WEB}${file}`, "utf8"))) found.push(file);
  }
  return found.sort();
}

const CONTROL_MODULE = "components/RemoveMediaControl.tsx";

describe("the removal control's surface", () => {
  // The IMPORT specifically. The component's name turning up in a comment is prose rather
  // than a surface -- this rule is quoted in `RemoveMediaControl`'s own doc.
  test("only the requests page and the queue import it", () => {
    const imports = new RegExp(`\\bimport\\b[^;]*\\b${CONTROL}\\b`, "s");
    expect(filesMatching(imports, [CONTROL_MODULE])).toEqual(ALLOWED);
  });

  /*
    The other half, and it is not implied by the first: a route could stop importing the
    component and call the endpoint itself, which is the same button under another name. The
    two functions in `web/src/lib/api.ts` are the only way to reach it, and the control is the
    only thing entitled to call them.
  */
  test("nothing else reaches the removal endpoint by hand", () => {
    const callsApi = /\b(removeMedia|getRemovalPreview)\b/;
    expect(filesMatching(callsApi, [CONTROL_MODULE, "lib/api.ts"])).toEqual([]);
  });
});
