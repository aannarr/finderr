/**
 * `/admin/playback` as a whole page, driven against a stubbed `fetch`.
 *
 * What only this file can prove is the WIRING and the REFUSALS: that the page reads the admin
 * endpoint rather than the player's session list, that a body of the wrong shape is a sentence
 * rather than a thrown render, and that an idle server gets an empty state instead of a flat
 * line implying a measurement.
 *
 * `fetch` is replaced rather than the API module mocked, so the path the client actually sends
 * is what is asserted. Same idiom, and same reasons, as `AdminAddonsRoute.test.tsx`.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { PlaybackCostReport } from "../lib/playback-cost-api";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { inRouter } from "../test/render-in-router";
import { AdminPlaybackRoute } from "./AdminPlaybackRoute";

/** The session rows link to a title, and a `<Link>` with no router in context throws. */
const routed = () => inRouter(<AdminPlaybackRoute />, ["/title/$tconst"]);

const realFetch = globalThis.fetch;
let paths: string[];

function stubFetch(answer: () => { status?: number; body: unknown }): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    paths.push(String(input).split("?")[0] ?? "");
    const { status = 200, body } = answer();
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const NOT_AN_EPISODE = -1;
const AT = Date.parse("2026-09-08T12:00:00Z");

/** One film, still playing, that has served everything in `busy`'s window. */
const SESSION: PlaybackCostReport["sessions"][number] = {
  id: "s1",
  media: { tconst: "tt1375666", season: NOT_AN_EPISODE, episode: NOT_AN_EPISODE },
  bytes: 300_000_000,
  cpuMs: 37_500,
  startedAt: new Date(AT - 60_000).toISOString(),
  lastAt: new Date(AT).toISOString(),
  running: true,
};

/** One episode of a series, finished five minutes ago. */
const EPISODE: PlaybackCostReport["sessions"][number] = {
  id: "s2",
  media: { tconst: "tt0903747", season: 2, episode: 7 },
  bytes: 1_000_000,
  cpuMs: 400,
  startedAt: new Date(AT - 600_000).toISOString(),
  lastAt: new Date(AT - 300_000).toISOString(),
  running: false,
};

/** Two hours of empty thirty-second slices, with whatever a test wants dropped into the newest. */
function report(over: Partial<PlaybackCostReport> = {}): PlaybackCostReport {
  return {
    at: AT,
    sliceSeconds: 30,
    windowSeconds: 7_200,
    slices: Array.from({ length: 240 }, () => ({ bytes: 0, cpuMs: 0 })),
    window: { bytes: 0, cpuMs: 0 },
    sessions: [],
    evicted: 0,
    measured: false,
    ...over,
  };
}

/** A window with one busy slice: 300 MB in thirty seconds, and 37.5 s of CPU with it. */
function busy(over: Partial<PlaybackCostReport> = {}): PlaybackCostReport {
  const slices = Array.from({ length: 240 }, () => ({ bytes: 0, cpuMs: 0 }));
  slices[239] = { bytes: 300_000_000, cpuMs: 37_500 };
  return report({ slices, window: { bytes: 300_000_000, cpuMs: 37_500 }, measured: true, ...over });
}

beforeEach(() => {
  paths = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("it reads the admin cost endpoint, not the player's session list", async () => {
  stubFetch(() => ({ body: report() }));
  render(await routed());

  await waitFor(() => expect(paths).toContain("/api/admin/playback/cost"));
  expect(paths).not.toContain("/api/play/sessions");
});

test("a busy window draws both charts and states the totals in words as well", async () => {
  stubFetch(() => ({ body: busy() }));
  render(await routed());

  // Both series are one labelled image each, with the peak in the accessible name -- so a
  // reader who cannot see the picture is told the number the picture is about.
  await waitFor(() => expect(screen.getByLabelText(/^Bandwidth served over the last 2 hours/)).toBeDefined());
  expect(screen.getByLabelText(/^Transcode CPU over the last 2 hours/)).toBeDefined();

  // AND the same numbers exist as text, because a chart must not be the only place a number
  // appears. 300 MB in 30 s is 10 MB/s; 37.5 s of CPU in 30 s is 1.25 cores.
  expect(screen.getByLabelText(/Peak 10 MB\/s/)).toBeDefined();
  expect(screen.getByLabelText(/Peak 1\.25 cores/)).toBeDefined();
  expect(screen.getByText("300 MB")).toBeDefined();
});

/** HANDED OUT, never "watched" -- a seek discards segments already counted. */
test("the headline says what the number is, and does not claim anybody watched it", async () => {
  stubFetch(() => ({ body: busy() }));
  render(await routed());

  await waitFor(() => expect(screen.getByText("Handed out")).toBeDefined());
  expect(screen.getByText(/not bytes anybody watched/)).toBeDefined();
});

test("a server that has never played anything says so rather than drawing a flat line", async () => {
  stubFetch(() => ({ body: report() }));
  render(await routed());

  await waitFor(() => expect(screen.getByText(/Nothing has played since this server started/)).toBeDefined());
  expect(screen.queryByLabelText(/^Bandwidth served/)).toBeNull();
});

/** Two situations that look identical on a chart and want different reactions. */
test("a quiet window is worded differently from a server that has never played anything", async () => {
  stubFetch(() => ({ body: report({ measured: true }) }));
  render(await routed());

  await waitFor(() => expect(screen.getByText(/Nothing has played in the last 2 hours/)).toBeDefined());
});

test("each session is attributed to a title you can click through to", async () => {
  stubFetch(() => ({ body: busy({ sessions: [SESSION, EPISODE] }) }));
  render(await routed());

  await waitFor(() => expect(screen.getByText("tt1375666")).toBeDefined());
  expect(screen.getByText("tt1375666").getAttribute("href")).toBe("/title/tt1375666");
  expect(screen.getByText("Playing")).toBeDefined();
  expect(screen.getByText("Finished")).toBeDefined();
  // An episode says which one; a film says nothing about seasons.
  expect(screen.getByText(/Season 2, episode 7/)).toBeDefined();
  expect(screen.getByText(/37\.5 s of CPU/)).toBeDefined();
});

/**
 * Their bytes are still in the totals, so the rows adding up to less needs saying.
 *
 * The note sits with the rows rather than above the empty state, because eviction only ever
 * happens to a FULL table -- a report claiming both dropped rows and no rows at all is a
 * situation the server cannot produce.
 */
test("dropped rows are explained rather than silently missing", async () => {
  stubFetch(() => ({ body: busy({ evicted: 3, sessions: [SESSION] }) }));
  render(await routed());

  await waitFor(() => expect(screen.getByText(/3 older sessions dropped/)).toBeDefined());
});

/**
 * A CAST IS NOT A CHECK. An admin graph that can break the admin screen is the same defect as
 * the stats panel that could break playback -- so a body of the wrong shape is a sentence.
 */
test("a body that is not a cost report is refused in words", async () => {
  stubFetch(() => ({ body: { hello: "there" } }));
  render(await routed());

  await waitFor(() => expect(screen.getByText(/not a cost report/)).toBeDefined());
});

test("the 404 a non-admin gets is explained rather than read as a broken server", async () => {
  stubFetch(() => ({ status: 404, body: { error: "not found" } }));
  render(await routed());

  await waitFor(() => expect(screen.getByText(/administrator's page/)).toBeDefined());
});

test("refresh reads the endpoint again", async () => {
  stubFetch(() => ({ body: busy() }));
  render(await routed());

  await waitFor(() => expect(paths).toHaveLength(1));
  fireEvent.click(screen.getByText("Refresh"));
  await waitFor(() => expect(paths).toHaveLength(2));
});
