import { describe, expect, test } from "bun:test";
import { SlowLog } from "../lib/slow-log";
import { Timings } from "../lib/timings";
import { withTiming } from "./request-timing";

/**
 * A clock the test drives by hand.
 *
 * The wrapper reads `elapsed()` once before the handler and once after, so advancing it
 * INSIDE the handler is how a test says "this took 900ms" without waiting 900ms.
 */
function fakeClock(): { now: () => number; elapsed: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => 1_700_000_000_000 + t, elapsed: () => t, advance: (ms) => (t += ms) };
}

function harness(thresholdMs = 500) {
  const clock = fakeClock();
  const timings = new Timings();
  const slow = new SlowLog();
  const lines: string[] = [];
  return {
    clock,
    timings,
    slow,
    lines,
    opts: {
      timings,
      slow,
      thresholdMs,
      log: (l: string) => lines.push(l),
      now: clock.now,
      elapsed: clock.elapsed,
    },
  };
}

const req = (url: string, method = "GET") => new Request(url, { method });

describe("withTiming", () => {
  test("records every request under the route PATTERN, not the filled-in path", () => {
    const h = harness();
    const routes = withTiming({ "/api/title/:tconst": () => new Response("ok") }, h.opts);

    (routes["/api/title/:tconst"] as (r: Request) => unknown)(req("http://x/api/title/tt0111161"));
    (routes["/api/title/:tconst"] as (r: Request) => unknown)(req("http://x/api/title/tt0068646"));

    // One key with two samples -- 1.27M keys occurring once each is not a distribution.
    expect(h.timings.keys()).toEqual(["GET /api/title/:tconst"]);
    expect(h.timings.get("GET /api/title/:tconst")?.n).toBe(2);
  });

  test("a method table is wrapped per method and the method is part of the key", () => {
    const h = harness();
    const routes = withTiming(
      { "/api/request": { GET: () => new Response("ok"), POST: () => new Response("ok") } },
      h.opts,
    );
    const table = routes["/api/request"] as Record<string, (r: Request) => unknown>;

    table.GET?.(req("http://x/api/request"));
    table.POST?.(req("http://x/api/request", "POST"));

    expect(h.timings.keys().sort()).toEqual(["GET /api/request", "POST /api/request"]);
  });

  test("under the threshold: timed, but nothing kept and nothing logged", () => {
    const h = harness(500);
    const routes = withTiming(
      {
        "/api/discover": () => {
          h.clock.advance(120);
          return new Response("ok");
        },
      },
      h.opts,
    );

    (routes["/api/discover"] as (r: Request) => unknown)(req("http://x/api/discover"));

    expect(h.timings.get("GET /api/discover")?.n).toBe(1);
    expect(h.slow.recent()).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  test("over the threshold: kept with the query string, and logged once", () => {
    const h = harness(500);
    const routes = withTiming(
      {
        "/api/browse": () => {
          h.clock.advance(3_657);
          return new Response("ok");
        },
      },
      h.opts,
    );

    (routes["/api/browse"] as (r: Request) => unknown)(req("http://x/api/browse?genre=Comedy"));

    const [kept] = h.slow.recent();
    expect(kept?.label).toBe("GET /api/browse");
    expect(kept?.ms).toBe(3_657);
    // The arguments are the whole point: "browse was slow" is not actionable, "?genre=Comedy
    // was slow" is.
    expect(kept?.detail).toBe("?genre=Comedy");
    expect(h.lines).toEqual(["slow: GET /api/browse?genre=Comedy took 3657ms"]);
  });

  test("an ASYNC handler is timed over the await, not over the call that returned a promise", async () => {
    const h = harness(500);
    const routes = withTiming(
      {
        "/api/browse": async () => {
          h.clock.advance(900);
          return new Response("ok");
        },
      },
      h.opts,
    );

    const out = await (routes["/api/browse"] as (r: Request) => Promise<Response>)(
      req("http://x/api/browse"),
    );

    expect(out.status).toBe(200);
    expect(h.slow.recent()[0]?.ms).toBe(900);
  });

  test("a SYNC handler is not turned into a promise", () => {
    const h = harness();
    const routes = withTiming({ "/api/discover": () => new Response("ok") }, h.opts);

    const out = (routes["/api/discover"] as (r: Request) => unknown)(req("http://x/api/discover"));

    expect(out).toBeInstanceOf(Response);
  });

  test("a handler that THROWS is still timed, and the error is re-thrown untouched", () => {
    const h = harness(500);
    const boom = new Error("boom");
    const routes = withTiming(
      {
        "/api/browse": () => {
          h.clock.advance(2_000);
          throw boom;
        },
      },
      h.opts,
    );

    expect(() => (routes["/api/browse"] as (r: Request) => unknown)(req("http://x/api/browse"))).toThrow(
      boom,
    );
    // Dropping a failed request would make the p95 of a broken route look healthy.
    expect(h.timings.get("GET /api/browse")?.n).toBe(1);
    expect(h.lines[0]).toContain("(threw)");
  });

  test("a REJECTED promise is timed and the rejection is preserved", async () => {
    const h = harness(500);
    const routes = withTiming(
      {
        "/api/browse": async () => {
          h.clock.advance(1_500);
          throw new Error("nope");
        },
      },
      h.opts,
    );

    await expect(
      (routes["/api/browse"] as (r: Request) => Promise<unknown>)(req("http://x/api/browse")),
    ).rejects.toThrow("nope");
    expect(h.timings.get("GET /api/browse")?.n).toBe(1);
    expect(h.lines[0]).toContain("(rejected)");
  });

  test("a slow NON-200 names its status, because that is a different problem", () => {
    const h = harness(500);
    const routes = withTiming(
      {
        "/api/browse": () => {
          h.clock.advance(800);
          return new Response("nope", { status: 503 });
        },
      },
      h.opts,
    );

    (routes["/api/browse"] as (r: Request) => unknown)(req("http://x/api/browse"));

    expect(h.lines[0]).toContain("(503)");
  });

  // REGRESSION: `typeof new Response() === "object"`, so before `wrapRoutes` existed all
  // three wrappers dropped a static route into the method-table branch and replaced it with
  // `{}` -- a route that answers nothing, with no error anywhere.
  test("a static Response route value passes through untouched", () => {
    const h = harness();
    const asset = new Response("static");
    const routes = withTiming({ "/robots.txt": asset }, h.opts);

    expect(routes["/robots.txt"]).toBe(asset);
  });

  test("a method table mixing a handler and a static Response keeps both", () => {
    const h = harness();
    const asset = new Response("static");
    const routes = withTiming({ "/api/x": { GET: () => new Response("ok"), HEAD: asset } }, h.opts);
    const table = routes["/api/x"] as Record<string, unknown>;

    expect(table.HEAD).toBe(asset);
    expect(typeof table.GET).toBe("function");
    (table.GET as (r: Request) => unknown)(req("http://x/api/x"));
    expect(h.timings.get("GET /api/x")?.n).toBe(1);
  });

  test("every argument reaches the handler unchanged", () => {
    const h = harness();
    const seen: unknown[] = [];
    const routes = withTiming(
      {
        "/api/x": (...args: never[]) => {
          seen.push(...args);
          return new Response("ok");
        },
      },
      h.opts,
    );
    const r = req("http://x/api/x");
    const server = { id: "server" };

    (routes["/api/x"] as (a: Request, b: unknown) => unknown)(r, server);

    expect(seen).toEqual([r, server]);
  });

  test("an infinite threshold disables the slow log and keeps the distribution", () => {
    const h = harness(Number.POSITIVE_INFINITY);
    const routes = withTiming(
      {
        "/api/browse": () => {
          h.clock.advance(90_000);
          return new Response("ok");
        },
      },
      h.opts,
    );

    (routes["/api/browse"] as (r: Request) => unknown)(req("http://x/api/browse"));

    expect(h.slow.recent()).toEqual([]);
    expect(h.timings.get("GET /api/browse")?.n).toBe(1);
  });
});
