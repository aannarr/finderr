/**
 * Choosing an address, and changing our mind about it.
 *
 * Both halves are pure and both are injected, which is the point of the split: the race takes
 * its probe and its clock as arguments, so "a candidate that hangs forever" is a literal here
 * rather than a ten-second test.
 */

import { describe, expect, test } from "bun:test";
import { EndpointRing, electEndpoint, streamUrl } from "./stream-endpoints";

const LAN = "http://10.0.0.5:7979";
const WAN = "https://finderr.example";
const PAGE = "https://page.example";
const PLAYLIST = "/api/play/s/sess-1/index.m3u8";

/** A sleep that resolves immediately, so a staggered race runs in the same tick as its test. */
const noWait = () => Promise.resolve();

describe("racing the candidates", () => {
  test("the first that answers wins", async () => {
    const winner = await electEndpoint([LAN, WAN], async (base) => base === WAN, { sleep: noWait });
    expect(winner).toBe(WAN);
  });

  /**
   * THE WHOLE REASON THE RACE EXISTS. An unroutable private address does not fail, it HANGS
   * until a SYN timeout -- so a strictly ordered walk would stall the player for ten seconds
   * before trying the address that works. Here the LAN probe never settles at all.
   */
  test("a candidate that never answers does not hold up the one that does", async () => {
    const winner = await electEndpoint(
      [LAN, WAN],
      (base) => (base === LAN ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
      { sleep: noWait },
    );
    expect(winner).toBe(WAN);
  });

  test("null when nothing answers, so the caller can fall back to the page's origin", async () => {
    expect(await electEndpoint([LAN, WAN], async () => false, { sleep: noWait })).toBeNull();
  });

  test("no candidates is null rather than a wait", async () => {
    expect(await electEndpoint([], async () => true, { sleep: noWait })).toBeNull();
  });

  test("a probe that throws is a loss rather than an error out of the race", async () => {
    const winner = await electEndpoint(
      [LAN, WAN],
      async (base) => {
        if (base === LAN) throw new Error("DNS is on fire");
        return true;
      },
      { sleep: noWait },
    );
    expect(winner).toBe(WAN);
  });

  /** The losers are aborted, which is what keeps the race's cost to "one extra playlist". */
  test("the signal is aborted once there is a winner", async () => {
    const signals: AbortSignal[] = [];
    await electEndpoint(
      [LAN, WAN],
      async (base, signal) => {
        signals.push(signal);
        return base === LAN;
      },
      { sleep: noWait },
    );
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  /** A healthy first candidate should win before the second is even asked. */
  test("the stagger delays every candidate but the first", async () => {
    const waits: number[] = [];
    await electEndpoint([LAN, WAN], async () => true, {
      staggerMs: 250,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([250]);
  });
});

describe("the ring decides where the next request goes", () => {
  test("the head is the current choice, and pinning moves one there", () => {
    const ring = new EndpointRing([LAN, WAN]);
    expect(ring.current()).toBe(LAN);
    ring.pin(WAN);
    expect(ring.current()).toBe(WAN);
    expect(ring.candidates()).toEqual([WAN, LAN]);
  });

  /** The list is the server's statement of where this session lives; a client cannot add to it. */
  test("pinning something that was never advertised changes nothing", () => {
    const ring = new EndpointRing([LAN]);
    ring.pin("https://somewhere.else");
    expect(ring.candidates()).toEqual([LAN]);
  });

  test("a demoted candidate goes to the back, so the next request goes elsewhere", () => {
    const ring = new EndpointRing([LAN, WAN]);
    ring.demote(LAN);
    expect(ring.current()).toBe(WAN);
    expect(ring.candidates()).toEqual([WAN, LAN]);
  });

  /**
   * Several segments are in flight at once, so ONE dead path produces SEVERAL errors --
   * acting on each would advance the ring several places for a single fault and land on the
   * worst route available.
   */
  test("demoting a candidate that is no longer current is ignored", () => {
    const ring = new EndpointRing([LAN, WAN, PAGE]);
    ring.demote(LAN);
    ring.demote(LAN);
    expect(ring.candidates()).toEqual([WAN, PAGE, LAN]);
  });

  /** Paths come back -- a wifi handover, a VPN reconnect -- so nothing is struck off for good. */
  test("the only candidate is never demoted away from", () => {
    const ring = new EndpointRing([LAN]);
    ring.demote(LAN);
    expect(ring.current()).toBe(LAN);
  });

  test("an empty ring means the page's own origin", () => {
    expect(new EndpointRing([]).current()).toBeNull();
  });
});

describe("retargeting a URL at the current candidate", () => {
  test("a relative segment name becomes an absolute URL with the token", () => {
    const ring = new EndpointRing([LAN], "tok");
    expect(ring.retarget(PLAYLIST, PAGE)).toBe(`${LAN}${PLAYLIST}?t=tok`);
  });

  /**
   * IDEMPOTENT, AND IT HAS TO BE. hls.js retries by calling its loader again with the URL the
   * previous attempt already rewrote -- so a second pass over its own output must produce the
   * same answer, and after a demotion must produce the NEW candidate rather than stacking a
   * second token onto the old one.
   */
  test("retargeting its own output again is stable, and follows a demotion", () => {
    const ring = new EndpointRing([LAN, WAN], "tok");
    const first = ring.retarget(PLAYLIST, PAGE);
    expect(ring.retarget(first, PAGE)).toBe(first);

    ring.demote(LAN);
    expect(ring.retarget(first, PAGE)).toBe(`${WAN}${PLAYLIST}?t=tok`);
  });

  /**
   * EVERY SEGMENT KIND, by construction. The rule is the path prefix rather than a list of
   * file names, so the master, both rendition playlists, the init segments, the media
   * segments and the WebVTT subtitle segments are all covered -- and so is whatever a later
   * rendition adds.
   */
  test.each([
    "/api/play/s/sess-1/index.m3u8",
    "/api/play/s/sess-1/video.m3u8",
    "/api/play/s/sess-1/audio.m3u8",
    "/api/play/s/sess-1/subtitles.m3u8",
    "/api/play/s/sess-1/vinit00000.mp4",
    "/api/play/s/sess-1/vseg00042.m4s",
    "/api/play/s/sess-1/tseg00042.vtt",
  ])("%s is retargeted", (path) => {
    expect(new EndpointRing([LAN], "tok").retarget(path, PAGE)).toBe(`${LAN}${path}?t=tok`);
  });

  /** The loader this serves is a general hls.js loader; it must stay correct for anything else. */
  test("a URL that is not a playback path is left alone", () => {
    const ring = new EndpointRing([LAN], "tok");
    expect(ring.retarget("/api/health", PAGE)).toBe("/api/health");
    expect(ring.retarget("https://cdn.example/thing.mp4", PAGE)).toBe("https://cdn.example/thing.mp4");
  });

  test("with no candidates it stays on the page's origin, still carrying the token", () => {
    expect(new EndpointRing([], "tok").retarget(PLAYLIST, PAGE)).toBe(`${PAGE}${PLAYLIST}?t=tok`);
  });

  test("with no token nothing is appended, which is what an older server gets", () => {
    expect(new EndpointRing([LAN]).retarget(PLAYLIST, PAGE)).toBe(`${LAN}${PLAYLIST}`);
  });

  /** The token is renewed mid-film; every request after the swap must carry the new one. */
  test("a renewed token is used from the next request on", () => {
    const ring = new EndpointRing([LAN], "old");
    ring.setToken("new");
    expect(ring.retarget(PLAYLIST, PAGE)).toBe(`${LAN}${PLAYLIST}?t=new`);
  });
});

/**
 * ONE OWNER FOR THE URL SHAPE. The race probe and the loader must build the same URL, or the
 * race elects an address that fails on its first real request.
 */
describe("building a stream URL", () => {
  test("the ring and a direct call agree", () => {
    expect(new EndpointRing([LAN], "tok").retarget(PLAYLIST, PAGE)).toBe(streamUrl(LAN, PLAYLIST, "tok"));
  });
});
