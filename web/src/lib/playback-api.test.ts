/**
 * `renewStreamToken`, driven against a fake clock and a stubbed `fetch`.
 *
 * The two defects this pins were both invisible to a single viewer and both only reachable
 * with multi-homing configured, because same-origin requests ride the session cookie and never
 * present the token at all. Starting a session JOINS a running one for the same title, so the
 * SECOND viewer is handed a token with only its remaining life -- possibly none:
 *
 *   1. a remaining life of zero scheduled NO renewal, so that viewer played on an expired
 *      token until hls.js gave up (a 401 is deliberately not `pathIsDead`, so the ring never
 *      rotated away from an endpoint that was working);
 *   2. the cadence was computed once from the START response, so a viewer joining at minute 14
 *      of somebody else's cycle renewed every thirty seconds for the rest of the film.
 *
 * The clock is injected, so a fifteen-minute cadence is asserted in elapsed milliseconds and
 * costs the suite nothing. What this CANNOT prove is the live shape -- two origins, a session
 * held open past thirty minutes, a browser that rotates candidates -- and that half is stated
 * as unproven on the card rather than implied here.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fakeTimers } from "../test/fake-timers";
import { type PlaybackSession, renewStreamToken } from "./playback-api";
import type { PlaybackPlan } from "./playback-types";
import { EndpointRing } from "./stream-endpoints";

const PAGE_ORIGIN = "https://finderr.example";
const OTHER_ORIGIN = "https://lan.example";
const SEGMENT = "/api/play/s/s1/0.m4s";

const MINUTE_MS = 60_000;
/** What the server actually issues -- `STREAM_TOKEN_TTL_MS` is 30 minutes. */
const FULL_TTL_SEC = 30 * 60;

/** Nothing here reads the plan; it is present because a session carries one. */
const COPY_PLAN: PlaybackPlan = {
  video: { action: "copy", sourceIndex: 0, codec: "h264" },
  audio: [{ action: "copy", sourceIndex: 1, codec: "aac", label: { name: "English", language: "eng" } }],
  subtitles: [],
  reasons: [],
};

const realFetch = globalThis.fetch;

/** Every `POST .../token` this test saw, and what each was answered with. */
let mints: string[];

/**
 * Answer each renewal with the next entry, repeating the last one forever.
 *
 * A queue rather than one fixed answer, because the whole point is that consecutive responses
 * carry DIFFERENT lives and the schedule has to follow them.
 */
function stubMints(answers: { status?: number; body?: unknown }[]): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const at = Math.min(mints.length, answers.length - 1);
    mints.push(String(input));
    const { status = 200, body = {} } = answers[at] ?? {};
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

/** Let the in-flight re-mint and its `.json()` settle; the fake clock does not await for us. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function sessionWith(fields: Partial<PlaybackSession>): PlaybackSession {
  return {
    sessionId: "s1",
    playlist: "/api/play/s/s1/master.m3u8",
    streamToken: "joined",
    durationSec: 7200,
    segments: 1200,
    plan: COPY_PLAN,
    ...fields,
  };
}

/** The token the ring is currently putting on the wire, read off a real retarget. */
function tokenOnTheWire(ring: EndpointRing): string | null {
  return new URL(ring.retarget(SEGMENT, PAGE_ORIGIN)).searchParams.get("t");
}

beforeEach(() => {
  mints = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a JOINED session whose token is already spent renews immediately", async () => {
  // The measured shape: `probe-start` against a joined session returned `streamTokenTtlSec: 0`
  // while the session was perfectly healthy. This used to schedule nothing at all.
  stubMints([{ body: { streamToken: "fresh", streamTokenTtlSec: FULL_TTL_SEC } }]);
  const clock = fakeTimers();
  const ring = new EndpointRing([OTHER_ORIGIN], "joined");

  renewStreamToken(sessionWith({ streamTokenTtlSec: 0 }), ring, clock.timers);
  clock.advance(0);
  await settle();

  expect(mints).toHaveLength(1);
  expect(mints[0]).toContain("/api/play/s/s1/token");
  expect(tokenOnTheWire(ring)).toBe("fresh");
});

test("the cadence follows each RESPONSE's life, not the one the session started with", async () => {
  // A viewer joining at minute 28 of somebody else's cycle starts on a 2-minute remainder and
  // renews at 1 minute -- but the token they get back is a full one, so the SECOND renewal is
  // fifteen minutes later rather than another minute.
  stubMints([{ body: { streamToken: "fresh", streamTokenTtlSec: FULL_TTL_SEC } }]);
  const clock = fakeTimers();
  const ring = new EndpointRing([OTHER_ORIGIN], "joined");

  renewStreamToken(sessionWith({ streamTokenTtlSec: 2 * 60 }), ring, clock.timers);

  clock.advance(MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(1);

  // The old interval would have fired here, and every minute after it, for the whole film.
  clock.advance(MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(1);

  clock.advance(14 * MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(2);
});

test("a full-life token renews at half of it, and keeps doing so", async () => {
  stubMints([{ body: { streamToken: "fresh", streamTokenTtlSec: FULL_TTL_SEC } }]);
  const clock = fakeTimers();
  const ring = new EndpointRing([OTHER_ORIGIN], "joined");

  renewStreamToken(sessionWith({ streamTokenTtlSec: FULL_TTL_SEC }), ring, clock.timers);

  clock.advance(15 * MINUTE_MS - 1);
  await settle();
  expect(mints).toHaveLength(0);

  clock.advance(1);
  await settle();
  expect(mints).toHaveLength(1);

  clock.advance(15 * MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(2);
});

test("a refused renewal is retried sooner, and never in a tight loop", async () => {
  // A 404 is a session the server has forgotten. The retry interval decays -- the assumed life
  // halves each time, because half of it is what was just waited out -- and stops decaying at
  // the floor, so a dead endpoint is asked twice a minute rather than thousands of times.
  stubMints([{ status: 404 }]);
  const clock = fakeTimers();
  const ring = new EndpointRing([OTHER_ORIGIN], "joined");

  renewStreamToken(sessionWith({ streamTokenTtlSec: 4 * 60 }), ring, clock.timers);

  clock.advance(2 * MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(1);

  clock.advance(MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(2);

  // Decayed to the 60s floor: every further attempt is 30s apart, not sooner.
  for (let i = 3; i <= 6; i++) {
    clock.advance(30_000 - 1);
    await settle();
    expect(mints).toHaveLength(i - 1);
    clock.advance(1);
    await settle();
    expect(mints).toHaveLength(i);
  }
  expect(tokenOnTheWire(ring)).toBe("joined");
});

test("a response with a token but no life keeps the token and decays the schedule", async () => {
  // A server that answers without a TTL is honoured for the token -- refusing it would throw
  // away a credential that works -- while the cadence falls back to the decay.
  stubMints([{ body: { streamToken: "fresh" } }]);
  const clock = fakeTimers();
  const ring = new EndpointRing([OTHER_ORIGIN], "joined");

  renewStreamToken(sessionWith({ streamTokenTtlSec: 4 * 60 }), ring, clock.timers);
  clock.advance(2 * MINUTE_MS);
  await settle();

  expect(tokenOnTheWire(ring)).toBe("fresh");
  clock.advance(MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(2);
});

test("a server that reports no life at all schedules nothing", async () => {
  // Older than this feature: it has no renewal endpoint either, so asking it is pure noise.
  // An ABSENT life is not the same claim as a life of zero, which is a live server saying the
  // token is spent.
  stubMints([{ body: { streamToken: "fresh", streamTokenTtlSec: FULL_TTL_SEC } }]);
  const clock = fakeTimers();

  renewStreamToken(sessionWith({ streamTokenTtlSec: undefined }), new EndpointRing([]), clock.timers);

  clock.advance(FULL_TTL_SEC * 1000);
  await settle();
  expect(mints).toHaveLength(0);
  expect(clock.scheduled).toBe(0);
});

test("a session with no token at all schedules nothing", async () => {
  stubMints([{ body: { streamToken: "fresh", streamTokenTtlSec: FULL_TTL_SEC } }]);
  const clock = fakeTimers();

  renewStreamToken(
    sessionWith({ streamToken: undefined, streamTokenTtlSec: 0 }),
    new EndpointRing([]),
    clock.timers,
  );

  clock.advance(FULL_TTL_SEC * 1000);
  await settle();
  expect(mints).toHaveLength(0);
});

test("cancelling leaves no timer behind and sends nothing more", async () => {
  stubMints([{ body: { streamToken: "fresh", streamTokenTtlSec: FULL_TTL_SEC } }]);
  const clock = fakeTimers();
  const ring = new EndpointRing([OTHER_ORIGIN], "joined");

  const stop = renewStreamToken(sessionWith({ streamTokenTtlSec: FULL_TTL_SEC }), ring, clock.timers);
  clock.advance(15 * MINUTE_MS);
  await settle();
  expect(mints).toHaveLength(1);

  stop();
  expect(clock.scheduled).toBe(0);
  clock.advance(FULL_TTL_SEC * 1000);
  await settle();
  expect(mints).toHaveLength(1);
});

test("cancelling while a renewal is in flight does not re-arm the chain", async () => {
  // The player unmounting mid-request is the ordinary case -- closing the tab during a
  // renewal. Re-arming there would leak one timer per session for the life of the page.
  stubMints([{ body: { streamToken: "fresh", streamTokenTtlSec: FULL_TTL_SEC } }]);
  const clock = fakeTimers();
  const ring = new EndpointRing([OTHER_ORIGIN], "joined");

  const stop = renewStreamToken(sessionWith({ streamTokenTtlSec: 2 * 60 }), ring, clock.timers);
  clock.advance(MINUTE_MS);
  stop(); // the fetch is out, its answer has not landed yet
  await settle();

  expect(clock.scheduled).toBe(0);
  clock.advance(FULL_TTL_SEC * 1000);
  await settle();
  expect(mints).toHaveLength(1);
});
