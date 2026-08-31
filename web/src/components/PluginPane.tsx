/**
 * A pane a plugin wrote, drawn from blocks.
 *
 * The client half of the pane registry, and deliberately the dumb half: the server already
 * ran the plugin's `render`, validated every block and dropped anything it did not
 * recognise, so this file only maps a closed union onto the elements the rest of the page
 * already uses. **No plugin code runs in the browser** -- an addon cannot reach the DOM,
 * cannot depend on our React version, and cannot take the page down.
 *
 * It reuses the shipped furniture rather than inventing a second look: the same `<section>`
 * and `<h3>` shape `FacetPane` draws, and `ToggleChip`'s inactive styling for chips. A
 * plugin pane that looked foreign would be worse than no plugin panes -- the point is that
 * a reader cannot tell which panes core wrote.
 */

import type { PaneBlock, RenderedPane } from "../lib/api";

/**
 * One block. An unknown `type` renders NOTHING rather than throwing.
 *
 * The server already refuses unknown blocks, so this is the second of two guards and it
 * exists for the version skew case: a client cached from an older build meeting a newer
 * server, where a block type it has never heard of is a blank space rather than a crash.
 */
function Block({ block }: { block: PaneBlock }) {
  switch (block.type) {
    case "text":
      return <p className="text-sm leading-relaxed text-muted">{block.value}</p>;

    case "chips":
      return (
        <div className="flex flex-wrap gap-1.5">
          {block.items.map((item) => (
            <span
              key={item}
              className="shrink-0 rounded-full border border-line px-2.5 py-1 text-xs text-muted"
            >
              {item}
            </span>
          ))}
        </div>
      );

    case "rows":
      return (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {block.rows.map((row) => (
            <div key={`${row.label}|${row.value}`} className="contents">
              <dt className="text-muted">{row.label}</dt>
              <dd className="text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>
      );

    case "link":
      // Same-origin only, and the server enforced it. A plain <a> rather than a router
      // Link: a plugin's href is an arbitrary path this app may not have a route for, and
      // a full navigation degrades to a 404 page instead of a blank router error.
      return (
        <a
          href={block.href}
          className="text-sm text-muted underline decoration-line underline-offset-2 hover:text-ink"
        >
          {block.label}
        </a>
      );

    default:
      return null;
  }
}

/**
 * Every plugin pane declared for one slot.
 *
 * Renders nothing at all when the list is empty, which is the ordinary case -- a slot with
 * no plugin panes must not leave a gap in the page, so there is no wrapper element either.
 */
export function PluginPanes({ panes }: { panes: RenderedPane[] }) {
  if (panes.length === 0) return null;

  return (
    <>
      {panes.map((pane) => (
        <section key={pane.id} className="mt-6">
          <div className="space-y-2">
            {pane.blocks.map((block, i) => (
              // Index is the honest key here: blocks are positional within a pane, carry no
              // id, and two identical blocks in one pane are a legitimate thing to write.
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and have no id
              <Block key={i} block={block} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** The panes declared for one slot, in the order the plugins loaded. */
export function panesForSlot(panes: RenderedPane[] | undefined, slot: string): RenderedPane[] {
  return (panes ?? []).filter((p) => p.slot === slot);
}
