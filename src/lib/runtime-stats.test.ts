import { describe, expect, test } from "bun:test";
import { ResourceMonitor } from "./runtime-stats";

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
