/**
 * Plugin-authored panes: named slots, declarative blocks, and no React anywhere near it.
 *
 * A plugin that has a FACT contributes a facet. A plugin that has something to SAY about a
 * title -- a shape core's vocabulary does not have a name for -- contributes a pane. This is
 * the second extension group, and it lands beside `facets` on the object `init` returns
 * rather than inside it, because slot names and facet names are two namespaces.
 *
 * > [!IMPORTANT] `render` RUNS ON THE SERVER, and that is the whole reason for blocks.
 * > A function cannot be serialised to the browser, and shipping plugin code there is not
 * > something this product will do -- a plugin would then be welded to our React version
 * > forever, and an addon author's bug would take the page down. So `/api/title/:tconst`
 * > calls `render(facets)` over the facets it has ALREADY resolved from local SQLite and
 * > sends the resulting BLOCKS. The client only ever sees data.
 *
 * `render` is SYNCHRONOUS and reads cached facets, so it cannot await, cannot fetch, and
 * cannot make the handler wait on a provider. That is what the signature buys.
 *
 * **It is not a sandbox, and the honest limit is worth stating.** A `render` that loops
 * forever, or calls `readFileSync`/`spawnSync`, blocks the whole event loop -- for every
 * request, not just this one -- and synchronous code cannot be timed out in-process. The
 * `try`/`catch` around it catches a THROW, not a hang. Async would not fix this either: it
 * would invite real I/O on the render path, which is the thing the governing rule exists to
 * forbid, and a proper answer is a worker with its own time budget -- a different weight
 * class, and not built. Loading a plugin is already arbitrary code execution (see
 * `ADDONS.md`), so this adds no capability a plugin did not have at import time; it just
 * does not remove one either.
 *
 * The block vocabulary is deliberately small. It is the smallest set that lets a plugin say
 * something useful without inventing a layout language, and every one of them is a shape the
 * shipped panes already draw. **Images are NOT in it**: an image needs the `/img/f/<key>`
 * proxy (the browser is never handed an upstream URL), so a plugin wanting one needs a facet
 * with a declared image field, which `IMAGE_FIELDS` already handles. Adding an image block
 * would be a second, unguarded route to the same place.
 */

import type { ResolvedFacets } from "./facet-resolver";
import type { FacetName } from "./facets";

/**
 * Where a pane may render.
 *
 * Named positions rather than an index, so a plugin's placement survives core adding or
 * reordering its own panes. `title.after-*` is the useful shape in practice -- a plugin
 * appends below something related rather than fighting for the top of the page.
 */
export const PANE_SLOTS = [
  "title.after-synopsis",
  "title.after-ratings",
  "title.after-cast",
  "title.after-seasons",
  "title.end",
] as const;

export type PaneSlot = (typeof PANE_SLOTS)[number];

export function isPaneSlot(value: string): value is PaneSlot {
  return (PANE_SLOTS as readonly string[]).includes(value);
}

/**
 * One piece of a pane's content.
 *
 * A closed union, checked on the way out of a plugin: an unknown `type` is dropped rather
 * than passed to a client that would not know what to do with it. `href` is same-origin
 * only, enforced at render time -- the browser is never handed an upstream URL, and a
 * plugin is exactly the place that rule would otherwise leak.
 */
export type PaneBlock =
  | { type: "text"; value: string }
  | { type: "chips"; items: string[] }
  | { type: "rows"; rows: { label: string; value: string }[] }
  | { type: "link"; label: string; href: string };

/**
 * Characters the WHATWG URL parser rewrites, and which therefore make a `startsWith`
 * check on an href a lie. See the `link` case in `validBlock` for the measurements.
 *
 * > [!WARNING] NEVER give this pattern the `/g` flag, and the same goes for any guard
 * > regex added beside it.
 * > A module-level regex with `/g` keeps `lastIndex` BETWEEN CALLS when used with
 * > `.test()`: the first call matches and leaves the index past the match, the next call
 * > resumes from there and returns false. A guard written that way admits an attack on
 * > every second invocation, and every test that calls it once passes.
 */
const UNSAFE_HREF_CHARS = /[\\\t\n\r]/;

/** What a plugin declares. `render` is called on the server, with resolved facets. */
export interface PaneDeclaration {
  slot: PaneSlot;
  /** Unique within the plugin. Namespaced by plugin id before it reaches the client. */
  id: string;
  /**
   * Facets that must be `ready` before this pane draws anything.
   *
   * A pane whose needs are unmet is ABSENT, never a skeleton: core's own panes reserve
   * space because core knows how tall they will be, and a plugin's does not. It reappears
   * on the next read once the facet lands, down the same path as any late facet.
   */
  needs: readonly FacetName[];
  render(facets: ResolvedFacets): PaneBlock[];
}

/** A pane after rendering, ready to be JSON. */
export interface RenderedPane {
  slot: PaneSlot;
  /** `<pluginId>:<declaration id>` -- unique across plugins, and says who to blame. */
  id: string;
  blocks: PaneBlock[];
}

/** A declaration plus the plugin that owns it, which is what the registry stores. */
export interface RegisteredPane extends PaneDeclaration {
  pluginId: string;
}

/**
 * Keep only the blocks this host understands and can safely hand to a browser.
 *
 * A plugin is not trusted to have read the spec. An unknown `type`, a missing field, a
 * `chips` array containing a number -- each is dropped individually rather than failing the
 * pane, because half a pane is better than a page-level error and far better than shipping
 * a shape the client will crash on.
 */
function validBlock(block: unknown): block is PaneBlock {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.value === "string" && b.value.length > 0;
    // An EMPTY list is not a block. `paneView` already refuses to draw a core pane for a
    // ready-but-empty facet, and a plugin block should not be the one place an empty list
    // survives as an empty flex row taking up space. It also means a pane whose only block
    // is an empty list disappears entirely, which is the same rule one level up.
    case "chips":
      return (
        Array.isArray(b.items) &&
        b.items.length > 0 &&
        b.items.every((i) => typeof i === "string" && i.length > 0)
      );
    case "rows":
      return (
        Array.isArray(b.rows) &&
        b.rows.length > 0 &&
        b.rows.every(
          (r) =>
            typeof r === "object" &&
            r !== null &&
            typeof (r as Record<string, unknown>).label === "string" &&
            typeof (r as Record<string, unknown>).value === "string",
        )
      );
    case "link":
      // SAME-ORIGIN ONLY. A plugin's link is the obvious place the no-upstream-URL rule
      // would leak, so it is refused here, on the server, rather than trusted to the
      // client guard.
      //
      // > [!CAUTION] A BROWSER DOES NOT COMPARE STRINGS -- it runs the WHATWG URL parser,
      // > and that parser rewrites the input before it means anything.
      // > `startsWith("/") && !startsWith("//")` reads like it pins the origin and does
      // > not. Measured against `https://finderr.example.com/title/tt1375666`, all four of
      // > these passed that check and resolved to `https://evil.com`:
      // >
      // >   /\evil.com/x      -- the parser folds `\` to `/` for http(s), so `/\` IS `//`
      // >   /<TAB>/evil.com/x -- tab, LF and CR are STRIPPED before parsing, so each of
      // >   /<LF>/evil.com/x     these becomes the `//evil.com` case the check does catch,
      // >   /<CR>/evil.com/x     having slipped past it in disguise
      // >
      // > Hence the character class, which is not belt-and-braces: it is the only part
      // > that makes the two `startsWith` tests mean what they appear to mean. Percent
      // > encoding is NOT a third family -- `/%2f/evil.com` stays same-origin, because the
      // > parser does not decode before deciding the authority.
      //
      // `new URL(href, base).origin === base` was the alternative and is not simpler: it
      // catches every case here but accepts `""`, so it needs a length guard anyway, and
      // it hides the rule inside a comparison rather than stating it.
      return (
        typeof b.label === "string" &&
        b.label.length > 0 &&
        typeof b.href === "string" &&
        !UNSAFE_HREF_CHARS.test(b.href) &&
        b.href.startsWith("/") &&
        !b.href.startsWith("//")
      );
    default:
      return false;
  }
}

/**
 * Render every declared pane against the facets we hold. Pure, and never throws.
 *
 * Called on the render path, so it must not be able to make it slow or fatal. Three ways a
 * pane produces nothing, all of them quiet:
 *
 *   - a `needs` facet is not `ready` -- the answer is not in yet, so there is nothing to say
 *   - `render` THROWS -- an addon bug takes out its own pane and nothing else. It is logged,
 *     because a silently missing pane is indistinguishable from a plugin that meant to say
 *     nothing, and the author needs to be able to tell those apart
 *   - it returns no valid blocks -- same rule core panes follow for a ready-but-empty facet
 */
export function renderPanes(
  panes: readonly RegisteredPane[],
  facets: ResolvedFacets,
  log: (message: string) => void = () => {},
): RenderedPane[] {
  const out: RenderedPane[] = [];

  for (const pane of panes) {
    if (!pane.needs.every((f) => facets[f]?.status === "ready")) continue;

    let blocks: PaneBlock[];
    try {
      blocks = pane.render(facets).filter(validBlock);
    } catch (err) {
      log(`plugin ${pane.pluginId}: pane '${pane.id}' threw -- ${(err as Error).message}`);
      continue;
    }

    if (blocks.length > 0) out.push({ slot: pane.slot, id: `${pane.pluginId}:${pane.id}`, blocks });
  }

  return out;
}
