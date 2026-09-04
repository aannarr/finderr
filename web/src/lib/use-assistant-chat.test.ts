/**
 * The two pure rules the chat hook owns: bubble identity, and what a refusal reads as.
 *
 * The hook itself needs React and a clock and is exercised in the browser; these are the
 * parts that can be wrong silently, and one of them already was.
 */

import { describe, expect, test } from "bun:test";
import { idsFrom, refusalText } from "./use-assistant-chat";

describe("bubble ids", () => {
  test("are unique within one page load", () => {
    const next = idsFrom();
    const ids = Array.from({ length: 200 }, next);
    expect(new Set(ids).size).toBe(200);
  });

  /**
   * THE REGRESSION. A module-level counter restarts at 1 on every page load while the
   * conversation does not -- it is restored from `localStorage`. The first new bubble then
   * carried a restored bubble's id, and `send`'s replace-by-id rewrote both: an answer the
   * reader had already read turned into the next turn's error.
   *
   * Two factories stand in for two page loads, which is the only way one process can see a
   * bug whose whole shape is "the second load reuses the first load's names".
   */
  test("from two page loads never collide", () => {
    const first = new Set(Array.from({ length: 50 }, idsFrom()));
    const second = new Set(Array.from({ length: 50 }, idsFrom()));
    for (const id of second) expect(first.has(id)).toBe(false);
  });
});

describe("what a refusal reads as", () => {
  /** The server knows why; a sentence invented here would be a second, worse copy of it. */
  test("prefers the server's own message", () => {
    expect(refusalText({ kind: "rate-limited", message: "Slow down." })).toBe("Slow down.");
    expect(refusalText({ kind: "forbidden", message: "Admins only." })).toBe("Admins only.");
  });

  /** 404 has no body to quote, so this is the one case with words of its own. */
  test("an absent assistant gets a sentence from here, because 404 carries none", () => {
    expect(refusalText({ kind: "absent" })).toContain("not set up");
  });

  test("a budget refusal with an empty message still says something", () => {
    expect(refusalText({ kind: "over-limit", message: "", remainingUsd: 0, retryAfterSeconds: 0 })).toContain(
      "budget",
    );
  });
});
