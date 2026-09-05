import { describe, expect, test } from "bun:test";
import { brokenLinks, type DocTree, resolvableLinks, trackedTree } from "./doc-links";

/**
 * Every relative link in a tracked document must land on a tracked file, and on a heading
 * that exists when it names one.
 *
 * The sibling floor, `doc-anchors.test.ts`, catches a renamed heading within ONE file. The
 * same rename one file over -- `](TUNING.md#speed)` -- was invisible until this, and so was
 * a link to a file that does not exist at all.
 *
 * The fixtures come first and they are the point: a link checker whose extractor has quietly
 * stopped matching reads EXACTLY like a repo with no broken links, both green, both silent.
 * Nothing here trusts the tree being clean as evidence that the detector works.
 */

/** A tree from a literal `{ path: contents }`, with every path tracked. */
function treeOf(markdown: Record<string, string>, extraFiles: string[] = []): DocTree {
  return {
    files: new Set([...Object.keys(markdown), ...extraFiles]),
    markdown: new Map(Object.entries(markdown)),
  };
}

describe("brokenLinks fires on the defects it exists for", () => {
  test("a link to a path that does not exist", () => {
    const tree = treeOf({ "README.md": "see [the guide](guides/typo.md)\n" });
    expect(brokenLinks(tree)).toEqual([
      { file: "README.md", line: 1, target: "guides/typo.md", reason: "no such file" },
    ]);
  });

  test("a cross-file anchor whose target heading was renamed", () => {
    const linked = { "README.md": "see [Speed](TUNING.md#speed)\n", "TUNING.md": "## Speed\n" };
    expect(brokenLinks(treeOf(linked))).toEqual([]);

    const renamed = { ...linked, "TUNING.md": "## How fast it is\n" };
    expect(brokenLinks(treeOf(renamed))).toEqual([
      { file: "README.md", line: 1, target: "TUNING.md#speed", reason: "no such heading" },
    ]);
  });

  test("a path resolves from the linking document, not the repo root", () => {
    // `src/plugins/README.md` really does link `../../ADDONS.md`. Resolved from the root it
    // would escape the repo; resolved from the document it lands.
    const nested = { "ADDONS.md": "# Addons\n", "src/plugins/README.md": "the [brief](../../ADDONS.md)\n" };
    expect(brokenLinks(treeOf(nested))).toEqual([]);

    const wrong = { ...nested, "src/plugins/README.md": "the [brief](ADDONS.md)\n" };
    expect(brokenLinks(treeOf(wrong))).toEqual([
      { file: "src/plugins/README.md", line: 1, target: "ADDONS.md", reason: "no such file" },
    ]);
  });

  test("reports the line a link is on, not the line of the file", () => {
    const tree = treeOf({ "README.md": "# Title\n\nprose\n\nsee [gone](nope.md)\n" });
    expect(brokenLinks(tree).map(({ line }) => line)).toEqual([5]);
  });
});

describe("brokenLinks resolves the links that do land", () => {
  test("a link to a tracked file that is not markdown, with or without a fragment", () => {
    const tree = treeOf({ "README.md": "copy [the override](docker-compose.override.example.yml)\n" }, [
      "docker-compose.override.example.yml",
    ]);
    expect(brokenLinks(tree)).toEqual([]);

    // `#L20` is GitHub numbering a source file's lines. There is no heading to check it against.
    const lineLink = treeOf({ "README.md": "see [the call](src/lib/arr.ts#L20)\n" }, ["src/lib/arr.ts"]);
    expect(brokenLinks(lineLink)).toEqual([]);
  });

  test("a link to a directory, which exists when the tree tracks a file inside it", () => {
    const tree = treeOf({ "README.md": "the [logos](web/public/logos/)\n" }, ["web/public/logos/plex.svg"]);
    expect(brokenLinks(tree)).toEqual([]);
    expect(brokenLinks(treeOf({ "README.md": "the [logos](web/public/logos/)\n" }))).toHaveLength(1);
  });

  test("the reference-definition and angle-bracketed forms", () => {
    const tree = treeOf({
      "README.md": "[tuning]: TUNING.md\n\nand [again](<TUNING.md>)\n",
      "TUNING.md": "",
    });
    expect(brokenLinks(tree)).toEqual([]);
  });
});

describe("resolvableLinks leaves other checks' links alone", () => {
  test("network links, other schemes, bare fragments and private directories", () => {
    const md = [
      "[seerr](https://github.com/seerr-team/seerr/)",
      "[mail](mailto:x@example.com)",
      "[here](#a-heading)", // doc-anchors.test.ts owns this
      "[card](.rclaude/project/cards/x.md)", // public-doc-links.test.ts owns this
      "[brief](../.claude/CLAUDE.md)",
    ].join("\n\n");
    expect(resolvableLinks(md)).toEqual([]);
  });

  test("a link inside a fenced block is not a link", () => {
    expect(resolvableLinks("```\n[x](guides/typo.md)\n```\n")).toEqual([]);
  });

  test("but a real relative link is picked up", () => {
    expect(resolvableLinks("see [the guide](guides/import-from-seer.md)").map((l) => l.path)).toEqual([
      "guides/import-from-seer.md",
    ]);
  });
});

describe("every tracked document's relative links resolve", () => {
  test("no tracked .md links to a path or cross-file heading that does not exist", async () => {
    const tree = await trackedTree();
    expect(tree.markdown.size).toBeGreaterThan(0);

    const offenders = brokenLinks(tree).map((l) => `${l.file}:${l.line}: ${l.target} -- ${l.reason}`);
    expect(offenders).toEqual([]);

    // Pinned to "there are relative links at all", never to how many: a count has to be
    // edited to stay green, and a check edited without being read is not a check. Zero would
    // mean the extractor stopped matching, which is indistinguishable from a clean repo.
    const linkCount = [...tree.markdown.values()].reduce((n, text) => n + resolvableLinks(text).length, 0);
    expect(linkCount).toBeGreaterThan(0);
  });
});
