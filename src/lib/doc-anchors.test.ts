import { describe, expect, test } from "bun:test";
import { anchorLinks, documentLinks, headingSlugs, slugifyHeading, unresolvedAnchors } from "./doc-anchors";
import { readTrackedMarkdown } from "./tracked-markdown";

/**
 * Every `](#anchor)` in a tracked document must land on a heading that exists.
 *
 * This is a FLOOR, not the whole problem. It catches the renamed heading -- the failure
 * that arrives on its own as a file is edited, and that no other gate can see, because a
 * dead anchor typechecks and lints. It does NOT catch a link that resolves and still
 * promises something its target does not say, and that half was measured rather than
 * assumed: see WHAT THIS CANNOT CHECK at the bottom of this file.
 */

describe("slugifyHeading follows GitHub's rule", () => {
  test("lowercases, drops punctuation, spaces become hyphens", () => {
    expect(slugifyHeading("What it does")).toBe("what-it-does");
    expect(slugifyHeading("The assistant, and why there is one at all")).toBe(
      "the-assistant-and-why-there-is-one-at-all",
    );
  });

  test("keeps hyphens and underscores, so a run of them survives", () => {
    // `## Step 4 -- clean up` is linked as `#step-4----clean-up`: two hyphens plus the two
    // from the spaces around them. Collapsing them would break a link that works today.
    expect(slugifyHeading("Step 4 -- clean up")).toBe("step-4----clean-up");
    expect(slugifyHeading("FINDERR_NO_AUTH")).toBe("finderr_no_auth");
  });

  test("renders inline markdown away first, as a reader sees it", () => {
    expect(slugifyHeading("`FINDERR_DATA_DIR` and friends")).toBe("finderr_data_dir-and-friends");
    expect(slugifyHeading("**Speed**")).toBe("speed");
    expect(slugifyHeading("See [the guide](guides/x.md)")).toBe("see-the-guide");
    // ...but only where an underscore is really emphasis. Intraword, it is part of the word.
    expect(slugifyHeading("_Speed_")).toBe("speed");
  });
});

describe("headingSlugs", () => {
  test("ignores a `#` inside a fenced block", () => {
    // README.md ships a ```yaml block whose first line is `# docker-compose.yml`. Read as a
    // heading it would mint a target no link uses -- harmless -- but it also shifts the
    // duplicate-suffix numbering of every later heading, which is not.
    const md = "# Real\n\n```yaml\n# docker-compose.yml\n```\n\n## Also real\n";
    expect(headingSlugs(md)).toEqual(["real", "also-real"]);
  });

  test("closes a fence only on a run at least as long as the one that opened it", () => {
    const md = "````\n```\n# not a heading\n````\n\n# heading\n";
    expect(headingSlugs(md)).toEqual(["heading"]);
  });

  test("suffixes repeated titles the way GitHub does", () => {
    const md = "## Why\n### Why\n#### Why\n";
    expect(headingSlugs(md)).toEqual(["why", "why-1", "why-2"]);
  });

  test("a heading whose title merely contains an earlier one is not a duplicate", () => {
    const md = "## Why\n## Why this is not a bypass\n";
    expect(headingSlugs(md)).toEqual(["why", "why-this-is-not-a-bypass"]);
  });
});

describe("documentLinks", () => {
  test("splits a target into the path and the fragment, either of which may be absent", () => {
    expect(documentLinks("[a](TUNING.md#speed)").map(({ path, anchor }) => [path, anchor])).toEqual([
      ["TUNING.md", "#speed"],
    ]);
    expect(documentLinks("[a](guides/x.md)").map(({ path, anchor }) => [path, anchor])).toEqual([
      ["guides/x.md", ""],
    ]);
    expect(documentLinks("[a](#speed)").map(({ path, anchor }) => [path, anchor])).toEqual([["", "#speed"]]);
  });

  test("keeps a path's case and lowercases a fragment, the way GitHub compares them", () => {
    expect(documentLinks("[a](ADDONS.md#Why)").map(({ path, anchor }) => [path, anchor])).toEqual([
      ["ADDONS.md", "#why"],
    ]);
  });

  test("finds a link carrying a title, which would otherwise be silently skipped", () => {
    expect(documentLinks(`[a](TUNING.md "the ladder")`).map((l) => l.path)).toEqual(["TUNING.md"]);
    expect(documentLinks(`[a]: TUNING.md "the ladder"`).map((l) => l.path)).toEqual(["TUNING.md"]);
  });

  test("finds an image, which is a link to a file a reader can 404 on", () => {
    expect(documentLinks("![a poster](web/public/poster.png)").map((l) => l.path)).toEqual([
      "web/public/poster.png",
    ]);
  });
});

describe("anchorLinks", () => {
  test("finds the inline, angle-bracketed and reference-definition forms", () => {
    expect(anchorLinks("see [Speed](#speed) for the trade").map((l) => l.anchor)).toEqual(["#speed"]);
    expect(anchorLinks("see [Speed](<#speed>)").map((l) => l.anchor)).toEqual(["#speed"]);
    expect(anchorLinks("[speed]: #speed").map((l) => l.anchor)).toEqual(["#speed"]);
  });

  test("ignores an anchor inside a fenced block, and a relative link that is not an anchor", () => {
    expect(anchorLinks("```\n[x](#speed)\n```\n")).toEqual([]);
    expect(anchorLinks("see [the guide](guides/import-from-seer.md)")).toEqual([]);
  });

  test("compares percent-encoded and literal anchors as the same target", () => {
    expect(anchorLinks("[x](#caf%C3%A9)").map((l) => l.anchor)).toEqual(["#café"]);
  });
});

describe("unresolvedAnchors", () => {
  test("fires when a heading is renamed out from under a link", () => {
    // The mutation this whole file exists for. A sweep that reports nothing because the
    // parser is broken reads exactly like a clean repo, so the detector is proven alive
    // here rather than only being trusted on the real documents below.
    const md = "## Speed\n\nsee [Speed](#speed)\n";
    expect(unresolvedAnchors(md)).toEqual([]);
    expect(unresolvedAnchors(md.replace("## Speed", "## How fast it is")).map((l) => l.anchor)).toEqual([
      "#speed",
    ]);
  });
});

describe("every tracked document's anchors resolve", () => {
  test("no tracked .md links to a heading it does not contain", async () => {
    const docs = await readTrackedMarkdown();
    expect(docs.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let linkCount = 0;
    for (const { file, text } of docs) {
      linkCount += anchorLinks(text).length;
      for (const { line, anchor } of unresolvedAnchors(text)) offenders.push(`${file}:${line}: ${anchor}`);
    }

    expect(offenders).toEqual([]);
    // Pinned to "there are anchors at all", never to how many: the count changes the next
    // time somebody adds a heading, and a check that has to be edited to stay green is one
    // that gets edited without being read. Zero would mean the extractor stopped working.
    expect(linkCount).toBeGreaterThan(0);
  });
});

/**
 * WHAT THIS CANNOT CHECK, and why nothing here tries.
 *
 * The defect that prompted this file was `See [Why](#why) for who may make one`, where
 * `#why` resolves perfectly to a heading about Seerr being slow. The link is not broken;
 * the PROMISE is. The card proposed a lint for it: a link followed by a promise clause
 * (`for who may ...`, `for how ...`) must point at a heading whose title carries the
 * promise's noun. It was measured against this repo's own documents before being rejected,
 * with the clause matcher run over reflowed paragraphs so wrapped prose was visible:
 *
 *   - It flags THREE of the three promise clauses in the tree, and all three are correct
 *     prose. Two are `see [Speed](#speed) for what those bytes buy` and `for the trade` --
 *     a heading named for the argument rather than for the noun of every sentence citing
 *     it, which is how headings are supposed to be named.
 *   - The third it flags is the CORRECTED form of the very sentence that motivated it:
 *     `[The money, and who is allowed to spend it](#...) for who may make one` contains no
 *     noun at all, only pronouns, so there is nothing to match against the heading.
 *
 * Three false positives, zero true positives. A check that goes red on correct prose is
 * suppressed within a week, and a suppressed check is worse than no check because it reads
 * as coverage. The content half of this problem is not machine-checkable here: a second
 * human reader is the only guard, and a docs change wants a reviewer rather than a gate.
 */
