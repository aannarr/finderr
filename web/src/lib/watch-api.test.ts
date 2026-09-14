/**
 * The watch client against a stubbed `fetch` and `sendBeacon`: what each call sends, and that no
 * failure -- a refusal, a thrown fetch, a body of the wrong shape -- escapes as an exception.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { isFinished as serverIsFinished } from "../../../src/lib/watch-progress";
import {
  beaconWatch,
  deleteWatch,
  getHistory,
  getWatch,
  isFinished,
  putWatch,
  type WatchEntry,
} from "./watch-api";

const realFetch = globalThis.fetch;
const realBeacon = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");

interface Sent {
  url: string;
  init: RequestInit | undefined;
}
let sent: Sent[];

function stubFetch(answer: () => Response | Promise<Response>): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return answer();
  }) as unknown as typeof fetch;
}

function stubBeacon(impl: ((url: string, data: Blob) => boolean) | undefined): void {
  Object.defineProperty(navigator, "sendBeacon", { value: impl, configurable: true, writable: true });
}

const ENTRY: WatchEntry = {
  tconst: "tt0944947",
  season: 1,
  episode: 2,
  positionSec: 120,
  durationSec: 3000,
  finished: false,
  updatedAt: "2026-09-15T10:00:00.000Z",
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBeacon) Object.defineProperty(navigator, "sendBeacon", realBeacon);
  else stubBeacon(undefined);
});

test("isFinished is the server's own function, not a copy", () => {
  expect(isFinished).toBe(serverIsFinished);
});

describe("getWatch", () => {
  test("reads the title's state", async () => {
    stubFetch(() => ok({ resume: ENTRY, episodes: [ENTRY] }));
    expect(await getWatch("tt0944947")).toEqual({ resume: ENTRY, episodes: [ENTRY] });
    expect(sent[0].url).toBe("/api/watch/tt0944947");
  });

  test("null on a refusal, a thrown fetch, or a body of the wrong shape", async () => {
    stubFetch(() => new Response("{}", { status: 400 }));
    expect(await getWatch("tt1")).toBeNull();
    stubFetch(() => {
      throw new TypeError("offline");
    });
    expect(await getWatch("tt1")).toBeNull();
    stubFetch(() => ok({ resume: { nope: true }, episodes: [] }));
    expect(await getWatch("tt1")).toBeNull();
    stubFetch(() => new Response("<html>", { status: 200 }));
    expect(await getWatch("tt1")).toBeNull();
  });
});

describe("putWatch", () => {
  test("PUTs JSON and returns the stored entry", async () => {
    stubFetch(() => ok(ENTRY));
    const body = { season: 1, episode: 2, positionSec: 120, durationSec: 3000 };
    expect(await putWatch("tt0944947", body)).toEqual(ENTRY);
    expect(sent[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(sent[0].init?.body))).toEqual(body);
  });

  test("null for a caller with nobody to store it for (204), and on failure", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    expect(await putWatch("tt1", { positionSec: 1, durationSec: 2 })).toBeNull();
    stubFetch(() => {
      throw new TypeError("offline");
    });
    expect(await putWatch("tt1", { positionSec: 1, durationSec: 2 })).toBeNull();
  });
});

describe("beaconWatch", () => {
  test("sends a text/plain JSON blob by beacon when the browser queues it", async () => {
    let got: { url: string; data: Blob } | null = null;
    stubBeacon((url, data) => {
      got = { url, data };
      return true;
    });
    stubFetch(() => ok({}));
    const body = { positionSec: 99, durationSec: 5400 };
    expect(beaconWatch("tt0092494", body)).toBe(true);
    const beacon = got as unknown as { url: string; data: Blob };
    expect(beacon.url).toBe("/api/watch/tt0092494");
    expect(beacon.data.type).toStartWith("text/plain");
    expect(JSON.parse(await beacon.data.text())).toEqual(body);
    expect(sent).toHaveLength(0);
  });

  test("falls back to a keepalive POST when the beacon declines, throws or is missing", () => {
    const body = { positionSec: 1, durationSec: 2 };
    for (const beacon of [
      () => false,
      () => {
        throw new Error("no");
      },
      undefined,
    ]) {
      sent = [];
      stubBeacon(beacon);
      stubFetch(() => ok({}));
      expect(beaconWatch("tt0092494", body)).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0].init).toMatchObject({ method: "POST", keepalive: true });
      expect(JSON.parse(String(sent[0].init?.body))).toEqual(body);
    }
  });
});

describe("deleteWatch", () => {
  test("the whole title, or one episode by query", async () => {
    stubFetch(() => ok({ removed: 1 }));
    expect(await deleteWatch("tt0944947")).toBe(true);
    expect(await deleteWatch("tt0944947", { season: 0, episode: 3 })).toBe(true);
    expect(sent.map((s) => [s.init?.method, s.url])).toEqual([
      ["DELETE", "/api/watch/tt0944947"],
      ["DELETE", "/api/watch/tt0944947?season=0&episode=3"],
    ]);
    stubFetch(() => new Response("{}", { status: 400 }));
    expect(await deleteWatch("tt1")).toBe(false);
  });
});

describe("getHistory", () => {
  test("passes paging and checks the shape", async () => {
    stubFetch(() => ok({ entries: [ENTRY], hasMore: true }));
    expect(await getHistory({ limit: 20, offset: 40 })).toEqual({ entries: [ENTRY], hasMore: true });
    expect(sent[0].url).toBe("/api/watch/history?limit=20&offset=40");
    await getHistory();
    expect(sent[1].url).toBe("/api/watch/history");
    stubFetch(() => ok({ entries: [{ broken: 1 }], hasMore: false }));
    expect(await getHistory()).toBeNull();
  });
});
