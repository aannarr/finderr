/**
 * The frame every facet pane is built in, and the blocks its skeleton is drawn from.
 *
 * ONE component decides whether a pane draws content, reserves space, says a provider
 * broke, or disappears, so the rule is honoured identically by every pane instead of being
 * re-argued in each. A pane supplies its heading, its facet, its placeholder and how to
 * render its data; everything else is here.
 */

import { Fragment, type ReactNode } from "react";
import { paneView, problemNote } from "../lib/facet-panes";
import type { FacetName, FacetProblem, FacetShapes, ResolvedFacets } from "../lib/facets";

/**
 * A grey block standing in for content that has not landed.
 *
 * `className` carries the SIZE, and callers pass the same size their real content uses.
 * A placeholder of the wrong height is the layout shift that makes a fast page feel slow.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-surface-2 ${className ?? ""}`} />;
}

/**
 * Skeleton lines of body text, one per width.
 *
 * Widths are given rather than counted so a paragraph placeholder can be ragged like real
 * text.
 *
 * > [!IMPORTANT] Keyed by INDEX, not by the width string, and the comment here used to say
 * > the opposite
 * > It read "so each line has a name to be keyed by" and used `key={w}` -- which is a
 * > duplicate key the moment a caller repeats a width, and a ragged paragraph naturally
 * > does. The synopsis placeholder passes `["w-full", "w-11/12", "w-full", "w-2/3"]`, so
 * > React logged *"Encountered two children with the same key, `w-full`"* on every render
 * > of every title page -- a warning nobody had connected to this file.
 * >
 * > An index key is CORRECT here for the same reason it is in `SkeletonRepeat` below:
 * > these are interchangeable grey blocks with no identity, in a list that never reorders,
 * > never grows and never has an item removed. The width is a style, and a style is not a
 * > name.
 */
export function SkeletonLines({ widths }: { widths: readonly string[] }) {
  return (
    <div className="space-y-2">
      {widths.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders never reorder; see above
        <Skeleton key={i} className={`h-4 ${w}`} />
      ))}
    </div>
  );
}

/**
 * `count` copies of a placeholder.
 *
 * An index key is correct here and almost nowhere else: these are interchangeable grey
 * blocks with no data identity, and nothing ever reorders or removes one of them.
 */
export function SkeletonRepeat({ count, children }: { count: number; children: ReactNode }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders are interchangeable and never reorder
        <Fragment key={i}>{children}</Fragment>
      ))}
    </>
  );
}

export interface FacetPaneProps<F extends FacetName> {
  /**
   * A node rather than a string, so a pane whose subject IS a destination can link its
   * own heading. The `<h3>` keeps the type: a pane never gets to restyle the heading,
   * only to say what goes in it.
   */
  heading: ReactNode;
  /** Undefined until the first response has landed. */
  facets: ResolvedFacets | undefined;
  facet: F;
  /** Providers have had their turn; a facet still pending is not coming for this view. */
  working: readonly FacetName[] | undefined;
  /**
   * Who failed on this title, by name. The whole title's list, like `working` -- the pane
   * hands it straight to `paneView`, which is the one place that decides whether this
   * facet's failure is one a reader is told about.
   */
  problems?: readonly FacetProblem[];
  /** Sized to the content it replaces. */
  skeleton: ReactNode;
  render: (data: FacetShapes[F]) => ReactNode;
  /**
   * For a pane that draws something OTHER than the facet's own members.
   *
   * `collection` and `related` are the two: the facet names sibling films, but the pane
   * draws index ROWS, because a card needs a poster, library state and a request button
   * that no provider knows. So the facet can be `ready` and non-empty while the pane has
   * nothing to put on screen -- and `paneView` cannot see that, because it is handed the
   * facet and the shortfall lives in a different array entirely.
   *
   * `count` is how many rows the pane can actually draw. `whenNone` is what it says at
   * zero, INSTEAD of drawing a heading over nothing.
   *
   * Reaching here means the provider ANSWERED -- a failure is a `problem` view and returns
   * above this -- so a sentence about our index is honest here and cannot be confused with
   * "the provider broke".
   */
  drawing?: { count: number; whenNone: ReactNode };
  /** Which chrome the section wears; the three-state rule is identical in all of them. */
  variant?: PaneVariant;
}

export function FacetPane<F extends FacetName>({
  heading,
  facets,
  facet,
  working,
  problems,
  skeleton,
  render,
  drawing,
  variant,
}: FacetPaneProps<F>) {
  const view = paneView(facets, facet, working, problems);
  if (view.state === "hidden") return null;

  // A named addon broke. The heading stays so the reader knows WHAT is missing, and the
  // line under it says why -- which is the difference between "no cast" and "the cast did
  // not arrive". Not busy: nothing is in flight, this is the final answer for this view.
  if (view.state === "problem") {
    return (
      <Pane heading={heading} variant={variant}>
        <ProblemNote problems={view.problems} />
      </Pane>
    );
  }

  if (view.state === "skeleton") {
    return (
      <Pane heading={heading} busy variant={variant}>
        {skeleton}
      </Pane>
    );
  }

  // Content, but nothing drawable: say so rather than heading a void. Chosen by aannarr
  // 2026-08-31 over hiding the pane -- "3 of 4" on the collection page already tells the
  // reader what we do not hold, and silence there would be the same gap unexplained.
  if (drawing?.count === 0) {
    return (
      <Pane heading={heading} variant={variant}>
        {drawing.whenNone}
      </Pane>
    );
  }

  return (
    <Pane heading={heading} variant={variant}>
      {render(view.data)}
    </Pane>
  );
}

/**
 * The one line a pane says when its provider failed, wherever that pane is drawn.
 *
 * Exported for the SERIES pane, whose episode half is the body of another pane rather than
 * a pane of its own and so cannot go through `FacetPane` -- but must say the same sentence,
 * in the same words, when its provider dies. The words themselves are `problemNote`'s: this
 * is chrome, and the rule about what may be printed lives with the rest of the pane rules.
 */
export function ProblemNote({ problems }: { problems: readonly FacetProblem[] }) {
  return <p className="text-sm text-muted">{problemNote(problems)}</p>;
}

/**
 * The section chrome, and nothing else: a heading, and whatever goes under it.
 *
 * EXPORTED AGAIN, for `AwardsPane`, and the note it carried is the test that admitted it.
 * It said to export it only for "a second caller that genuinely needs the same `<section>`
 * and `<h3>`", and awards is that caller: it draws a heading over content on the title
 * page exactly as the facet panes do.
 *
 * What makes it legitimate rather than a loophole is WHY it cannot use `FacetPane`. Awards
 * are not a facet. They come from our own imported tables, arrive complete with the title
 * payload, and no provider ever owes them an answer -- so there is no `pending` state, no
 * skeleton to reserve and nothing for `paneView` to decide. Routing them through
 * `FacetPane` would mean inventing a fake `FacetName` for data no plugin provides.
 *
 * That is the same reasoning `LinksRow` used, and the same limit applies: this is CHROME,
 * never an invitation to re-decide the skeleton/content/problem/hidden rule per pane. **Any
 * pane whose visibility depends on a provider still goes through `FacetPane`.**
 *
 * Three variants, all still one `<section>` + `<h3>` so the outline reads the same:
 * - `section`: the default reading-flow chrome.
 * - `rail`: compact, for the facts sidebar -- a tiny uppercase label over a tight block.
 * - `panel`: bordered card chrome, for the one block big enough to earn a frame (seasons).
 */
export type PaneVariant = "section" | "rail" | "panel";

const PANE_CHROME: Record<PaneVariant, { section: string; heading: string }> = {
  section: { section: "mt-8", heading: "mb-3 text-sm font-medium text-ink" },
  rail: {
    section: "mt-4 first:mt-0",
    heading: "mb-1.5 text-[0.7rem] font-medium uppercase tracking-wider text-muted",
  },
  panel: {
    section: "mt-8 rounded-xl border border-line bg-surface p-4 sm:p-5",
    heading: "mb-3 text-sm font-medium text-ink",
  },
};

export function Pane({
  heading,
  busy,
  variant = "section",
  children,
}: {
  heading: ReactNode;
  /** Omitted where nothing is outstanding -- `aria-busy` is then simply absent. */
  busy?: boolean;
  variant?: PaneVariant;
  children: ReactNode;
}) {
  const chrome = PANE_CHROME[variant];
  return (
    <section className={chrome.section} aria-busy={busy}>
      <h3 className={chrome.heading}>{heading}</h3>
      {children}
    </section>
  );
}
