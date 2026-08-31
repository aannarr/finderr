/**
 * The boot-time index build.
 *
 * The bug this defends is narrow and was invisible for months: `FINDERR_INDEX_REFRESH_ON_BOOT`
 * was declared, defaulted and mapped from ENV, the boot message named it as the remedy for a
 * missing index, and NOTHING READ IT. `grep -rn refreshOnBoot src` is the honest regression
 * test for that half and it lives in `boot-config.test.ts`; this file covers what the flag
 * now actually does.
 *
 * Everything here injects its child process. Spawning the real builder would download 235 MB.
 */

import { describe, expect, test } from "bun:test";
import { buildingPage, IndexBuild, type IndexBuildChild, withIndexGate } from "./index-build";

/** A fake child whose streams and exit the test drives by hand. */
function fakeChild(opts: { stdout?: string[]; stderr?: string[]; exit?: number } = {}) {
  const killed = { value: false };
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });

  const streamOf = (chunks: string[] | undefined) =>
    chunks === undefined
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
          },
        });

  const child: IndexBuildChild = {
    exited: gate.then(() => opts.exit ?? 0),
    stdout: streamOf(opts.stdout),
    stderr: streamOf(opts.stderr),
    kill() {
      killed.value = true;
      release();
    },
  };
  return { child, finish: release, killed };
}

describe("IndexBuild", () => {
  test("reports `building` until the child exits, then `done`", async () => {
    const { child, finish } = fakeChild({ stdout: ["[index] promoted\n"] });
    const build = new IndexBuild({ script: "/x/build-index.ts", log: () => {}, spawn: () => child });

    expect(build.state.phase).toBe("building");
    expect(build.state.exitCode).toBe(null);

    finish();
    expect(await build.exited).toBe(0);
    expect(build.state.phase).toBe("done");
    expect(build.state.exitCode).toBe(0);
  });

  test("a non-zero exit is `failed`, and the code is kept", async () => {
    const { child, finish } = fakeChild({ exit: 3, stdout: ["[index] ABORT: search quality regressed\n"] });
    const build = new IndexBuild({ script: "/x/build-index.ts", log: () => {}, spawn: () => child });
    finish();

    expect(await build.exited).toBe(3);
    expect(build.state.phase).toBe("failed");
    expect(build.state.exitCode).toBe(3);
    // Exit 3 is the canary gate. The operator needs the reason, and it is the last line.
    expect(build.state.lastLine).toContain("search quality regressed");
  });

  test("progress split by `\\r` is read as separate lines, not one growing one", async () => {
    // This is exactly what the job emits: the download percentage redraws in place on
    // stderr. Splitting on `\n` alone would leave `lastLine` empty for the whole download,
    // which is the first and longest minute of the build.
    const { child, finish } = fakeChild({
      stderr: [
        "\r[index] title.basics: 10%   \r[index] title.basics: 20%   ",
        "\r[index] title.basics: 30%   ",
      ],
    });
    const build = new IndexBuild({ script: "/x/build-index.ts", log: () => {}, spawn: () => child });
    finish();
    await build.exited;

    expect(build.state.lastLine).toBe("[index] title.basics: 30%");
  });

  test("a line split across two chunks is not reported torn", async () => {
    const { child, finish } = fakeChild({ stdout: ["[index] promo", "ted -> titles.db\n"] });
    const build = new IndexBuild({ script: "/x/build-index.ts", log: () => {}, spawn: () => child });
    finish();
    await build.exited;

    expect(build.state.lastLine).toBe("[index] promoted -> titles.db");
  });

  test("a trailing line with no newline still counts", async () => {
    const { child, finish } = fakeChild({ stdout: ["[index] building"] });
    const build = new IndexBuild({ script: "/x/build-index.ts", log: () => {}, spawn: () => child });
    finish();
    await build.exited;

    expect(build.state.lastLine).toBe("[index] building");
  });

  test("a spawn that throws resolves non-zero rather than rejecting", async () => {
    // Nothing awaits this at a point where a rejection could be caught -- the completion
    // handler is a bare `.then` on the boot path -- so a throwing spawn must not become an
    // unhandled rejection that takes the process down while it is otherwise healthy.
    const logs: string[] = [];
    const build = new IndexBuild({
      script: "/x/build-index.ts",
      log: (m) => logs.push(m),
      spawn: () => {
        throw new Error("bun: not found");
      },
    });

    expect(await build.exited).toBe(1);
    expect(build.state.phase).toBe("failed");
    expect(logs.join(" ")).toContain("bun: not found");
  });

  test("elapsedMs advances while building and freezes once finished", async () => {
    let clock = 1000;
    const { child, finish } = fakeChild({});
    const build = new IndexBuild({
      script: "/x/build-index.ts",
      log: () => {},
      spawn: () => child,
      now: () => clock,
    });

    clock = 1500;
    expect(build.state.elapsedMs).toBe(500);
    finish();
    await build.exited;
    const frozen = build.state.elapsedMs;
    clock = 9999;
    expect(build.state.elapsedMs).toBe(frozen);
  });

  test("stop() kills the child", async () => {
    const { child, killed } = fakeChild({});
    const build = new IndexBuild({ script: "/x/build-index.ts", log: () => {}, spawn: () => child });
    build.stop();
    await build.exited;
    expect(killed.value).toBe(true);
  });
});

describe("withIndexGate", () => {
  // Handlers take the request they are given, like the real ones -- the wrapper is generic
  // precisely so a table's signatures survive it, and a zero-arg fixture would not test that.
  const table = {
    "/api/health": (_req: Request) => new Response("health"),
    "/api/index-status": (_req: Request) => new Response("status"),
    "/api/search": (_req: Request) => new Response("results"),
    "/api/requests": {
      GET: (_req: Request) => new Response("list"),
      POST: (_req: Request) => new Response("created"),
    },
  };

  const gated = (ready: boolean) =>
    withIndexGate(table, {
      ready: () => ready,
      state: () => null,
      open: ["/api/health", "/api/index-status"],
    });

  test("refuses an indexed route with 503 while there is no index", async () => {
    const res = (await gated(false)["/api/search"](new Request("http://x/api/search"))) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("10");
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("index") });
  });

  test("lets the two open paths through while there is no index", async () => {
    const g = gated(false);
    expect(((await g["/api/health"](new Request("http://x/api/health"))) as Response).status).toBe(200);
    expect(
      ((await g["/api/index-status"](new Request("http://x/api/index-status"))) as Response).status,
    ).toBe(200);
  });

  test("gates a method table per method, not just a bare handler", async () => {
    const g = gated(false);
    expect(((await g["/api/requests"].GET(new Request("http://x"))) as Response).status).toBe(503);
    expect(((await g["/api/requests"].POST(new Request("http://x"))) as Response).status).toBe(503);
  });

  test("passes everything through once an index is open", async () => {
    const g = gated(true);
    expect(await ((await g["/api/search"](new Request("http://x"))) as Response).text()).toBe("results");
    expect(await ((await g["/api/requests"].POST(new Request("http://x"))) as Response).text()).toBe(
      "created",
    );
  });

  test("readiness is read per REQUEST, not captured when the table is wrapped", async () => {
    // The gate is built once at boot, while the index is still missing. If it snapshotted
    // `ready` there, every route would stay 503 for the life of the process and the build
    // finishing would change nothing on screen.
    let ready = false;
    const g = withIndexGate(table, { ready: () => ready, state: () => null, open: [] });

    expect(((await g["/api/search"](new Request("http://x"))) as Response).status).toBe(503);
    ready = true;
    expect(((await g["/api/search"](new Request("http://x"))) as Response).status).toBe(200);
  });
});

describe("buildingPage", () => {
  const html = buildingPage();

  test("polls the status endpoint and reloads when it is ready", () => {
    expect(html).toContain("/api/index-status");
    expect(html).toContain("location.reload()");
  });

  test("is self-contained -- no bundle, because the build that would make one has not run", () => {
    expect(html).not.toContain("<script src");
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain("/assets/");
  });

  test("names no path, host or product route -- an anonymous visitor reaches this", () => {
    // The page is served before any account exists, so it is held to the same rule as
    // `login.html`: it says what is happening and nothing about where it is running.
    for (const leak of ["/data", "/volume", "titles.db", "radarr", "sonarr", "plex", "/api/search"]) {
      expect(html.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});
