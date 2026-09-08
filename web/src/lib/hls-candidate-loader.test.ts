/**
 * The hls.js shim, against a stub base loader.
 *
 * Two properties, and the second is the one that would be a bug nobody could see: every
 * request is retargeted at the current candidate, and **a 404 does not rotate the ring**. Our
 * segment route answers 404 for a segment ffmpeg has not made yet, which is ordinary
 * back-pressure on a healthy connection -- treating it as a dead path would walk a busy
 * server's viewers onto their worst route while nothing was ever wrong with the first.
 */

import { describe, expect, test } from "bun:test";
import type { LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";
import { candidateLoader, type LoaderConstructor } from "./hls-candidate-loader";
import { EndpointRing } from "./stream-endpoints";

const LAN = "http://10.0.0.5:7979";
const WAN = "https://finderr.example";
const PAGE = "https://page.example";
const SEGMENT = "/api/play/s/sess-1/vseg00007.m4s";

/** The URLs the base loader was actually asked for, in order. */
const asked: string[] = [];

/**
 * Enough of a loader for the shim to extend.
 *
 * It records the URL and keeps the callbacks so a test can fire one, which is the whole of
 * what the shim interacts with -- the stats, the chunking and the timeouts it delegates
 * untouched, and a stub that pretended to implement them would be asserting on itself.
 */
const StubLoader = class {
  context: LoaderContext | null = null;
  stats = {} as never;
  callbacks: LoaderCallbacks<LoaderContext> | null = null;
  load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    this.context = context;
    this.callbacks = callbacks;
    asked.push(context.url);
  }
  abort() {}
  destroy() {}
} as unknown as LoaderConstructor;

const NOTHING = {} as LoaderConfiguration;
const CALLBACKS = {
  onSuccess: () => {},
  onError: () => {},
  onTimeout: () => {},
} as unknown as LoaderCallbacks<LoaderContext>;

/** Load one URL through the shim and hand back the loader, so a test can fire its callbacks. */
function loadOnce(ring: EndpointRing, url = SEGMENT) {
  const Loader = candidateLoader(StubLoader, ring, PAGE);
  const loader = new Loader({} as never) as unknown as {
    callbacks: LoaderCallbacks<LoaderContext>;
    load: (c: LoaderContext, k: LoaderConfiguration, cb: LoaderCallbacks<LoaderContext>) => void;
  };
  loader.load({ url } as LoaderContext, NOTHING, CALLBACKS);
  return loader;
}

describe("every request goes to the current candidate", () => {
  test("a relative segment name is fetched from the ring's head, with the token", () => {
    asked.length = 0;
    loadOnce(new EndpointRing([LAN, WAN], "tok"));
    expect(asked).toEqual([`${LAN}${SEGMENT}?t=tok`]);
  });

  test("with no candidates it is the page's own origin, which is how it behaved before", () => {
    asked.length = 0;
    loadOnce(new EndpointRing([]));
    expect(asked).toEqual([`${PAGE}${SEGMENT}`]);
  });
});

describe("what counts as a dead path", () => {
  /**
   * THE BACK-PRESSURE CASE. `/api/play/s/:id/:file` answers 404 for a segment that is still
   * being produced, and hls.js retries those by design. Rotating the ring here would be a
   * failover triggered by the server working correctly.
   */
  test("a 404 does not demote -- the segment is not ready, the path is fine", () => {
    const ring = new EndpointRing([LAN, WAN], "tok");
    loadOnce(ring).callbacks.onError(
      { code: 404, text: "not ready" },
      {} as LoaderContext,
      null,
      {} as never,
    );
    expect(ring.current()).toBe(LAN);
  });

  test("a transport failure demotes, so the retry lands somewhere else", () => {
    const ring = new EndpointRing([LAN, WAN], "tok");
    // Code 0 is what a browser reports for a connection that never happened, and for a
    // cross-origin response it was not allowed to read.
    loadOnce(ring).callbacks.onError({ code: 0, text: "" }, {} as LoaderContext, null, {} as never);
    expect(ring.current()).toBe(WAN);
  });

  test("a server error demotes too", () => {
    const ring = new EndpointRing([LAN, WAN], "tok");
    loadOnce(ring).callbacks.onError({ code: 502, text: "" }, {} as LoaderContext, null, {} as never);
    expect(ring.current()).toBe(WAN);
  });

  /** A timeout is always the path: the request reached nothing, or nothing that answered. */
  test("a timeout demotes", () => {
    const ring = new EndpointRing([LAN, WAN], "tok");
    loadOnce(ring).callbacks.onTimeout({} as never, {} as LoaderContext, null);
    expect(ring.current()).toBe(WAN);
  });

  /**
   * THE FAILOVER, END TO END: one dead segment costs a retry rather than the session. The
   * second load is the one hls.js's own retry machinery issues, and it is handed the URL the
   * first attempt rewrote -- which is exactly why `retarget` is idempotent.
   */
  test("the retry after a failure is fetched from the next candidate", () => {
    asked.length = 0;
    const ring = new EndpointRing([LAN, WAN], "tok");
    loadOnce(ring).callbacks.onTimeout({} as never, {} as LoaderContext, null);
    loadOnce(ring, asked[0]);

    expect(asked).toEqual([`${LAN}${SEGMENT}?t=tok`, `${WAN}${SEGMENT}?t=tok`]);
  });

  /** The caller's own handlers must still run -- the shim observes, it does not swallow. */
  test("the original callbacks are still called", () => {
    const seen: number[] = [];
    const ring = new EndpointRing([LAN, WAN], "tok");
    const Loader = candidateLoader(StubLoader, ring, PAGE);
    const loader = new Loader({} as never) as unknown as {
      callbacks: LoaderCallbacks<LoaderContext>;
      load: (c: LoaderContext, k: LoaderConfiguration, cb: LoaderCallbacks<LoaderContext>) => void;
    };
    loader.load({ url: SEGMENT } as LoaderContext, NOTHING, {
      ...CALLBACKS,
      onError: (e: { code: number }) => seen.push(e.code),
    } as unknown as LoaderCallbacks<LoaderContext>);
    loader.callbacks.onError({ code: 404, text: "" }, {} as LoaderContext, null, {} as never);

    expect(seen).toEqual([404]);
  });
});
