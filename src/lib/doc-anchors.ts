/**
 * Intra-document anchor links, and whether they land on a heading that exists.
 *
 * `README.md` is the public face of a public repo, read by a stranger with no other source,
 * and the other gates are structurally blind to it: a link to a heading somebody renamed two
 * commits ago typechecks, lints and passes the whole suite. This module is the floor under
 * that -- it catches the RENAMED HEADING, the failure that arrives on its own as a file is
 * edited.
 *
 * It does NOT catch a link that resolves and still promises something its target does not
 * say (`See [Why](#why) for who may make one`, where `## Why` is about Seerr being slow).
 * That is a claim about a target's CONTENT and no parser can read it -- see the reasoning
 * recorded on the card that built this, `src/lib/doc-anchors.test.ts` names it.
 *
 * The slug rule is GitHub's, reproduced rather than guessed at, because GitHub is where
 * these documents are actually read.
 */

/** One anchor link, with the source line it was found on (1-based) and that line's text. */
export type DocAnchor = { line: number; anchor: string; text: string };

/** One line of a document, 1-based, as `proseLines` hands it on. */
type SourceLine = { line: number; text: string };

/**
 * GitHub's heading-to-fragment rule: render the inline markdown away, lowercase, drop
 * everything that is not a letter, number, space, hyphen or underscore, then spaces to
 * hyphens. Duplicate titles are disambiguated by the caller, not here.
 */
export function slugifyHeading(title: string): string {
  return stripInlineMarkdown(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, "")
    .replace(/ /g, "-");
}

/** Heading text as a reader sees it: link text without its target, no emphasis, no code ticks. */
function stripInlineMarkdown(title: string): string {
  return (
    title
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
      .replace(/[`*~]/g, "")
      // Underscores only where they are EMPHASIS. An intraword underscore is not emphasis in
      // GFM and survives into the slug, which matters here: this README heads sections with
      // `FINDERR_NO_AUTH` and friends, and eating those underscores breaks live links.
      .replace(/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, "$1")
      .trim()
  );
}

/**
 * Lines outside fenced code blocks, 1-based. A `#` inside a fence is a shell comment or a
 * YAML key, never a heading, and `README.md` contains both.
 */
function proseLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let fence: string | null = null;
  markdown.split("\n").forEach((text, i) => {
    const opener = text.match(/^\s{0,3}(```+|~~~+)/)?.[1];
    if (fence) {
      // A fence closes on a run of the same character at least as long as the one that opened it.
      if (opener?.startsWith(fence[0]) && opener.length >= fence.length) fence = null;
      return;
    }
    if (opener) {
      fence = opener;
      return;
    }
    lines.push({ line: i + 1, text });
  });
  return lines;
}

/**
 * Every fragment a link in this document could legally target, in document order, with
 * GitHub's `-1`/`-2` suffix applied to repeated titles.
 */
export function headingSlugs(markdown: string): string[] {
  const seen = new Map<string, number>();
  const slugs: string[] = [];
  for (const { text } of proseLines(markdown)) {
    const title = text.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/)?.[1];
    if (title === undefined) continue;
    const base = slugifyHeading(title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.push(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

// `](#frag)` and `](<#frag>)`, plus the reference definition form `[label]: #frag`.
const ANCHOR_LINK = /\]\(\s*<?(#[^)>\s]+)>?\s*\)/g;
const ANCHOR_DEFINITION = /^\s*\[[^\]]+\]:\s*<?(#\S+?)>?\s*$/;

/** Every intra-document anchor link, decoded, in document order. */
export function anchorLinks(markdown: string): DocAnchor[] {
  const links: DocAnchor[] = [];
  for (const { line, text } of proseLines(markdown)) {
    for (const [, anchor] of text.matchAll(ANCHOR_LINK))
      links.push({ line, anchor: decodeAnchor(anchor), text });
    const defined = text.match(ANCHOR_DEFINITION)?.[1];
    if (defined) links.push({ line, anchor: decodeAnchor(defined), text });
  }
  return links;
}

/** `#caf%C3%A9` and `#café` are the same target; compare them decoded. */
function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor).toLowerCase();
  } catch {
    return anchor.toLowerCase();
  }
}

/** The anchor links in `markdown` that no heading in it answers. */
export function unresolvedAnchors(markdown: string): DocAnchor[] {
  const targets = new Set(headingSlugs(markdown).map((slug) => `#${slug}`));
  return anchorLinks(markdown).filter(({ anchor }) => !targets.has(anchor));
}
