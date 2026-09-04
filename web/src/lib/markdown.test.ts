/**
 * The markdown subset, and the two things that would be silently wrong.
 *
 * The first is STREAMING: half of every construct arrives before the other half, so a
 * `**bold` with no closing marker must render as five characters rather than swallowing the
 * rest of the answer into a strong tag that never ends.
 *
 * The second is TOOL NAMES. Every tool this assistant calls is `find_title`,
 * `list_episodes`, `min_rating` -- and intraword `_` treated as emphasis mangles an
 * identifier in the one place identifiers are the content.
 *
 * The SAFETY property is not tested here and cannot be: it is the output SHAPE, and this
 * module returns a tree with no HTML anywhere in it. `Markdown.tsx` is where a URL is
 * guarded, and `AssistantPanel.test.tsx` is where that is pinned.
 */

import { describe, expect, test } from "bun:test";
import { type Block, type Inline, isRichMarkdown, parseInline, parseMarkdown } from "./markdown";

/** Flatten a tree back to its visible text, which is what most assertions care about. */
function textOf(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
        case "code":
          return n.text;
        case "image":
          return n.alt;
        case "mention":
          // Never produced by the parser -- it is a post-pass over the tree. Its rendered
          // text is our label, so that is what a text extraction should see.
          return n.label;
        default:
          return textOf(n.children);
      }
    })
    .join("");
}

const kinds = (blocks: readonly Block[]) => blocks.map((b) => b.type);

describe("blocks", () => {
  test("a heading, a paragraph and a list", () => {
    const blocks = parseMarkdown("## Best seasons\n\nHere they are:\n\n- Season 2\n- Season 4\n");
    expect(kinds(blocks)).toEqual(["heading", "paragraph", "list"]);
    expect(blocks[0]).toMatchObject({ level: 2 });
    expect(blocks[2]).toMatchObject({ ordered: false });
  });

  test("an ordered list keeps its ordering", () => {
    const [list] = parseMarkdown("1. first\n2. second");
    expect(list).toMatchObject({ type: "list", ordered: true });
  });

  /** `- x` is a list and `---` is a rule; only the space after the marker tells them apart. */
  test("three dashes are a rule, not a bullet", () => {
    expect(kinds(parseMarkdown("---"))).toEqual(["rule"]);
    expect(kinds(parseMarkdown("- x"))).toEqual(["list"]);
  });

  test("a fenced block keeps its text verbatim and does not parse markdown inside it", () => {
    const [code] = parseMarkdown("```ts\nconst a = **b**;\n```");
    expect(code).toEqual({ type: "code", lang: "ts", text: "const a = **b**;" });
  });

  /**
   * MID-STREAM. The closing fence has not been typed yet, and rendering the opening one as
   * literal backticks would flash punctuation on screen before the block appeared.
   */
  test("an unterminated fence is still a code block", () => {
    expect(parseMarkdown("```\nhalf a line")).toEqual([{ type: "code", lang: null, text: "half a line" }]);
  });

  /**
   * A single newline is KEPT, deliberately against CommonMark. The bubble this replaced was
   * `whitespace-pre-wrap`, so collapsing them would reflow every answer already on screen as
   * the price of adding bold text.
   */
  test("a soft line break inside a paragraph survives", () => {
    const [para] = parseMarkdown("one\ntwo");
    expect(para.type === "paragraph" && textOf(para.children)).toBe("one\ntwo");
  });

  test("a blockquote is its own block", () => {
    expect(kinds(parseMarkdown("> quoted\n> more"))).toEqual(["quote"]);
  });

  test("a wrapped bullet joins the item above it", () => {
    const [list] = parseMarkdown("- a long item\n  that wrapped\n- second");
    expect(list.type === "list" && list.items.map(textOf)).toEqual(["a long item that wrapped", "second"]);
  });
});

describe("inline", () => {
  test("bold, italic and inline code", () => {
    expect(parseInline("**b** and *i* and `c`").map((n) => n.type)).toEqual([
      "strong",
      "text",
      "em",
      "text",
      "code",
    ]);
  });

  test("a link carries its destination", () => {
    expect(parseInline("see [IMDb](https://www.imdb.com/)")[1]).toMatchObject({
      type: "link",
      href: "https://www.imdb.com/",
    });
  });

  test("a URL with parentheses in it closes at the right one", () => {
    expect(parseInline("[x](https://en.wikipedia.org/wiki/Heat_(1995_film))")[0]).toMatchObject({
      href: "https://en.wikipedia.org/wiki/Heat_(1995_film)",
    });
  });

  test("an image is its own node", () => {
    expect(parseInline("![a poster](/img/t/tt1)")[0]).toEqual({
      type: "image",
      src: "/img/t/tt1",
      alt: "a poster",
    });
  });

  /** A code span wins against everything inside it; no ordering of regexes gets this right. */
  test("markdown inside a code span is literal", () => {
    const nodes = parseInline("`**not bold**`");
    expect(nodes).toEqual([{ type: "code", text: "**not bold**" }]);
  });

  /**
   * THE STREAMING CASE. Half a construct must render as the characters that arrived rather
   * than swallowing everything after it.
   */
  test("an unclosed bold marker is literal text", () => {
    expect(textOf(parseInline("**bold and then nothing"))).toBe("**bold and then nothing");
  });

  /**
   * THE TOOL-NAME CASE. `list_episodes` is content in this panel, and intraword emphasis
   * would mangle the one kind of string a reader most needs to read exactly.
   */
  test("an underscore inside a word is not emphasis", () => {
    expect(parseInline("call list_episodes then min_rating")).toEqual([
      { type: "text", text: "call list_episodes then min_rating" },
    ]);
  });

  test("an escaped marker is a literal character", () => {
    expect(textOf(parseInline("2 \\* 3"))).toBe("2 * 3");
  });

  test("emphasis nests other inline nodes", () => {
    const [strong] = parseInline("**see [here](https://x.dev/)**");
    expect(strong.type === "strong" && strong.children.map((c) => c.type)).toEqual(["text", "link"]);
  });
});

describe("whether the composer shows a preview", () => {
  /**
   * The preview appears only when rendering would look any DIFFERENT, which is what makes
   * it deliberate rather than decorative -- an ordinary sentence gets no new chrome.
   */
  test("plain prose is not rich", () => {
    expect(isRichMarkdown("What should I watch tonight?")).toBe(false);
    expect(isRichMarkdown("")).toBe(false);
    expect(isRichMarkdown("two\nlines of prose")).toBe(false);
  });

  test("anything with structure or a marker is", () => {
    expect(isRichMarkdown("**bold**")).toBe(true);
    expect(isRichMarkdown("- a list")).toBe(true);
    expect(isRichMarkdown("# heading")).toBe(true);
    expect(isRichMarkdown("`code`")).toBe(true);
    expect(isRichMarkdown("one para\n\nanother")).toBe(true);
  });
});
