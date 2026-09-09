/**
 * The server's third-party imports, and whether the container actually ships them.
 *
 * > [!CAUTION] The bug this exists to catch is INVISIBLE to every other gate
 * > `cockatiel` landed as a real dependency of `src/lib/facet-resolver.ts` and
 * > `src/lib/plugin-fetch.ts`. Tests, typecheck and lint all stayed green, because the
 * > host has a full `node_modules`. The RUNTIME image did not: its stage copied no
 * > `node_modules` on the stated grounds that "the server imports nothing outside Bun's
 * > own namespace", which had been true right up until it wasn't.
 * >
 * > The container then died at boot with nine lines of `bun is unable to write files:
 * > EROFS` and nothing else -- Bun trying to AUTO-INSTALL the missing package against a
 * > filesystem `docker-compose.yml` mounts read-only. Nothing named the package, and
 * > nothing pointed at the Dockerfile.
 *
 * Two halves, and both are needed. The first catches a devDependency being imported by
 * the server; the second catches the Dockerfile drifting away from `package.json` again.
 * Both are pure file reads -- no build, no container.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const ROOT = new URL("../../", import.meta.url).pathname;

const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Every bare specifier imported anywhere under `src/`, excluding tests. */
function serverImports(): Set<string> {
  const found = new Set<string>();
  for (const file of new Glob("**/*.ts").scanSync({
    cwd: `${ROOT}src`,
    absolute: true,
  }) as Iterable<string>) {
    if (file.endsWith(".test.ts")) continue;
    /*
      COMMENTS COME OUT FIRST, and that is not fussiness. This repo comments heavily and in
      full sentences, so `from "..."` appears in ordinary English all over it -- the first
      draft of this test reported `we asked and it broke` and `s own parameters; the key is
      added here` as missing npm packages. Once the prose is gone, `from "x"` is an import
      and nothing else, which also handles the multi-line `import {\n...\n} from "cockatiel"`
      that any line-anchored pattern misses.
    */
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      // Relative paths are our own code; `bun`, `bun:*` and `node:*` are the runtime's.
      if (spec.startsWith(".") || spec === "bun") continue;
      if (spec.startsWith("bun:") || spec.startsWith("node:")) continue;
      /*
        Shape check, and the last line of defence against prose. `SCHEMA` in `store.ts` is a
        template literal full of SQL `--` comments, which no JavaScript comment-stripper
        touches, and one of them reads `... apart from "we asked and it broke"`. A package
        specifier has no spaces in it; an English sentence does.
      */
      if (!/^@?[a-z0-9][a-z0-9._/-]*$/.test(spec)) continue;
      // `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`.
      const parts = spec.split("/");
      found.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  return found;
}

describe("what the server imports", () => {
  /**
   * A devDependency is not in the runtime image and never will be -- it is installed
   * with `--production` stripped out. Importing one from `src/` is a container that
   * boots on a developer's machine and dies in production.
   */
  test("every third-party import is a real dependency, never a devDependency", () => {
    const deps = new Set(Object.keys(pkg.dependencies ?? {}));
    const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
    const offenders = [...serverImports()].filter((s) => !deps.has(s));

    expect({
      // Named rather than counted, so a failure says WHICH package and where to put it.
      missing: offenders.filter((s) => !dev.has(s)),
      onlyInDev: offenders.filter((s) => dev.has(s)),
    }).toEqual({ missing: [], onlyInDev: [] });
  });
});

describe("what the container ships", () => {
  const dockerfile = readFileSync(`${ROOT}Dockerfile`, "utf8");

  /**
   * The exact regression. `dependencies` being non-empty means the runtime stage has to
   * carry them; there is no version of "the server needs no packages" that survives the
   * first `bun add`.
   */
  test("the runtime stage copies node_modules whenever there are dependencies", () => {
    const hasDeps = Object.keys(pkg.dependencies ?? {}).length > 0;
    // Flags in any order (`--chown` rides along for layer hygiene), but `--from` must be
    // among them -- a COPY from the build context would ship the host's tree.
    const copyLine = dockerfile.match(/COPY\s+(?:--\S+\s+)*\/app\/node_modules\s+\.\/node_modules/);
    const copies = copyLine?.[0].includes("--from=") ?? false;
    expect(hasDeps && !copies).toBe(false);
  });

  /**
   * From a `--production` install specifically. Copying the full dev tree would work and
   * would quietly add vite, biome and typescript to a hardened runtime image.
   */
  test("they come from a production install", () => {
    expect(dockerfile).toContain("bun install --frozen-lockfile --production");
  });

  /**
   * The BINARIES playback shells out to, which `package.json` knows nothing about.
   *
   * A missing npm package fails loudly at boot; a missing binary fails quietly at the first
   * click, per title, with the plan reading exactly as it should. `spawn` returns ENOENT deep
   * inside a segment production whose only answer to the route is 404, which is what a player
   * retries -- so the symptom is a video that buffers forever and a log nobody is tailing.
   *
   * The runtime stage RUNS `ffmpeg -version` too, so the image cannot even build without them.
   * This test is the cheap half: it fails on the machine that deleted the line, in a second,
   * rather than after a five-minute CI build.
   */
  test("the runtime stage installs the binaries playback shells out to", () => {
    /*
      SCOPED TO THE RUNTIME STAGE, and that is the whole point rather than tidiness. This
      Dockerfile has four stages and three of them are thrown away; `apk add` anywhere else
      installs into a layer the final image never sees. An unscoped search would go green on
      an ffmpeg added to the `spellfix` builder -- which is precisely the shape of mistake
      that shipped a runtime image with no node_modules and this file's whole reason to exist.
    */
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtime).not.toBe("");
    expect({
      ffmpeg: runtime.includes("ffmpeg"),
      // The iHD VAAPI driver. Without it the NAS probes clean and silently encodes in
      // software at 1.4x realtime instead of 9.3x -- see the Dockerfile for the measurement.
      intelMediaDriver: runtime.includes("intel-media-driver"),
    }).toEqual({ ffmpeg: true, intelMediaDriver: true });
  });

  /**
   * The driver is x86-ONLY, and installing it unconditionally breaks the arm64 image.
   *
   * `intel-media-driver` is the iHD VAAPI driver for Intel GPUs, and Alpine publishes no
   * `aarch64` build of it -- `apk add` there is `no such package`, not a no-op. `docker.yml`
   * builds `linux/amd64` and `linux/arm64` natively and its `merge` job is `needs`-gated on
   * both, so ONE red leg publishes NOTHING: no `sha-<full40>`, no moved `:latest`.
   *
   * That failure is expensive precisely because it is quiet from the outside. `:latest` goes
   * on answering 200 with the PREVIOUS image, so `docker compose pull` on the NAS reports
   * success and changes nothing, and `deploy.sh` can only report a 404 that never clears.
   * Measured 2026-09-09 on Alpine 3.22.5: the arm64 leg of run 34383299543 died at
   * `apk add`, having been broken since playback added the line the day before.
   *
   * Losing the driver on arm64 costs nothing real -- there is no Intel iGPU on that machine
   * to drive, and `chooseEncoder` already falls to software whenever the runtime or the
   * render node is missing. The deployment NAS is amd64 and keeps hardware encode.
   */
  test("the Intel driver install is guarded by TARGETARCH, since Alpine has no aarch64 build", () => {
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    // Fold `\`-continued lines so a multi-line RUN reads as the single command it is.
    const joined = runtime.replace(/\\\r?\n\s*/g, " ");
    // Comments are dropped BEFORE the search: the Dockerfile argues for this driver in prose
    // directly above the command, so the first line naming it is a `#` and never the install.
    const driverCommand = joined
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .find((line) => line.includes("intel-media-driver"));
    expect(driverCommand).toBeDefined();
    expect({
      argDeclared: /^ARG TARGETARCH\s*$/m.test(runtime),
      installGuarded: driverCommand?.includes("TARGETARCH") ?? false,
    }).toEqual({ argDeclared: true, installGuarded: true });
  });
});
