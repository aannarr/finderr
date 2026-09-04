/**
 * Markdown, as React elements.
 *
 * > [!CAUTION] THERE IS NO `dangerouslySetInnerHTML` IN THIS FILE AND THERE MUST NEVER BE
 * > What is rendered here is MODEL OUTPUT carrying whatever a tool result put in front of
 * > it -- a title, a synopsis, an episode name, any of which a stranger wrote and none of
 * > which we control. Elements make the injection class impossible rather than merely
 * > filtered: there is no string of HTML anywhere on this path, so there is no sanitiser to
 * > be one bug away from getting wrong. `../lib/markdown.ts` produces the tree and says the
 * > same thing at greater length.
 *
 * The two guards this file owns, and they are opposites for the reason `facet-panes.ts`
 * gives: a LINK is supposed to leave, so `externalHref` checks the SCHEME and
 * `javascript:` does not survive it; an IMAGE may only load from our own origin, so
 * `localImageUrl` checks that instead. Neither guard is re-implemented here -- both already
 * exist and a second copy would drift from the one the title page uses.
 *
 * Every failed guard falls back to TEXT rather than to nothing. A link we will not follow
 * still had words in it, and dropping them would silently delete part of an answer.
 */

import { externalHref, localImageUrl } from "../lib/facet-panes";
import type { Block, Inline } from "../lib/markdown";
import { parseMarkdown } from "../lib/markdown";

/**
 * Render a markdown string.
 *
 * `className` reaches the wrapper rather than each block, so a caller sizes the whole answer
 * once instead of restyling six element types.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;
  return (
    <div className={`space-y-2 text-sm leading-relaxed ${className ?? ""}`}>
      {blocks.map((b, i) => (
        // An index key is correct here for the same reason it is in `SkeletonLines`: the
        // list is positional and has no identity of its own. It is also the RIGHT key while
        // a stream is arriving -- a growing answer re-parses on every token, and position is
        // exactly what stays stable as the last block gets longer.
        // biome-ignore lint/suspicious/noArrayIndexKey: markdown blocks are positional and never reorder
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

/**
 * Heading levels are pushed down two, so an answer's `#` cannot outrank the panel's own
 * `<h2>Assistant</h2>` and break the document outline a screen reader navigates by.
 */
function headingTag(level: number): "h3" | "h4" | "h5" | "h6" {
  if (level <= 1) return "h3";
  if (level === 2) return "h4";
  if (level === 3) return "h5";
  return "h6";
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-base font-semibold tracking-tight",
  2: "text-sm font-semibold tracking-tight",
  3: "text-sm font-medium",
};

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      const Tag = headingTag(block.level);
      return (
        <Tag className={`mt-1 ${HEADING_CLASS[Math.min(block.level, 3)] ?? HEADING_CLASS[3]}`}>
          <InlineList nodes={block.children} />
        </Tag>
      );
    }

    case "paragraph":
      // `whitespace-pre-line` keeps the line breaks the model typed, which is what the
      // plain-text bubble did before markdown existed. Collapsing them would reflow every
      // answer already on screen as the price of adding bold text.
      return (
        <p className="whitespace-pre-line">
          <InlineList nodes={block.children} />
        </p>
      );

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`ml-1 space-y-0.5 pl-4 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional and never reorder
            <li key={i} className="marker:text-muted">
              <InlineList nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }

    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[0.75rem] leading-relaxed">
          {/* The language is kept in the tree and deliberately not drawn: there is no
              highlighter here, so a label would announce a feature that does not exist. */}
          <code>{block.text}</code>
        </pre>
      );

    case "quote":
      return (
        <blockquote className="border-l-2 border-line pl-2.5 text-muted italic">
          <InlineList nodes={block.children} />
        </blockquote>
      );

    case "rule":
      return <hr className="border-line" />;
  }
}

function InlineList({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional; see Markdown
        <InlineView key={i} node={n} />
      ))}
    </>
  );
}

function InlineView({ node }: { node: Inline }) {
  switch (node.type) {
    case "text":
      return <>{node.text}</>;

    case "strong":
      return (
        <strong className="font-semibold">
          <InlineList nodes={node.children} />
        </strong>
      );

    case "em":
      return (
        <em>
          <InlineList nodes={node.children} />
        </em>
      );

    case "code":
      return <code className="rounded bg-surface-2 px-1 py-px text-[0.85em] break-all">{node.text}</code>;

    case "link": {
      const href = externalHref(node.href);
      // Refused -- a relative path, a `javascript:` URL, anything that is not http(s). The
      // words stay and stop being a link, which is the honest maximum: deleting them would
      // remove part of the answer to punish the address.
      if (!href) return <InlineList nodes={node.children} />;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-ink"
        >
          <InlineList nodes={node.children} />
        </a>
      );
    }

    case "image": {
      const src = localImageUrl(node.src);
      // An `<img>` may only load from OUR origin: the browser fetching a provider's CDN is
      // both a leak and a request it could not make from outside. A refused image renders
      // its alt text, so the reader is told something was there.
      if (!src) return <>{node.alt}</>;
      return <img src={src} alt={node.alt} className="max-w-full rounded-lg" />;
    }
  }
}
