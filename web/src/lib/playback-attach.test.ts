/**
 * Two client-side rules of playback that no other test reached:
 *
 * - WHICH PATH attaches a playlist. iOS Safari has no MSE, so `Hls.isSupported()` is false there
 *   and the element's own HLS is the only way anything plays. A desktop browser with MSE must never
 *   take the native branch, because Chromium answers `"maybe"` to HLS it cannot play.
 * - THE VIEWER HANDLE on stop. Two viewers of one title share a session, and a DELETE without this
 *   viewer's handle is one the server may not honour against the other viewer.
 */

import { expect, mock, test } from "bun:test";
import { attachMode, stopPlayback } from "./playback-api";

test("no MSE picks the element's own HLS, and MSE is never second to it", () => {
  expect(attachMode(false, () => true)).toBe("native");
  expect(attachMode(false, () => false)).toBe("none");
  let probed = false;
  expect(
    attachMode(true, () => {
      probed = true;
      return true;
    }),
  ).toBe("mse");
  expect(probed).toBe(false);
});

test("closing the player hands the server this viewer's handle, so it cannot end a shared session", () => {
  const calls: { url: string; method?: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    stopPlayback("s 1", "0b8f3c2e-1d4a-4e6b-9c1f-2a3b4c5d6e7f");
    stopPlayback("s2");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(calls).toEqual([
    { url: "/api/play/s/s%201?viewer=0b8f3c2e-1d4a-4e6b-9c1f-2a3b4c5d6e7f", method: "DELETE" },
    { url: "/api/play/s/s2", method: "DELETE" },
  ]);
});
