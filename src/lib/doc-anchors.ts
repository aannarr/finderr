/**
 * WHERE A MARKDOWN LINK POINTS -- the one extractor every doc hygiene check reads links
 * through -- plus whether an intra-document anchor lands on a heading that exists.
 *
 * `README.md` is the public face of a public repo, read by a stranger with no other source,
 * and the other gates are structurally blind to it: a link to a heading somebody renamed two
 * commits ago typechecks, lints and passes the whole suite. This module is the floor under
 * that -- it catches the RENAMED HEADING, the failure that arrives on its own as a file is
 * edited.
 *
 * Extraction lives here and only here. Every one of these checks has to be right about a
 * `#` or a `](` inside a fenced block, and `proseLines` is the single answer to "where does
 * a fence start and end" -- a second copy of that walker would get a fix this one did not.
 * `src/lib/doc-links.ts` resolves the FILE half of a link against the tree and reuses
 * `documentLinks` and `headingSlugs` to do it.
 *
 * It does NOT catch a link that resolves and still promises something its target does not
 * say (`See [Why](#why) for who may make one`, where `## Why` is about Seerr being slow).
 * That is a claim about a target's CONTENT and no parser can read it -- see the reasoning
 * recorded on the card that built this, `src/lib/doc-anchors.test.ts` names it.
 *
 * The slug rule is GitHub's, reproduced rather than guessed at, because GitHub is where
 * these documents are actually read.
 */

/**
 * One link, split into the halves that are checked separately: the `path` a reader would
 * navigate to (empty for a bare fragment, and left case-sensitive because targets are), and
 * the `anchor` within it (empty when there is none, `#lowercased` when there is). `line` is
 * 1-based and `text` is the source line, so a failure can name where to look.
 */
export type DocLink = { line: number; path: string; anchor: string; text: string };

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

// `](target)` and `](<target>)`, either with an optional `"title"`, plus the reference
// definition form `[label]: target`. One pair for every link, whatever it points at:
// a second pattern for the file-carrying forms would be a second answer to the same question.
const INLINE_LINK = /\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
const LINK_DEFINITION = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/;

/** Every link in `markdown`, outside fenced blocks, decoded, in document order. */
export function documentLinks(markdown: string): DocLink[] {
  const links: DocLink[] = [];
  for (const { line, text } of proseLines(markdown)) {
    for (const [, target] of text.matchAll(INLINE_LINK)) links.push({ line, ...splitTarget(target), text });
    const defined = text.match(LINK_DEFINITION)?.[1];
    if (defined) links.push({ line, ...splitTarget(defined), text });
  }
  return links;
}

/**
 * `path#anchor` into its halves. Percent escapes are decoded on both -- `#caf%C3%A9` and
 * `#café` are the same target -- but only the anchor is lowercased: GitHub's fragments are
 * case-insensitive and its paths are not.
 */
function splitTarget(target: string): { path: string; anchor: string } {
  const hash = target.indexOf("#");
  if (hash < 0) return { path: decodePercent(target), anchor: "" };
  return {
    path: decodePercent(target.slice(0, hash)),
    anchor: decodePercent(target.slice(hash)).toLowerCase(),
  };
}

function decodePercent(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** Every intra-document anchor link: a bare `#fragment`, pointing at this file's own headings. */
export function anchorLinks(markdown: string): DocLink[] {
  return documentLinks(markdown).filter(({ path, anchor }) => path === "" && anchor !== "");
}

/**
 * Every fragment a link may legally target in `markdown`, in the `#slug` form a `DocLink`
 * carries -- so a caller compares targets rather than re-deriving the `#`.
 */
export function headingTargets(markdown: string): Set<string> {
  return new Set(headingSlugs(markdown).map((slug) => `#${slug}`));
}

/** The anchor links in `markdown` that no heading in it answers. */
export function unresolvedAnchors(markdown: string): DocLink[] {
  const targets = headingTargets(markdown);
  return anchorLinks(markdown).filter(({ anchor }) => !targets.has(anchor));
}
