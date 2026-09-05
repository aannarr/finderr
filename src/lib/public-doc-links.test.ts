import { describe, expect, test } from "bun:test";
import { readTrackedMarkdown } from "./tracked-markdown";

/**
 * Tracked markdown may not LINK into a gitignored directory.
 *
 * `.rclaude/` and `.claude/` are gitignored, so nothing under them has ever been pushed.
 * A link to one of those paths from a tracked document is a guaranteed 404 for every
 * reader of github.com/aannarr/finderr, and it advertises the private board's card ids to
 * strangers -- one step short of what the pre-push scrub catches, which only refuses a
 * private HOSTNAME. ADDONS.md carried exactly one of these.
 *
 * A backticked path in prose or a code comment is deliberately NOT a hit: it is a path a
 * reader with the repo checked out can open, and there is nothing to click and 404 on.
 * Only the clickable forms are checked -- inline links, reference definitions, and raw
 * HTML attributes.
 */

const PRIVATE_DIR = String.raw`\.(?:rclaude|claude)\/`;

const LINK_FORMS = [
  // [text](.claude/x.md) and [text](<.claude/x.md>), with an optional ./ or ../ prefix
  new RegExp(String.raw`\]\(\s*<?[.\/]*${PRIVATE_DIR}`),
  // [label]: .claude/x.md
  new RegExp(String.raw`^\s*\[[^\]]+\]:\s*<?[.\/]*${PRIVATE_DIR}`),
  // <a href=".claude/x.md">, <img src="...">
  new RegExp(String.raw`(?:href|src)=["']?[.\/]*${PRIVATE_DIR}`),
];

/** Every line of `text` that links into a gitignored directory, numbered from 1. */
function privateLinkHits(text: string): { line: number; text: string }[] {
  return text
    .split("\n")
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text: line }) => LINK_FORMS.some((form) => form.test(line)));
}

describe("no tracked markdown links into a gitignored directory", () => {
  test("the detector fires on the shapes it is meant to catch", () => {
    // Proves the regexes are alive. A sweep that matches nothing because the pattern is
    // broken reads exactly like a clean repo -- that is how this bug survived review once.
    expect(privateLinkHits("see [`the card`](.rclaude/project/cards/x.md) for the plan")).toHaveLength(1);
    expect(privateLinkHits("[brief]: ./.claude/CLAUDE.md")).toHaveLength(1);
    expect(privateLinkHits(`<a href="../.claude/docs/postmortem.md">why</a>`)).toHaveLength(1);
    expect(privateLinkHits("the brief lives in `.claude/CLAUDE.md`, which you do not have")).toHaveLength(0);
  });

  test("every tracked .md file is clean", async () => {
    const docs = await readTrackedMarkdown();
    expect(docs.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const { file, text } of docs) {
      for (const hit of privateLinkHits(text)) offenders.push(`${file}:${hit.line}: ${hit.text.trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});
