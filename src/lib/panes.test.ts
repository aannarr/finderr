/**
 * The pane vocabulary's rules, tested where they live: pure functions, no DOM, no loader.
 *
 * `renderPanes` runs ON THE RENDER PATH, so the properties that matter are the defensive
 * ones -- it must not throw, must not be slow, and must not let a plugin put an upstream
 * URL in front of a browser.
 */

import { describe, expect, test } from "bun:test";
import type { ResolvedFacets } from "./facet-resolver";
import { isPaneSlot, PANE_SLOTS, type PaneBlock, type RegisteredPane, renderPanes } from "./panes";

const ready = (): ResolvedFacets =>
  ({
    synopsis: { status: "ready", data: { text: "a film", source: "TMDB" } },
    keywords: { status: "ready", data: ["heist"] },
    cast: { status: "pending" },
  }) as unknown as ResolvedFacets;

function pane(over: Partial<RegisteredPane> = {}): RegisteredPane {
  return {
    pluginId: "fixture",
    id: "hello",
    slot: "title.after-cast",
    needs: [],
    render: () => [{ type: "text", value: "hello" }],
    ...over,
  };
}

describe("the slot vocabulary", () => {
  test("every declared slot is recognised, and nothing else is", () => {
    for (const s of PANE_SLOTS) expect(isPaneSlot(s)).toBe(true);
    expect(isPaneSlot("title.header")).toBe(false);
    expect(isPaneSlot("")).toBe(false);
  });
});

describe("rendering a declared pane", () => {
  test("namespaces the id by plugin, so two plugins may both call a pane 'hello'", () => {
    const out = renderPanes([pane(), pane({ pluginId: "other" })], ready());
    expect(out.map((p) => p.id)).toEqual(["fixture:hello", "other:hello"]);
  });

  test("keeps the declared slot, so placement is the plugin's decision", () => {
    const out = renderPanes([pane({ slot: "title.end" })], ready());
    expect(out[0]?.slot).toBe("title.end");
  });

  /**
   * A pane whose facet has not landed is ABSENT, never a skeleton. Core's panes reserve
   * space because core knows how tall they will be; a plugin's is an unknown quantity, and
   * a skeleton that never resolves is worse than nothing appearing at all.
   */
  test("a pane whose needs are unmet renders nothing", () => {
    expect(renderPanes([pane({ needs: ["cast"] })], ready())).toEqual([]);
    expect(renderPanes([pane({ needs: ["trailer"] })], ready())).toEqual([]);
    expect(renderPanes([pane({ needs: ["synopsis", "keywords"] })], ready())).toHaveLength(1);
  });

  test("a pane that returns no blocks is absent rather than an empty box", () => {
    expect(renderPanes([pane({ render: () => [] })], ready())).toEqual([]);
  });

  /**
   * Found by the live acceptance run: the fixture passed `keywords` straight through as
   * chips, and `keywords.data` is `{id, name}` objects rather than strings -- so the block
   * was correctly dropped while the two around it survived. That is the intended rule
   * working. What it exposed is this one: an EMPTY list was still a valid block, and drew
   * an empty flex row. `paneView` refuses to draw a core pane for a ready-but-empty facet,
   * and a plugin block is not the place to make an exception.
   */
  test("an empty list is not a block, so a pane made only of one disappears", () => {
    expect(renderPanes([pane({ render: () => [{ type: "chips", items: [] }] })], ready())).toEqual([]);
    expect(renderPanes([pane({ render: () => [{ type: "rows", rows: [] }] })], ready())).toEqual([]);

    // ...and it costs only itself when there is something real beside it.
    const out = renderPanes(
      [
        pane({
          render: () => [
            { type: "chips", items: [] },
            { type: "text", value: "kept" },
          ],
        }),
      ],
      ready(),
    );
    expect(out[0]?.blocks).toEqual([{ type: "text", value: "kept" }]);
  });
});

describe("a plugin cannot break the page", () => {
  test("a render that throws costs its own pane and nothing else", () => {
    const logs: string[] = [];
    const out = renderPanes(
      [
        pane({
          id: "bad",
          render: () => {
            throw new Error("boom");
          },
        }),
        pane({ id: "good" }),
      ],
      ready(),
      (m) => logs.push(m),
    );

    expect(out.map((p) => p.id)).toEqual(["fixture:good"]);
    // Logged, because a silently missing pane is indistinguishable from a plugin that
    // meant to say nothing, and the author has to be able to tell those apart.
    expect(logs.join("\n")).toMatch(/pane 'bad' threw -- boom/);
  });

  test("an unknown block type is dropped, and the valid blocks around it survive", () => {
    const out = renderPanes(
      [
        pane({
          render: () =>
            [
              { type: "text", value: "kept" },
              { type: "marquee", value: "nope" },
              { type: "chips", items: ["also kept"] },
            ] as unknown as PaneBlock[],
        }),
      ],
      ready(),
    );
    expect(out[0]?.blocks).toEqual([
      { type: "text", value: "kept" },
      { type: "chips", items: ["also kept"] },
    ]);
  });

  test("a malformed block of a known type is dropped too", () => {
    const out = renderPanes(
      [
        pane({
          render: () =>
            [
              { type: "text" },
              { type: "text", value: "" },
              { type: "chips", items: ["ok", 7] },
              { type: "rows", rows: [{ label: "Runtime" }] },
            ] as unknown as PaneBlock[],
        }),
      ],
      ready(),
    );
    expect(out).toEqual([]);
  });
});

/**
 * The rule a plugin is the most likely thing to break, so it is enforced on the server
 * rather than trusted to the client guard. finderr will be internet-facing while the
 * providers stay on the LAN: an upstream URL is both unreachable from outside and a leak
 * of which providers sit behind us.
 */
describe("a plugin link is same-origin or it is not a link", () => {
  const link = (href: string) =>
    renderPanes([pane({ render: () => [{ type: "link", label: "go", href }] })], ready());

  test("keeps a same-origin path", () => {
    expect(link("/browse?genre=Heist")[0]?.blocks).toHaveLength(1);
    expect(link("/title/tt1375666")[0]?.blocks).toHaveLength(1);
  });

  test("refuses an absolute URL", () => {
    expect(link("https://themoviedb.org/movie/27205")).toEqual([]);
    expect(link("http://10.0.0.10:7878/movie")).toEqual([]);
  });

  /** A protocol-relative URL is an absolute URL in disguise -- the same trap the client guard names. */
  test("refuses a protocol-relative URL", () => {
    expect(link("//evil.example/x")).toEqual([]);
  });

  /**
   * THE FOUR THAT GOT PAST THE FIRST VERSION OF THIS GUARD.
   *
   * Found in review, then measured: each of these satisfies
   * `startsWith("/") && !startsWith("//")` and still resolves to `https://evil.com` when a
   * browser parses it against a finderr URL. A browser does not compare strings -- the
   * WHATWG parser folds `\` to `/` for http(s), and strips tab/LF/CR entirely, so three of
   * these BECOME the `//evil.com` case after the check has already passed them.
   *
   * The origins in the table were verified with `new URL(href, "https://finderr.example.com/title/tt1375666")`.
   */
  test.each([
    ["backslash, which the parser folds to a slash", "/\\evil.com/x"],
    ["a stripped tab", "/\t/evil.com/x"],
    ["a stripped line feed", "/\n/evil.com/x"],
    ["a stripped carriage return", "/\r/evil.com/x"],
  ])("refuses %s", (_name, href) => {
    expect(link(href)).toEqual([]);
  });

  /**
   * THE GUARD MUST BE STATELESS ACROSS CALLS, which is not automatic.
   *
   * `UNSAFE_HREF_CHARS` is a module-level regex. Give it the `/g` flag and `.test()` starts
   * carrying `lastIndex` between calls: the first call matches and leaves the index past the
   * match, the second resumes from there and returns false. The guard would then admit the
   * attack on every SECOND invocation -- and every test that calls it once would still pass,
   * which is why this one calls it repeatedly.
   */
  test("refuses the same attack every time, not every other time", () => {
    for (let i = 0; i < 4; i++) {
      expect(link("/\\evil.com/x")).toEqual([]);
      expect(link("/\t/evil.com/x")).toEqual([]);
    }
  });

  /**
   * Percent-encoding is deliberately NOT a family to chase: the parser does not decode
   * before deciding the authority, so this stays same-origin and is a legitimate path.
   * Pinned so nobody "hardens" the guard into rejecting real links.
   */
  test("keeps a percent-encoded path, which is same-origin", () => {
    expect(link("/%2f/evil.com")[0]?.blocks).toHaveLength(1);
    expect(link("/collection/tmdb%3A2344")[0]?.blocks).toHaveLength(1);
  });

  test("refuses a javascript: URL", () => {
    expect(link("javascript:alert(1)")).toEqual([]);
  });
});
