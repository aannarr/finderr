/**
 * The operator dashboard, as markup.
 *
 * The static idiom, because this component draws and never acts: it takes a payload and
 * produces a page. What is worth asserting is not that the numbers appear -- they are
 * interpolated, so they cannot fail to -- but that the ALARMING readings are NAMED rather than
 * printed as a value the reader is left to judge.
 *
 * Each of those is a condition that was invisible before this page existed, and each one looks
 * exactly like a healthy server from anywhere else in the product: a refused index swap (the
 * library silently a day old), a prefault whose pages were reclaimed (every query back on the
 * disk, 224x slower on the NAS array), an episode mirror at zero beside a full series library
 * (nothing renders as owned), a Plex walk that matched nothing (no play buttons).
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerHealthPayload } from "../lib/health-api";
import { ServerHealth } from "./ServerHealth";

/** A server where everything is fine. Every test below spoils exactly one thing about it. */
function healthy(over: Partial<ServerHealthPayload> = {}): ServerHealthPayload {
  return {
    index: {
      rows: 1_275_341,
      builtAt: "2026-09-05T06:26:27.095Z",
      reload: {
        ok: true,
        swapped: true,
        at: "2026-09-06T09:02:00.000Z",
        ms: 4200,
        canary: { passed: 42, total: 42, ratio: 1 },
      },
      warm: {
        prefault: true,
        last: { readMb: 1868, ms: 10_520, residentMb: 1851 },
        tuning: { budgetMb: 3072, budgetSource: "cgroup-v1", mmapMb: 1868, cacheMb: 154, prefault: true },
      },
    },
    library: { radarr: 1371, sonarr: 596, episodes: 24_812 },
    plex: { items: 1730, machineId: "0123456789abcdef" },
    services: { radarr: true, sonarr: true, prowlarr: false },
    plugins: {
      loaded: [
        { id: "servarr-metadata", hosts: ["api.radarr.video"] },
        { id: "rotten-tomatoes", hosts: [] },
      ],
    },
    facets: { rows: 2652, images: 50, pruned: 0 },
    runtime: {
      uptimeSeconds: 7_400,
      rss: 168_394_752,
      cgroup: { current: 433_336_320, limit: 1_572_864_000, ratio: 0.2755 },
    },
    timings: { slow: [] },
    ...over,
  };
}

const draw = (health: ServerHealthPayload) => renderToStaticMarkup(<ServerHealth health={health} />);

describe("the index", () => {
  test("rows are grouped, so seven digits are readable at a glance", () => {
    expect(draw(healthy())).toContain("1,275,341");
  });

  /**
   * THE ONE FIELD WORTH ALERTING ON, and the reason this page exists. A refused swap means a
   * rebuilt index did not answer its canary and we are deliberately still serving yesterday's
   * -- searches work, the library is stale, and nothing else in the product says so.
   */
  test("a refused swap says REFUSED, gives the server's reason, and says the old index is live", () => {
    const html = draw(
      healthy({
        index: {
          ...healthy().index,
          reload: {
            ok: false,
            swapped: false,
            at: "2026-09-06T09:02:00.000Z",
            ms: 900,
            reason: "canary 12/42",
            canary: { passed: 12, total: 42, ratio: 0.28 },
          },
        },
      }),
    );
    expect(html).toContain("REFUSED");
    expect(html).toContain("canary 12/42");
    expect(html).toContain("previous index is still being served");
  });

  test("no swap yet is said to be ordinary rather than drawn as a hole", () => {
    const html = draw(healthy({ index: { ...healthy().index, reload: null } }));
    expect(html).toContain("not since this container started");
    expect(html).toContain("Ordinary");
  });
});

describe("the prefault", () => {
  test("a healthy warm reports what it read and what stayed resident", () => {
    const html = draw(healthy());
    expect(html).toContain("1868 MB");
    expect(html).toContain("1851 MB resident");
  });

  /**
   * The deployment that looks fine and is serving half its index off the disk: the loop ran,
   * and the container's memory cap took most of it back. `readMb` alone cannot show it, which
   * is why both numbers are drawn.
   */
  test("pages reclaimed after the warm are named, not left as two numbers to compare", () => {
    const warm = healthy().index.warm;
    const html = draw(
      healthy({
        index: {
          ...healthy().index,
          warm: warm && { ...warm, last: { readMb: 1868, ms: 10_520, residentMb: 400 } },
        },
      }),
    );
    expect(html).toContain("reclaimed");
  });

  test("a prefault that is off says what that costs", () => {
    const warm = healthy().index.warm;
    const html = draw(healthy({ index: { ...healthy().index, warm: warm && { ...warm, prefault: false } } }));
    expect(html).toContain("off");
    expect(html).toContain("off the disk");
  });

  test("no index open to ask reads as unknown rather than as off", () => {
    const html = draw(healthy({ index: { ...healthy().index, warm: null } }));
    expect(html).toContain("unknown");
  });
});

describe("connections", () => {
  test("only the configured services are named", () => {
    const html = draw(healthy());
    expect(html).toContain("radarr, sonarr");
    expect(html).not.toContain("prowlarr");
  });

  /** A series library with no episodes renders as "you own nothing" everywhere else. */
  test("zero episodes beside a full series library is explained", () => {
    const html = draw(healthy({ library: { radarr: 1371, sonarr: 596, episodes: 0 } }));
    expect(html).toContain("episode walk ran and every fetch failed");
  });

  test("a Plex sync that matched nothing is explained rather than shown as a zero", () => {
    const html = draw(healthy({ plex: { items: 0, machineId: "abc" } }));
    expect(html).toContain("legacy Plex agent");
  });

  test("Plex never synced is a different sentence from Plex matching nothing", () => {
    const html = draw(healthy({ plex: { items: 0, machineId: null } }));
    expect(html).toContain("never synced");
    expect(html).not.toContain("legacy Plex agent");
  });
});

describe("addons", () => {
  test("each one is named with the hosts it is allowed to reach", () => {
    const html = draw(healthy());
    expect(html).toContain("servarr-metadata");
    expect(html).toContain("api.radarr.video");
  });

  /** An addon with no declared hosts cannot fetch at all -- worth saying, not leaving blank. */
  test("an addon that declares no host says it reaches nothing", () => {
    expect(draw(healthy())).toContain("reaches nothing outside");
  });

  test("no addons at all is a sentence rather than an empty list", () => {
    expect(draw(healthy({ plugins: { loaded: [] } }))).toContain("No addons are loaded");
  });

  test("facts held with no proxied image is explained -- art will not render", () => {
    const html = draw(healthy({ facets: { rows: 2652, images: 0, pruned: 0 } }));
    expect(html).toContain("will not render");
  });
});

describe("the slow log", () => {
  const entry = (over: Partial<ServerHealthPayload["timings"]["slow"][number]> = {}) => ({
    at: 1_700_000_000_000,
    label: "GET /api/browse",
    ms: 3657,
    detail: "?genre=Comedy",
    ...over,
  });

  test("nothing recorded is said out loud, so an empty block is not read as a broken one", () => {
    expect(draw(healthy())).toContain("Nothing has been slow enough to record");
  });

  /**
   * The ARGUMENTS are the point. A distribution can say `/api/browse` is p95 3.6s; it cannot
   * say which browse, and on this API `?genre=Comedy` and `?kind=series` differ by 400x.
   */
  test("an entry carries its duration, its route and the arguments that made it slow", () => {
    const html = draw(healthy({ timings: { slow: [entry()] } }));
    expect(html).toContain("3.7s");
    expect(html).toContain("GET /api/browse");
    expect(html).toContain("?genre=Comedy");
  });

  test("at most twenty are drawn, however many the server kept", () => {
    const many = Array.from({ length: 40 }, (_, i) => entry({ at: 1_700_000_000_000 + i, ms: i }));
    const html = draw(healthy({ timings: { slow: many } }));
    expect(html.match(/GET \/api\/browse/g) ?? []).toHaveLength(20);
  });
});
