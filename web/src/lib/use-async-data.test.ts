/**
 * The load-refuse-reload cycle, driven rather than described.
 *
 * A hook is nothing but effects and state transitions, so there is no resting markup to
 * assert and the static idiom cannot reach it at all -- see `web/src/test/interact.ts`. The
 * two rules worth pinning are the ones a reader would otherwise have to take on trust from a
 * comment: `act` RELOADS after a change that landed, and deliberately does NOT after one the
 * server refused, because a reload there would overwrite the refusal with `null` on its way
 * to re-drawing rows that never changed.
 *
 * EVERY `load` HERE IS BUILT OUTSIDE THE RENDER CALLBACK, and that is the hook's stated
 * contract rather than tidiness: `load`'s identity is what decides when the effect runs
 * again, so an arrow written inline in `renderHook(() => useAsyncData(async () => ...))` is a
 * new function on every render and fetches forever. The first draft of this file did exactly
 * that and the loop was only visible as a test that failed on an attempt counter it had
 * already raced past. `when the loader changes` is what pins the rule.
 *
 * `.ts` rather than `.tsx`: `renderHook` needs no JSX.
 */

import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "../test/interact";
import { useAsyncData } from "./use-async-data";

/**
 * Call one of the hook's own methods and let the renders it causes finish.
 *
 * React's `act` and this hook's `act` are unrelated things that share a name -- one flushes
 * renders, the other runs a mutation. Calling the hook's directly leaves its state updates
 * outside React's, which React reports as a warning on every one of them; wrapping it here
 * once means no test has to spell the distinction out, and none of them can forget.
 */
async function settled(work: () => Promise<void>): Promise<void> {
  await act(work);
}

/** A stable `load` that reports what it returned and how many times it was asked. */
function countingLoader(): { load: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    load: async () => `load ${++calls}`,
    calls: () => calls,
  };
}

describe("the first load", () => {
  test("data arrives without anything asking for it", async () => {
    const load = async () => "the rows";
    const { result } = renderHook(() => useAsyncData(load));

    // Null until it lands -- the caller's loading state depends on that being true first.
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toBe("the rows"));
    expect(result.current.error).toBeNull();
  });

  test("a refusal is kept verbatim, because on these screens it is the answer", async () => {
    const load = async (): Promise<string> => {
      throw new Error("that is the last admin");
    };
    const { result } = renderHook(() => useAsyncData(load));

    await waitFor(() => expect(result.current.error).toBe("that is the last admin"));
    expect(result.current.data).toBeNull();
  });

  test("reloading after a failure clears the refusal", async () => {
    let attempt = 0;
    const load = async () => {
      if (++attempt === 1) throw new Error("upstream is down");
      return "the rows";
    };
    const { result } = renderHook(() => useAsyncData(load));
    await waitFor(() => expect(result.current.error).toBe("upstream is down"));

    await settled(() => result.current.reload());

    await waitFor(() => expect(result.current.data).toBe("the rows"));
    expect(result.current.error).toBeNull();
  });
});

describe("changing the server", () => {
  /**
   * THE PAIRING IS THE POINT. A page that mutated without reloading goes on drawing the
   * state it had before, which on an admin screen reads as the action having failed.
   */
  test("a change that lands is followed by a reload", async () => {
    const loader = countingLoader();
    const { result } = renderHook(() => useAsyncData(loader.load));
    await waitFor(() => expect(result.current.data).toBe("load 1"));

    await settled(() => result.current.act(async () => {}));

    await waitFor(() => expect(result.current.data).toBe("load 2"));
    expect(loader.calls()).toBe(2);
  });

  test("a change the server refused is shown, and is NOT followed by a reload", async () => {
    const loader = countingLoader();
    const { result } = renderHook(() => useAsyncData(loader.load));
    await waitFor(() => expect(result.current.data).toBe("load 1"));

    await settled(() =>
      result.current.act(async () => {
        throw new Error("that is the last admin");
      }),
    );

    await waitFor(() => expect(result.current.error).toBe("that is the last admin"));
    // One call, so the refusal is still on screen and the rows under it are the ones the
    // server still holds.
    expect(loader.calls()).toBe(1);
    expect(result.current.data).toBe("load 1");
  });

  test("a fresh attempt clears the previous refusal before it starts", async () => {
    const loader = countingLoader();
    const { result } = renderHook(() => useAsyncData(loader.load));
    await waitFor(() => expect(result.current.data).toBe("load 1"));
    await settled(() =>
      result.current.act(async () => {
        throw new Error("that is the last admin");
      }),
    );
    await waitFor(() => expect(result.current.error).toBe("that is the last admin"));

    await settled(() => result.current.act(async () => {}));

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.data).toBe("load 2");
  });
});

/**
 * The identity of `load` is what decides when the effect runs again -- the user page passes
 * `useCallback(() => getAdminUser(id), [id])`, so navigating from one person to another has
 * to refetch. A loader that did not change must NOT, or every render would hit the server.
 */
describe("when the loader changes", () => {
  test("a new loader refetches, and an unchanged one does not", async () => {
    const loader = countingLoader();
    const { result, rerender } = renderHook(({ load }) => useAsyncData(load), {
      initialProps: { load: loader.load },
    });
    await waitFor(() => expect(result.current.data).toBe("load 1"));

    rerender({ load: loader.load });
    expect(loader.calls()).toBe(1);

    rerender({ load: async () => "somebody else" });

    await waitFor(() => expect(result.current.data).toBe("somebody else"));
  });
});
