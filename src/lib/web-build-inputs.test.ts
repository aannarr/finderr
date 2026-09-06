/**
 * Files OUTSIDE `web/` that the web bundle imports, and whether the Dockerfile copies them.
 *
 * > [!CAUTION] This bug is invisible to every other gate, and it shipped
 * > `web/src/routes/SourcesRoute.tsx` does `import attribution from "../../../ATTRIBUTION.md?raw"`.
 * > That makes a repo-root markdown file a BUILD INPUT of the web bundle. On any developer's
 * > machine the file is simply there, so `bun run build:web` is green, and so are test,
 * > test:web, typecheck, lint and the canary -- none of them build an image.
 * >
 * > In Docker the `web` stage copies `tsconfig.json`, `biome.json`, `web/` and `src/` and
 * > nothing else, so the build died with `[UNRESOLVED_IMPORT] Could not resolve
 * > '../../../ATTRIBUTION.md?raw'`. Both architectures, every time.
 * >
 * > It went unnoticed because `/sources` landed AFTER the last green CI run and the two runs
 * > after it failed at the `gate` job first, which masked the build. Nothing had built this
 * > import, ever.
 *
 * The rule this pins: **an import that escapes `web/` needs a matching `COPY` in the web
 * stage.** It is a pure file read -- no build, no container, no network -- so it costs
 * nothing to run on every commit, which is the whole point of catching this here rather than
 * fifteen minutes into CI.
 *
 * Same shape and same reason as `runtime-deps.test.ts`, which pins the OTHER direction: that
 * the runtime stage ships the packages the server imports.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = new URL("../../", import.meta.url).pathname;
const WEB = `${ROOT}web/`;

/**
 * Every path the web tree imports that resolves OUTSIDE `web/`, relative to the repo root.
 *
 * Comments are stripped first for the same reason `runtime-deps.test.ts` strips them: this
 * repo writes long prose comments, and `from "..."` occurs in ordinary English throughout.
 */
function rootImports(): Set<string> {
  const found = new Set<string>();
  for (const file of new Glob("**/*.{ts,tsx}").scanSync({
    cwd: WEB,
    absolute: true,
  }) as Iterable<string>) {
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g)) {
      const spec = m[1] ?? m[2];
      if (!spec?.startsWith(".")) continue;
      // `?raw`, `?url`, `?inline` are vite's resource queries and are not part of the path.
      const target = resolve(dirname(file), spec.split("?")[0]);
      if (target.startsWith(WEB)) continue;
      found.add(relative(ROOT, target));
    }
  }
  return found;
}

/** Everything the Dockerfile's `web` stage copies in, as written. */
function webStageCopies(): string[] {
  const dockerfile = readFileSync(`${ROOT}Dockerfile`, "utf8");
  const start = dockerfile.indexOf("FROM deps AS web");
  expect(start).toBeGreaterThan(-1);
  const after = dockerfile.indexOf("\nFROM ", start + 1);
  const stage = dockerfile.slice(start, after === -1 ? undefined : after);
  const copied: string[] = [];
  for (const m of stage.matchAll(/^COPY\s+(.+)$/gm)) {
    // `COPY a b ./` -- every argument but the last is a source.
    const args = m[1].trim().split(/\s+/);
    copied.push(...args.slice(0, -1));
  }
  return copied;
}

/**
 * Does this import resolve to something on disk?
 *
 * Most of these are extensionless TypeScript imports of server modules -- `../../../src/lib/search`
 * is `src/lib/search.ts` -- so a bare `existsSync` reports every one of them missing. The
 * asset imports (`ATTRIBUTION.md?raw`) are the ones that carry their extension already.
 */
function resolvesOnDisk(path: string): boolean {
  const base = `${ROOT}${path}`;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].some(existsSync);
}

describe("what the web bundle imports from outside web/", () => {
  test("every one of them is a real file", () => {
    for (const path of rootImports()) {
      expect(resolvesOnDisk(path), `${path} is imported by web/ but does not exist`).toBe(true);
    }
  });

  /*
    THE ONE THAT MATTERS. A root-level import with no COPY builds fine on a laptop and fails
    only inside Docker, which is the most expensive place to find out.

    A source is a match if it names the file outright or names a directory containing it, so
    `COPY src ./src` covers `src/lib/x.ts` without this needing to know that.
  */
  test("every one of them is COPYed into the Dockerfile's web stage", () => {
    const copies = webStageCopies();
    for (const path of rootImports()) {
      const covered = copies.some((c) => {
        const src = c.replace(/^\.\//, "").replace(/\/$/, "");
        return path === src || path.startsWith(`${src}/`);
      });
      expect(
        covered,
        `web/ imports ${path}, but the Dockerfile's web stage never COPYs it -- ` +
          `the image build will fail with UNRESOLVED_IMPORT. Copies seen: ${copies.join(", ")}`,
      ).toBe(true);
    }
  });

  /*
    A COPY cannot rescue a file the daemon was never sent. `.dockerignore` excludes README.md,
    ADDONS.md and LICENSE by name under "Docs and assets the runtime does not serve", and
    ATTRIBUTION.md is one edit away from joining that list -- at which point the COPY above
    starts failing instead of working, with a different and equally confusing message.
  */
  test("none of them is excluded by .dockerignore", () => {
    const ignored = readFileSync(`${ROOT}.dockerignore`, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const path of rootImports()) {
      expect(ignored.includes(path), `${path} is a web build input and .dockerignore excludes it`).toBe(
        false,
      );
    }
  });

  test("the sweep matches something, so a green run means checked rather than empty", () => {
    // A pattern that quietly stops matching is the failure this repo has paid for repeatedly.
    expect(rootImports().size).toBeGreaterThan(0);
    expect([...rootImports()]).toContain("ATTRIBUTION.md");
  });
});
