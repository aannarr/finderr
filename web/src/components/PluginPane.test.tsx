/**
 * What a plugin's blocks draw as.
 *
 * Rendered with `react-dom/server`, like the other component tests here: the assertions are
 * about which markup a block produces, and static markup answers that with no DOM.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RenderedPane } from "../lib/api";
import { PluginPanes, panesForSlot } from "./PluginPane";

const pane = (blocks: RenderedPane["blocks"], slot = "title.after-cast"): RenderedPane =>
  ({ slot, id: "fixture:note", blocks }) as RenderedPane;

describe("picking the panes for a slot", () => {
  const a = pane([{ type: "text", value: "a" }], "title.after-cast");
  const b = pane([{ type: "text", value: "b" }], "title.end");

  test("returns only the panes that claimed it", () => {
    expect(panesForSlot([a, b], "title.end")).toEqual([b]);
    expect(panesForSlot([a, b], "title.after-synopsis")).toEqual([]);
  });

  /** No plugins is the ordinary case and must not be a special case at the call site. */
  test("an absent list is an empty list", () => {
    expect(panesForSlot(undefined, "title.end")).toEqual([]);
  });
});

describe("drawing blocks", () => {
  test("nothing at all when no pane claimed the slot -- not even a wrapper", () => {
    // A slot with no plugin panes must leave NO gap in the page, so it renders no element.
    expect(renderToStaticMarkup(<PluginPanes panes={[]} />)).toBe("");
  });

  test("text, chips and rows each draw their content", () => {
    const html = renderToStaticMarkup(
      <PluginPanes
        panes={[
          pane([
            { type: "text", value: "a note from a plugin" },
            { type: "chips", items: ["heist", "dream"] },
            { type: "rows", rows: [{ label: "Budget", value: "$160M" }] },
          ]),
        ]}
      />,
    );
    expect(html).toContain("a note from a plugin");
    expect(html).toContain("heist");
    expect(html).toContain("dream");
    expect(html).toContain("Budget");
    expect(html).toContain("$160M");
  });

  test("a link draws an anchor to the path the server allowed", () => {
    const html = renderToStaticMarkup(
      <PluginPanes panes={[pane([{ type: "link", label: "More heists", href: "/browse?genre=Heist" }])]} />,
    );
    expect(html).toContain('href="/browse?genre=Heist"');
    expect(html).toContain("More heists");
  });

  /**
   * The version-skew guard. The server already refuses an unknown block, so this is the
   * second of two: a client cached from an older build meeting a newer server renders a
   * blank space rather than throwing on a `type` it has never heard of.
   */
  test("an unknown block type renders nothing instead of throwing", () => {
    const blocks = [
      { type: "hologram", value: "???" },
      { type: "text", value: "still here" },
    ] as unknown as RenderedPane["blocks"];
    const html = renderToStaticMarkup(<PluginPanes panes={[pane(blocks)]} />);
    expect(html).toContain("still here");
    expect(html).not.toContain("???");
  });
});
