import { describe, expect, test } from "bun:test";
import { PeakMemory, ResourceMonitor } from "./runtime-stats";

describe("PeakMemory", () => {
  /**
   * A process whose size the TEST sets, so a spike is a fact of the fixture rather than
   * something the test hopes the collector produces.
   *
   * Driven by a variable the job body writes rather than by call order, and that distinction
   * is what makes the first test below a real guard: a fixture that hands back the next
   * scripted value on each call is satisfied by the opening and closing reads alone, so it
   * would pass with the sampler deleted -- which is the one thing worth catching here.
   */
  function sized(): { rss: number; read: () => { rss: number; heapUsed: number } } {
    const proc = { rss: 100e6, read: () => ({ rss: proc.rss, heapUsed: proc.rss / 2 }) };
    return proc;
  }

  /*
    THE WHOLE POINT, IN ONE ASSERTION. The job starts small, spikes in the middle and is back
    to small before it returns -- exactly the shape a gauge read afterwards reports as "nothing
    happened", and exactly the shape Seerr's thirty-second monitoring missed for sixteen days.
    Only a reading taken DURING the job can see 900.
  */
  test("keeps the spike, not the size the job started or ended at", async () => {
    const proc = sized();
    const peak = new PeakMemory(proc.read);

    await peak.during("arr-library", async () => {
      proc.rss = 900e6;
      // Comfortably more than one sample interval, so the sampler gets several chances.
      await new Promise((r) => setTimeout(r, 90));
      proc.rss = 110e6;
    });

    expect(peak.highest?.job).toBe("arr-library");
    expect(peak.highest?.rssMb).toBe(900);
  });

  test("nothing has run yet reads as null, never as zero", () => {
    expect(new PeakMemory().highest).toBeNull();
  });

  /** A high-water mark that a quieter job could lower would put the reader back to guessing. */
  test("a later, smaller job does not lower the mark", async () => {
    const proc = sized();
    const peak = new PeakMemory(proc.read);

    proc.rss = 500e6;
    await peak.during("arr-library", async () => {});
    proc.rss = 20e6;
    await peak.during("plex-mirror", async () => {});

    expect(peak.highest).toMatchObject({ job: "arr-library", rssMb: 500 });
  });

  test("a bigger job takes the record, and names itself", async () => {
    const proc = sized();
    const peak = new PeakMemory(proc.read);

    proc.rss = 20e6;
    await peak.during("arr-library", async () => {});
    proc.rss = 700e6;
    await peak.during("plex-mirror", async () => {});

    expect(peak.highest).toMatchObject({ job: "plex-mirror", rssMb: 700 });
  });

  /**
   * This is an OBSERVER. A mirror walk that throws must throw exactly as it would without it,
   * and the reading taken up to the failure is still worth keeping -- a job that died of
   * memory is precisely the one whose peak somebody will want.
   */
  test("a job that throws still throws, and its reading is still recorded", async () => {
    const proc = sized();
    const peak = new PeakMemory(proc.read);

    await expect(
      peak.during("arr-library", async () => {
        proc.rss = 400e6;
        throw new Error("radarr is unwell");
      }),
    ).rejects.toThrow("radarr is unwell");

    expect(peak.highest?.rssMb).toBe(400);
  });

  test("the job's own result passes straight through", async () => {
    const proc = sized();
    expect(await new PeakMemory(proc.read).during("arr-library", async () => ({ radarr: 1381 }))).toEqual({
      radarr: 1381,
    });
  });
});

describe("ResourceMonitor", () => {
  test("reports the caller's extra when it has one", () => {
    const monitor = new ResourceMonitor(
      () => {},
      () => "fuzzy 123 words",
    );
    expect(monitor.line()).toContain("fuzzy 123 words");
  });

  /**
   * The half of the 2026-09-01 fresh-install crash loop that lived here.
   *
   * `extra` is a closure over something this class knows nothing about, and the one in the
   * server read the title index -- which does not exist yet during a first install, and
   * throws when asked. It threw on the first tick, inside a `setInterval` with nobody to
   * catch it, and the container exited 1. A resource log line took down a process that was
   * booting specifically in order to build the index it was complaining about.
   */
  test("a throwing extra does not take the line -- or the process -- down", () => {
    const monitor = new ResourceMonitor(
      () => {},
      () => {
        throw new Error("no title index is open yet");
      },
    );

    const line = monitor.line();

    expect(line).toContain("rss ");
    // Marked rather than silently dropped: a diagnostic that fails should say so.
    expect(line).toContain("extra:unavailable");
  });

  test("the timer keeps logging after an extra has thrown", () => {
    const lines: string[] = [];
    let calls = 0;
    const monitor = new ResourceMonitor(
      (m) => lines.push(m),
      () => {
        calls++;
        if (calls === 1) throw new Error("not ready");
        return "ready now";
      },
    );

    // `start()` primes `prev` with one call, which is the one that throws here.
    monitor.start(10_000);
    lines.push(monitor.line());
    monitor.stop();

    expect(lines.at(-1)).toContain("ready now");
  });
});
