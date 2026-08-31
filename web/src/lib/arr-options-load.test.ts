/**
 * The one-shot loader behind the Request settings panel.
 *
 * These are the four properties that decide whether the panel ever leaves "Asking Sonarr…",
 * and every one of them is about SEQUENCING rather than about data -- which is why they are
 * tested here, against a deferred promise and a plain array of states, instead of through a
 * component. `react-dom/server` does not run effects, so a rendered assertion could not
 * have caught any of this.
 */

import { describe, expect, test } from "bun:test";
import type { ArrOptions } from "./api";
import { type ArrOptionsPayload, makeArrOptionsLoader, type OptionsState } from "./arr-options-load";

const SONARR: ArrOptions = {
  qualityProfiles: [{ id: 4, name: "HD-1080p" }],
  rootFolders: [{ path: "/tv", freeSpace: 2e12 }],
};

const PAYLOAD: ArrOptionsPayload = { radarr: null, sonarr: SONARR };

/** A promise somebody else resolves, so a test can look at the world mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const states: OptionsState[] = [];
  const calls: Array<ReturnType<typeof deferred<ArrOptionsPayload>>> = [];
  const loader = makeArrOptionsLoader(
    () => {
      const d = deferred<ArrOptionsPayload>();
      calls.push(d);
      return d.promise;
    },
    (s) => states.push(s),
  );
  return { states, calls, loader };
}

/** Let the loader's own `.then`/`.catch` run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("makeArrOptionsLoader", () => {
  test("a re-render while the fetch is in flight does not cancel it", async () => {
    // THE REGRESSION. The effect used to list `state.phase` as a dependency and latch a
    // `cancelled` flag in its cleanup, so its own `setState({phase:"loading"})` fired the
    // cleanup on the very next render -- before any response could land. Repeated `start()`
    // calls are what a re-render looks like from here.
    const { states, calls, loader } = harness();

    loader.start();
    loader.start();
    loader.start();
    calls[0].resolve(PAYLOAD);
    await settle();

    expect(states.map((s) => s.phase)).toEqual(["loading", "ready"]);
    expect(states[1]).toEqual({ phase: "ready", options: PAYLOAD });
  });

  test("asks once however many times it is started", async () => {
    // The panel fetches on FIRST OPEN, and opening it a second time must not put another
    // call on Radarr and Sonarr -- this is the one route in the tree that leaves the box.
    const { calls, loader } = harness();

    loader.start();
    calls[0].resolve(PAYLOAD);
    await settle();
    loader.start();

    expect(calls).toHaveLength(1);
  });

  test("dispose drops a response that arrives after the view is gone", async () => {
    const { states, calls, loader } = harness();

    loader.start();
    loader.dispose();
    calls[0].resolve(PAYLOAD);
    await settle();

    expect(states.map((s) => s.phase)).toEqual(["loading"]);
  });

  test("a refusal lands as an error rather than a permanent skeleton", async () => {
    // A 404 is what an ordinary user gets from `/api/arr/options`, and a stuck "Asking
    // Sonarr…" is a worse answer than saying the defaults will be used.
    const { states, calls, loader } = harness();

    loader.start();
    calls[0].reject(new Error("arr options failed: 404"));
    await settle();

    expect(states[1]).toEqual({ phase: "error", message: "arr options failed: 404" });
  });

  test("a fetcher that throws synchronously is an error, not an unhandled rejection", async () => {
    const states: OptionsState[] = [];
    const loader = makeArrOptionsLoader(
      () => {
        throw new Error("nope");
      },
      (s) => states.push(s),
    );

    loader.start();
    await settle();

    expect(states.map((s) => s.phase)).toEqual(["loading", "error"]);
  });
});
