/**
 * What a reader actually sees when they ask why a request is slow.
 *
 * Rendered with `react-dom/server`, like the other component tests here. The assertions
 * that matter are the honesty ones: an internal enum must never reach the markup, and a
 * verdict with no download must not draw a bar.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VERDICT_COPY } from "../../../src/lib/request-diagnostics";
import type { RequestState } from "../lib/api";
import { ProgressBar, RequestVerdictPanel } from "./RequestProgress";

const state = (over: Partial<RequestState> = {}): RequestState => ({
  requestVerdict: "searching",
  requestProgress: null,
  requestEtaAt: null,
  ...over,
});

describe("the progress bar", () => {
  test("reports its percentage to a screen reader, not just to a pixel", () => {
    const html = renderToStaticMarkup(<ProgressBar value={0.62} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain("width:62%");
  });

  test("a value outside 0..1 is clamped rather than drawn", () => {
    expect(renderToStaticMarkup(<ProgressBar value={-0.5} />)).toContain('aria-valuenow="0"');
    expect(renderToStaticMarkup(<ProgressBar value={4} />)).toContain('aria-valuenow="100"');
  });

  /**
   * It sits inside `RequestAction`'s chip, which is a span. A div in there is markup a
   * browser silently reparents, moving the bar out of the chip.
   */
  test("draws no block-level element, so it is legal inside a span", () => {
    expect(renderToStaticMarkup(<ProgressBar value={0.5} />)).not.toContain("<div");
  });
});

describe("the verdict panel", () => {
  test("a title nobody asked for draws nothing at all -- not an empty box", () => {
    expect(renderToStaticMarkup(<RequestVerdictPanel state={state({ requestVerdict: null })} />)).toBe("");
  });

  test("says the label and the honest sentence, and never the enum", () => {
    const html = renderToStaticMarkup(
      <RequestVerdictPanel state={state({ requestVerdict: "no_releases" })} />,
    );
    expect(html).toContain(VERDICT_COPY.no_releases.label);
    expect(html).toContain("none of them have a release");
    // The internal status word. Seeing it in front of a human is the bug the copy fixes.
    expect(html).not.toContain("no_releases");
  });

  test("a request still being worked on is not coloured like a dead end", () => {
    const working = renderToStaticMarkup(<RequestVerdictPanel state={state()} />);
    const dead = renderToStaticMarkup(<RequestVerdictPanel state={state({ requestVerdict: "failed" })} />);
    expect(working).toContain("border-warn/40");
    expect(dead).toContain("border-danger/50");
  });

  test("no download means no bar and no percentage", () => {
    const html = renderToStaticMarkup(<RequestVerdictPanel state={state()} />);
    expect(html).not.toContain("progressbar");
    expect(html).not.toContain("%");
  });

  test("a download in flight draws its bar and its percentage", () => {
    const html = renderToStaticMarkup(
      <RequestVerdictPanel state={state({ requestVerdict: "downloading", requestProgress: 0.62 })} />,
    );
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain("62%");
  });

  test("an ETA in the future is said in minutes", () => {
    const html = renderToStaticMarkup(
      <RequestVerdictPanel
        state={state({
          requestVerdict: "downloading",
          requestProgress: 0.62,
          requestEtaAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        })}
      />,
    );
    expect(html).toContain("4 min left");
  });

  /** A stalled download's estimate expires. Counting up past it reads as broken. */
  test("an ETA already past is simply not drawn", () => {
    const html = renderToStaticMarkup(
      <RequestVerdictPanel
        state={state({
          requestVerdict: "downloading",
          requestProgress: 0.62,
          requestEtaAt: new Date(Date.now() - 60_000).toISOString(),
        })}
      />,
    );
    expect(html).toContain("62%");
    expect(html).not.toContain("left");
  });

  /**
   * `error` is already through `safeArrMessage`, so it is safe to show AND more specific
   * than the generic failure sentence -- it tells an admin what to go and fix.
   */
  test("a sanitised failure reason replaces the generic sentence", () => {
    const html = renderToStaticMarkup(
      <RequestVerdictPanel
        state={state({ requestVerdict: "failed" })}
        error="radarr rejected our credentials"
      />,
    );
    expect(html).toContain("radarr rejected our credentials");
    expect(html).not.toContain(VERDICT_COPY.failed.sentence);
  });
});
