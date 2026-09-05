import { describe, expect, test } from "bun:test";
import { detectMemoryBudget, readMemoryUsage, resolveTuning } from "./memory-budget";

const budget = (mb: number) => ({ mb, source: "cgroup-v2" as const });
const MB = 1e6;

describe("detectMemoryBudget", () => {
  test("an explicit override wins and is labelled as configured", () => {
    expect(detectMemoryBudget(512)).toEqual({ mb: 512, source: "configured" });
  });

  test("no override falls through to something plausible", () => {
    // Cannot assert the SOURCE -- it depends on whether the test host is containerised, and a
    // test that demanded `host-ram` would fail in CI's own container for the right reason.
    const b = detectMemoryBudget();
    expect(b.mb).toBeGreaterThan(0);
    expect(["cgroup-v2", "cgroup-v1", "host-ram"]).toContain(b.source);
  });
});

describe("readMemoryUsage", () => {
  test("answers on every host, and says null rather than 0 where it cannot see", () => {
    // Runs on macOS (no cgroup at all), in cgroup v1 on the deployment kernel and in cgroup v2
    // under Docker Desktop and CI. The contract is the same in all three: either a number or
    // an explicit null. A 0 would read as "no page cache", which is a claim, and on macOS the
    // truth is that the file does not exist.
    const u = readMemoryUsage();
    expect([null, "cgroup-v1", "cgroup-v2"]).toContain(u.source);
    for (const v of [u.currentMb, u.cacheMb, u.rssMb, u.swapMb, u.failcnt, u.pressureSome10]) {
      expect(v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0)).toBe(true);
    }
    // The two spellings are read as one vocabulary: a source means the two numbers that
    // matter are both present, never one of them.
    if (u.source !== null) {
      expect(typeof u.cacheMb).toBe("number");
      expect(typeof u.rssMb).toBe("number");
    }
  });
});

describe("resolveTuning", () => {
  test("prefaults when the index comfortably fits the budget", () => {
    const t = resolveTuning({ budget: budget(4096), indexBytes: 1900 * MB });
    expect(t.prefault).toBe(true);
    expect(t.notes.join(" ")).toContain("prefault on");
  });

  test("STILL prefaults an index larger than the budget -- measured worth 16x there", () => {
    // The live-deployment shape: a 1500 MB cap against an ~1868 MB index, so the index is 125%
    // of the budget and plainly does not fit. Measured on a spinning array, the prefault is
    // still worth 16x on a container's first queries (480 ms against 7,858 ms) because 79% of
    // the file stays resident. The rule that shipped here first turned it OFF in exactly this
    // case, on the reasoning that it did not fit -- which was never the question.
    const t = resolveTuning({ budget: budget(1500), indexBytes: 1868 * MB });
    expect(t.prefault).toBe(true);
    expect(t.notes.join(" ")).toContain("prefault on");
  });

  test("gives up once too little of the index would survive to be worth the read", () => {
    // The knee is a CLIFF, not a slope, and both sides of it are measured on real hardware:
    // 79% retention (1500 MB budget) prefaulted in 1,106 ms, 69% (1308 MB) took 12,046 ms.
    // The threshold has to fall between them, so both of these are load-bearing.
    expect(resolveTuning({ budget: budget(1500), indexBytes: 1868 * MB }).prefault).toBe(true);
    expect(resolveTuning({ budget: budget(1308), indexBytes: 1868 * MB }).prefault).toBe(false);
    expect(resolveTuning({ budget: budget(1024), indexBytes: 1868 * MB }).prefault).toBe(false);
  });

  test("the boundary is on RETENTION, so a smaller index prefaults at a smaller budget", () => {
    // The same budget answers differently depending on the file, which is the whole point of
    // deriving it: 500 MB holds a 600 MB index well enough and a 1.9 GB one not at all.
    expect(resolveTuning({ budget: budget(500), indexBytes: 600 * MB }).prefault).toBe(true);
    expect(resolveTuning({ budget: budget(500), indexBytes: 1868 * MB }).prefault).toBe(false);
  });

  test("a forced prefault is honoured, and the note claims only what was measured", () => {
    // This assertion has been written three ways and the third is the honest one. Below the knee
    // the prefault measured no FASTER than skipping it; whether it is actively slower looked
    // established from one pair per budget and did not survive a repeatability check (six
    // measurements of one cell spanned 7,865-20,124 ms). So the note says "no faster" and names
    // the variance, rather than asserting a 1.65x penalty it cannot support.
    const t = resolveTuning({ budget: budget(512), indexBytes: 1868 * MB, prefaultOverride: true });
    expect(t.prefault).toBe(true);
    expect(t.notes.join(" ")).toContain("no faster");
    expect(t.notes.join(" ")).toContain("unresolved");
  });

  test("prefault can be forced off on a machine where it would have fitted", () => {
    const t = resolveTuning({ budget: budget(8192), indexBytes: 1000 * MB, prefaultOverride: false });
    expect(t.prefault).toBe(false);
  });

  test("an empty data directory is not a reason to refuse anything", () => {
    // A first install has no index yet. Nothing to prefault and nothing to size a map to; the
    // settings are recomputed once one is adopted.
    const t = resolveTuning({ budget: budget(512), indexBytes: 0 });
    expect(t.prefault).toBe(true);
    expect(t.mmapBytes).toBeGreaterThan(0);
  });

  test("cache scales with the budget and stays inside its clamps", () => {
    expect(resolveTuning({ budget: budget(512), indexBytes: 0 }).cacheKib).toBe(26 * 1024);
    expect(resolveTuning({ budget: budget(64), indexBytes: 0 }).cacheKib).toBe(8 * 1024); // floor
    expect(resolveTuning({ budget: budget(100_000), indexBytes: 0 }).cacheKib).toBe(256 * 1024); // ceil
  });

  test("mmap covers the WHOLE index and is never capped at the budget", () => {
    // A map is address space; the cgroup charges a page when it is faulted, not when it is
    // mapped. Capping at the budget would make SQLite pread everything past the cap -- partially
    // disabling mmap on precisely the smallest machines, where turning it off measured 2.6x
    // slower cold on a spinning array.
    expect(resolveTuning({ budget: budget(1500), indexBytes: 1892 * MB }).mmapBytes).toBe(1892 * 1024 * 1024);
    expect(resolveTuning({ budget: budget(512), indexBytes: 1892 * MB }).mmapBytes).toBe(1892 * 1024 * 1024);
    expect(resolveTuning({ budget: budget(8192), indexBytes: 1892 * MB }).mmapBytes).toBe(1892 * 1024 * 1024);
  });

  test("mmap is never disabled by derivation -- turning it off measured 2.6x SLOWER on an array", () => {
    for (const mb of [64, 128, 512, 1500, 8192]) {
      expect(resolveTuning({ budget: budget(mb), indexBytes: 1892 * MB }).mmapBytes).toBeGreaterThan(0);
    }
  });

  test("every override is echoed in the notes with the env var that set it", () => {
    const t = resolveTuning({
      budget: budget(2048),
      indexBytes: 1000 * MB,
      mmapMbOverride: 900,
      cacheMbOverride: 64,
      prefaultOverride: false,
    });
    const notes = t.notes.join("\n");
    expect(notes).toContain("FINDERR_SQLITE_MMAP_MB");
    expect(notes).toContain("FINDERR_SQLITE_CACHE_MB");
    expect(notes).toContain("FINDERR_INDEX_PREFAULT");
    expect(t.mmapBytes).toBe(900 * 1024 * 1024);
    expect(t.cacheKib).toBe(64 * 1024);
  });

  test("the budget source travels with the number, so a log line can explain itself", () => {
    const t = resolveTuning({ budget: { mb: 1500, source: "cgroup-v1" }, indexBytes: 0 });
    expect(t.budgetSource).toBe("cgroup-v1");
    expect(t.notes[0]).toContain("cgroup-v1");
  });
});
