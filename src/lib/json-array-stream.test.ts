/**
 * The streaming array reader, against bodies delivered in deliberately awkward pieces.
 *
 * Two claims are being pinned and they need different kinds of test. That it PARSES the same
 * things `JSON.parse` does is checked by chopping one body into every chunk size from 1 byte
 * upwards -- an element boundary that lands mid-string, mid-escape or mid-number is the whole
 * risk of an incremental scanner, and a fixed chunk size only ever exercises one of them. That
 * it is BOUNDED is checked by watching the buffer through a body far larger than any element
 * in it, because "we stream" is otherwise an assertion about code nobody re-reads.
 */

import { describe, expect, test } from "bun:test";
import { streamJsonArray, streamResponseArray } from "./json-array-stream";

/** A body handed over `size` bytes at a time, so an element can straddle a chunk. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function collect<T>(text: string, size: number): Promise<T[]> {
  const out: T[] = [];
  for await (const el of streamJsonArray<T>(chunked(text, size))) out.push(el);
  return out;
}

describe("streamJsonArray agrees with JSON.parse, at every chunk boundary", () => {
  /**
   * Everything an arr has been seen to put in a list, in one array: nested objects and arrays,
   * an escaped quote and an escaped backslash, a bracket INSIDE a string (the character that
   * breaks a naive depth counter), unicode, the three literals, a negative exponent, and empty
   * containers.
   */
  const AWKWARD = JSON.stringify([
    { id: 1, title: 'He said "]" and left', images: [{ coverType: "poster", url: "http://x/a.jpg" }] },
    { id: 2, title: "back\\slash", nested: { deep: { deeper: [1, 2, { done: true }] } } },
    { id: 3, title: "café — ünïcode", ratings: {}, tags: [] },
    null,
    true,
    false,
    -1.25e-7,
    "a bare string, with a { and a [",
    [1, [2, [3]]],
  ]);

  test("every chunk size from 1 byte to the whole body yields the same elements", async () => {
    const expected = JSON.parse(AWKWARD) as unknown[];
    for (let size = 1; size <= AWKWARD.length + 1; size++) {
      expect(await collect(AWKWARD, size)).toEqual(expected);
    }
  });

  test("whitespace between and inside elements is ignored", async () => {
    const pretty = JSON.stringify(JSON.parse(AWKWARD), null, 2);
    expect(await collect(pretty, 7)).toEqual(JSON.parse(AWKWARD) as unknown[]);
  });

  test("an empty array yields nothing and does not throw", async () => {
    expect(await collect("[]", 1)).toEqual([]);
    expect(await collect("  [ \n ] ", 3)).toEqual([]);
  });
});

describe("a body that is not a whole array is an ERROR, never a short list", () => {
  /*
    THIS IS THE ONE THAT MATTERS FOR THE MIRROR. Every caller replaces a table wholesale, so a
    truncated response that parsed as "your library has two films in it" would delete the other
    1,387. A throw reaches the caller before the store is touched, which is the behaviour a
    refused connection already has.
  */
  test("a truncated array throws rather than yielding what arrived", async () => {
    await expect(collect('[{"id":1},{"id":2},{"id":3', 4)).rejects.toThrow(/closing bracket/);
  });

  test("an empty body throws", async () => {
    await expect(collect("", 1)).rejects.toThrow(/no JSON array/);
  });

  test("a JSON object rather than an array throws before yielding anything", async () => {
    await expect(collect('{"MediaContainer":{}}', 5)).rejects.toThrow(/expected a JSON array/);
  });

  test("an HTML error page throws", async () => {
    await expect(collect("<!doctype html><html>...", 6)).rejects.toThrow(/expected a JSON array/);
  });
});

describe("the buffer stays bounded", () => {
  /**
   * The regression guard for the one line the whole exercise turns on -- `buf = buf.slice(...)`
   * after each element. Delete it and everything above still passes: the elements are still
   * right, they still arrive in order, and the only thing that changes is that the reader is
   * holding the entire body while it does it.
   *
   * So this measures the HEAP, over a body far larger than any element in it. The threshold is
   * deliberately loose -- a quarter of the body -- because the number it has to separate is not
   * close: bounded, the growth is a chunk and an element; accumulating, it is the whole body
   * plus its parsed elements. A tight bound here would buy nothing and would go flaky on
   * whenever the collector felt like running. `bench-mirror.ts` is where the real figure is
   * taken, against a real arr response.
   */
  test("consuming a 15 MB body does not grow the heap by 15 MB", async () => {
    const element = { title: "x".repeat(700), images: [{ url: "http://example.test/poster.jpg" }] };
    const body = JSON.stringify(Array.from({ length: 20_000 }, (_, id) => ({ ...element, id })));
    expect(body.length).toBeGreaterThan(15_000_000);

    const CHUNK = 64 * 1024;
    let at = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(body.slice(at, at + CHUNK)));
        at += CHUNK;
      },
    });

    Bun.gc(true);
    const baseline = process.memoryUsage().heapUsed;
    let peak = 0;
    let seen = 0;
    for await (const el of streamJsonArray<{ id: number }>(source)) {
      expect(el.id).toBe(seen);
      seen += 1;
      // Sampled rather than measured every element: `memoryUsage()` is not free, and the
      // shape being caught here is monotonic growth over thousands of elements.
      if (seen % 500 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
    }

    expect(seen).toBe(20_000);
    expect(peak).toBeLessThan(body.length / 4);
  });
});

describe("streamResponseArray", () => {
  test("reads the array off a Response body", async () => {
    const res = new Response('[{"id":1},{"id":2}]');
    const out: { id: number }[] = [];
    for await (const el of streamResponseArray<{ id: number }>(Promise.resolve(res))) out.push(el);
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("a rejected request surfaces from the first read, not from building the pipeline", async () => {
    const boom = Promise.reject(new Error("connection refused"));
    const it = streamResponseArray<unknown>(boom);
    await expect(it.next()).rejects.toThrow("connection refused");
  });

  test("a response with no body at all is an error, not an empty list", async () => {
    const it = streamResponseArray<unknown>(Promise.resolve(new Response(null, { status: 204 })));
    await expect(it.next()).rejects.toThrow(/no body/);
  });
});
