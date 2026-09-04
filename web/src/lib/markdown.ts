/**
 * Markdown, parsed to a tree. NEVER to a string of HTML.
 *
 * aannarr asked for markdown in the assistant's answers and in the composer that writes to
 * it. This file is the half that decides what the text MEANS; `../components/Markdown.tsx`
 * is the half that draws it, and it draws React elements.
 *
 * > [!CAUTION] THE OUTPUT SHAPE IS THE SECURITY PROPERTY, AND A SANITISER IS NOT A SUBSTITUTE
 * > This parses MODEL OUTPUT, which carries whatever a tool result put in front of it -- a
 * > title, a synopsis, an episode name, any of which a stranger wrote. That is an injection
 * > path. Producing an AST and rendering it as elements makes the whole class impossible:
 * > there is no code path from this file to `innerHTML`, so there is nothing for a
 * > sanitiser to be one bug away from getting wrong. `Bun.markdown` returns HTML and is
 * > therefore the wrong tool here, whatever else it is good for.
 * >
 * > The two node types that still carry a URL are guarded at RENDER time and not here:
 * > `link` through `externalHref` (`javascript:` must not survive) and `image` through
 * > `localImageUrl` (an `<img>` may only load from our own origin). This file's job is to
 * > say "that was a link"; the component's job is to decide whether it may be one.
 *
 * HAND-ROLLED, and `package.json` was checked first: there is no markdown dependency in
 * this tree and adding one to render bold text in a chat panel would be a dependency, a
 * bundle, and a second thing to keep in step with React. The subset is exactly what
 * aannarr named -- bold, italic, lists, headings, inline code, fenced blocks, links -- plus
 * blockquotes and rules, which a model emits unprompted and which cost three lines each.
 *
 * Everything here is pure: a string in, a tree out, no DOM.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; src: string; alt: string }
  /**
   * A resolved `Name [tt…]` mention, put here by `linkMentionsInInlines` AFTER parsing.
   *
   * The parser never produces one -- it is a post-pass over the tree, which is the only
   * correct place for it: rewriting the raw string first would rewrite ids inside code spans
   * and hand the parser unbalanced emphasis markers. See `./mentions.ts`.
   */
  | { type: "mention"; id: string; label: string; path: string; entity: "title" | "person" };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-\s*-\s*-[\s-]*|\*\s*\*\s*\*[\s*]*|_\s*_\s*_[\s_]*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Does this line begin a block that a paragraph or a list item must not swallow? */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/**
 * Text to blocks.
 *
 * Line-oriented rather than a full CommonMark parse, which is the right size for this: the
 * input is a chat answer, not a document, and every construct below is one a model actually
 * emits. Nesting is deliberately NOT supported -- a list inside a list inside a quote is a
 * shape nothing in this panel needs and a great deal of the complexity a real parser carries.
 */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body: string[] = [];
      i += 1;
      // An UNTERMINATED fence is still a code block, and that matters more here than
      // anywhere: while a stream is arriving the closing fence has not been typed yet, and
      // rendering the opening one as literal backticks would flash three characters of
      // punctuation on screen before the block appeared.
      while (i < lines.length && !(FENCE.test(lines[i]) && lines[i].trim().startsWith(marker))) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", lang: fence[2] || null, text: body.join("\n") });
      continue;
    }

    // Before the bullet check: `---` is a rule and `- x` is a list, and only the space
    // after the marker tells them apart.
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1]];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i]);
        if (!next) break;
        body.push(next[1]);
        i += 1;
      }
      blocks.push({ type: "quote", children: parseInline(body.join("\n").trim()) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = ordered !== null;
      const items: string[] = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = ORDERED.exec(lines[i]);
        if (b || o) {
          // A run ENDS when the marker kind changes, so "1. a" under "- a" starts a second
          // list rather than being renumbered into the first.
          if ((o !== null) !== isOrdered) break;
          items.push((b ?? o)?.[3] ?? "");
          i += 1;
          continue;
        }
        // A lazy continuation: an unmarked, non-blank line that starts no other block joins
        // the item above it, which is how a wrapped bullet arrives from a model.
        if (items.length > 0 && lines[i].trim() !== "" && !startsBlock(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered: isOrdered, items: items.map(parseInline) });
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    /*
      Paragraph lines are joined with a NEWLINE, not a space, and the renderer preserves it.

      CommonMark collapses a single newline and this deliberately does not. The text being
      rendered is a chat answer that used to be drawn in a `whitespace-pre-wrap` paragraph,
      where every line the model typed appeared where it typed it -- collapsing them now
      would silently reflow every existing answer as the price of adding bold text.
    */
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }

  return blocks;
}

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!>~|".split(""));

/**
 * One run of text to inline nodes.
 *
 * A left-to-right scanner rather than a chain of regular expressions, because the
 * constructs nest (`**bold [link](x)**`) and because a code span must win against
 * everything inside it -- `` `**not bold**` `` is four literal characters and two asterisks,
 * which no amount of ordering regexes gets right.
 *
 * Anything that fails to close is TEXT. A half-typed `**bold` mid-stream must render as the
 * characters that arrived, not swallow the rest of the answer into a strong tag that never
 * ends.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) out.push({ type: "text", text: buf });
    buf = "";
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "\\" && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      // A run of N backticks is closed by the next run of exactly N, which is what lets a
      // code span contain a backtick.
      let n = 0;
      while (src[i + n] === "`") n += 1;
      const close = findFenceRun(src, i + n, n);
      if (close !== -1) {
        flush();
        out.push({ type: "code", text: src.slice(i + n, close).trim() });
        i = close + n;
        continue;
      }
      buf += src.slice(i, i + n);
      i += n;
      continue;
    }

    if (c === "!" && src[i + 1] === "[") {
      const parsed = parseBracketed(src, i + 1);
      if (parsed) {
        flush();
        out.push({ type: "image", src: parsed.dest, alt: parsed.label });
        i = parsed.end;
        continue;
      }
    }

    if (c === "[") {
      const parsed = parseBracketed(src, i);
      if (parsed) {
        flush();
        out.push({ type: "link", href: parsed.dest, children: parseInline(parsed.label) });
        i = parsed.end;
        continue;
      }
    }

    if ((c === "*" || c === "_") && canOpenEmphasis(src, i)) {
      const double = src[i + 1] === c;
      const delim = double ? c + c : c;
      const close = findDelimiter(src, i + delim.length, delim, c);
      if (close !== -1 && close > i + delim.length) {
        flush();
        const children = parseInline(src.slice(i + delim.length, close));
        out.push(double ? { type: "strong", children } : { type: "em", children });
        i = close + delim.length;
        continue;
      }
    }

    buf += c;
    i += 1;
  }

  flush();
  return out;
}

/** The next run of EXACTLY `n` backticks at or after `from`, or -1. */
function findFenceRun(src: string, from: number, n: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] !== "`") continue;
    let run = 0;
    while (src[i + run] === "`") run += 1;
    if (run === n) return i;
    i += run - 1;
  }
  return -1;
}

/**
 * `_` MUST NOT OPEN EMPHASIS INSIDE A WORD, and this panel is exactly where that bites.
 *
 * Every tool this assistant calls is named `find_title`, `list_episodes`, `min_rating`. An
 * intraword `_` treated as emphasis turns `list_episodes` into "list" + italic nothing, and
 * the reader is shown a mangled identifier in the one place identifiers are the content.
 * `*` has no such rule because nothing writes `a*b` and means it literally.
 */
function canOpenEmphasis(src: string, i: number): boolean {
  if (src[i] !== "_") return true;
  const before = src[i - 1];
  return before === undefined || !/[\w]/.test(before);
}

/** The closing delimiter for an emphasis run, honouring the same intraword rule. */
function findDelimiter(src: string, from: number, delim: string, ch: string): number {
  for (let i = from; i <= src.length - delim.length; i++) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (!src.startsWith(delim, i)) continue;
    // A closing `_` may not sit inside a word either, for the same reason.
    if (ch === "_" && /[\w]/.test(src[i + delim.length] ?? "")) continue;
    // For a single-char delimiter, a doubled one belongs to a strong run rather than
    // closing this emphasis.
    if (delim.length === 1 && src[i + 1] === ch) continue;
    return i;
  }
  return -1;
}

/**
 * `[label](destination)` starting at the `[`, or null when it does not close.
 *
 * Both halves count depth: a label may contain brackets and a URL may contain parentheses,
 * which Wikipedia addresses do constantly.
 */
function parseBracketed(src: string, start: number): { label: string; dest: string; end: number } | null {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === "[") depth += 1;
    else if (src[i] === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[i + 1] !== "(") return null;
  const label = src.slice(start + 1, i);

  let paren = 0;
  let j = i + 1;
  for (; j < src.length; j++) {
    if (src[j] === "\\") {
      j += 1;
      continue;
    }
    if (src[j] === "(") paren += 1;
    else if (src[j] === ")") {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  if (paren !== 0) return null;
  // A title -- `(url "Some title")` -- is dropped rather than rendered: it becomes a
  // tooltip nobody asked for, over a link whose text already says where it goes.
  const dest =
    src
      .slice(i + 2, j)
      .trim()
      .split(/\s+/)[0] ?? "";
  return { label, dest, end: j + 1 };
}

/**
 * Would rendering this as markdown look any different from rendering it as plain text?
 *
 * The composer's preview appears only when the answer is yes, which is what makes it
 * deliberate rather than decorative: a reader typing an ordinary sentence sees nothing new,
 * and a reader typing `**bold**` is shown what that will become before they spend a turn on
 * it. Pure, so the rule is a test rather than a judgement about a screenshot.
 */
export function isRichMarkdown(src: string): boolean {
  const blocks = parseMarkdown(src);
  if (blocks.length === 0) return false;
  if (blocks.length > 1 || blocks[0].type !== "paragraph") return true;
  return blocks[0].children.some((n) => n.type !== "text");
}
