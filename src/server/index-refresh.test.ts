import { describe, expect, test } from "bun:test";
import { loadConfig } from "../lib/config";
import { IndexRefresher } from "./index-refresh";
import type { LiveIndex, ReloadOutcome } from "./live-index";

/** The slice of `LiveIndex` a refresh touches, with the calls recorded. */
function fakeLive(opts: { ready: boolean; swapped?: boolean }) {
  const calls: string[] = [];
  const outcome = (swapped: boolean): ReloadOutcome => ({
    ok: true,
    swapped,
    at: new Date().toISOString(),
    ms: 1,
    builtAt: "2026-09-01T00:00:00.000Z",
    rows: 10,
  });
  const live = {
    get ready() {
      return opts.ready;
    },
    open: () => {
      calls.push("open");
      return outcome(opts.swapped ?? true);
    },
    reload: () => {
      calls.push("reload");
      return outcome(opts.swapped ?? true);
    },
  } as unknown as LiveIndex;
  return { live, calls };
}

function refresherWith(opts: {
  ready: boolean;
  exitCode?: number;
  swapped?: boolean;
  onBuild?: () => void;
  hold?: Promise<void>;
}) {
  const { live, calls } = fakeLive({ ready: opts.ready, swapped: opts.swapped });
  const builds: number[] = [];
  let warmed = 0;
  const refresher = new IndexRefresher({
    cfg: loadConfig(),
    live,
    log: () => {},
    script: "/nowhere/build-index.ts",
    runBuild: async () => {
      builds.push(1);
      opts.onBuild?.();
      if (opts.hold) await opts.hold;
      return opts.exitCode ?? 0;
    },
    onSwapped: () => {
      warmed++;
    },
  });
  return { refresher, calls, builds, warmed: () => warmed };
}

describe("IndexRefresher", () => {
  test("builds, then RELOADS when an engine is already serving", async () => {
    const { refresher, calls, builds } = refresherWith({ ready: true });

    const out = await refresher.run("test");

    expect(builds.length).toBe(1);
    expect(calls).toEqual(["reload"]);
    expect(out.exitCode).toBe(0);
    expect(out.reload?.swapped).toBe(true);
  });

  test("builds, then OPENS when there is no engine yet", async () => {
    const { refresher, calls } = refresherWith({ ready: false });

    await refresher.run("test");

    // `open()` and `reload()` are different operations -- reload's whole vocabulary is
    // about a file renamed under an OPEN connection, and there is none here.
    expect(calls).toEqual(["open"]);
  });

  test("a refused build adopts NOTHING -- promote never ran, so the open file is unchanged", async () => {
    const { refresher, calls } = refresherWith({ ready: true, exitCode: 3 });

    const out = await refresher.run("test");

    expect(out.exitCode).toBe(3);
    expect(out.reload).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("warms only when the reference actually MOVED", async () => {
    const swapped = refresherWith({ ready: true, swapped: true });
    await swapped.refresher.run("test");
    expect(swapped.warmed()).toBe(1);

    const unchanged = refresherWith({ ready: true, swapped: false });
    await unchanged.refresher.run("test");
    // `ok: true, swapped: false` is the daily no-op: the file on disk is the one already
    // open. Re-warming the shelves for it would be work for a front page that cannot have
    // changed.
    expect(unchanged.warmed()).toBe(0);
  });

  test("a SECOND caller joins the run in flight instead of starting a second build", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { refresher, builds } = refresherWith({ ready: true, hold });

    const first = refresher.run("boot");
    const second = refresher.run("scheduled");
    expect(refresher.refreshing()).toBe(true);

    release();
    const [a, b] = await Promise.all([first, second]);

    // The case is real rather than defensive: a container restarted a minute before the
    // cron fires has a boot stale-check and a scheduled refresh landing together, and two
    // builds would race on one `titles.new.db` and on the promote.
    expect(builds.length).toBe(1);
    expect(a.joined).toBeUndefined();
    expect(b.joined).toBe(true);
    expect(b.exitCode).toBe(a.exitCode);
  });

  test("the guard clears, so a later refresh runs again", async () => {
    const { refresher, builds } = refresherWith({ ready: true });

    await refresher.run("first");
    expect(refresher.refreshing()).toBe(false);
    await refresher.run("second");

    expect(builds.length).toBe(2);
  });

  test("a build that THROWS clears the guard rather than wedging every later refresh", async () => {
    const { live } = fakeLive({ ready: true });
    const refresher = new IndexRefresher({
      cfg: loadConfig(),
      live,
      log: () => {},
      script: "/nowhere/build-index.ts",
      runBuild: () => Promise.reject(new Error("spawn failed")),
    });

    await expect(refresher.run("test")).rejects.toThrow("spawn failed");
    expect(refresher.refreshing()).toBe(false);
  });
});
