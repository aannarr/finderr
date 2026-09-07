/**
 * One shelf on the arranging screen: its name, a grip to drag it by, two arrows and Hide.
 *
 * Split out of `ShelfArrangement.tsx` when the drag landed, because a row now owns real
 * behaviour rather than being markup in a `map`: two `useEffect`s wiring the drag adapter to
 * its own element, and two pieces of state that exist only while a pointer is down. Leaving
 * that inline would have put a hook inside a loop, which React forbids for good reason.
 *
 * ## WHY THE ARROWS STAY -- and it is Atlassian's own finding, not a hedge
 *
 * `@atlaskit/pragmatic-drag-and-drop` has no keyboard drag mode, and their accessibility
 * guidelines say why that is the right shape: user testing found an explicit MOVE CONTROL
 * beats directional keyboard-drag for reordering, because a keyboard drag makes the reader
 * hold "where am I now" in their head across a stream of arrow presses that look identical.
 * So the grip is the POINTER affordance and the arrows are the keyboard one, and neither is a
 * lesser path. A drag-only implementation would have no keyboard story at all; the arrows
 * shipped first and are tested, so the drag was added OVER them exactly as this screen's
 * original doc comment predicted.
 *
 * ## THE GRIP IS THE HANDLE, NOT THE WHOLE ROW
 *
 * The row carries three other controls. Making the whole row draggable puts a drag gesture in
 * competition with three click targets, and the failure is silent -- a press that was meant
 * for Hide becomes a two-pixel drag and nothing happens. `dragHandle` scopes the gesture to
 * the grip; the row is still the DROP target, because a target the size of a grip is a target
 * nobody can hit.
 *
 * ## WHY THIS CANNOT RE-BREAK BACK NAVIGATION
 *
 * Nothing here windows, virtualises, or gives an element a height its content does not have.
 * The list renders every row at its real size and the drop indicator is a `::before` overlay
 * on a row that is already laid out, so `document.scrollHeight` stays honest at every instant
 * -- which is the standing requirement in this repo since `content-visibility` was measured
 * to break TanStack's scroll restore (see the ban in `web/src/styles.css`).
 */

import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  attachClosestEdge,
  type Edge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { GripVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ShelfChoiceView } from "../lib/api";
import type { ShelfMove } from "../lib/shelf-arrangement";
import { LINK_BUTTON } from "../lib/ui";

/**
 * What a dragged row carries, and the KEY is what makes it ours.
 *
 * `monitorForElements` is global -- it sees every drag on the page, including one started by
 * a future draggable somewhere else entirely. A drop is only ours if its payload carries this
 * symbol, so `shelfRowData`/`isShelfRowData` are the pair that asks, and no monitor anywhere
 * has to reason about what else might be dragging.
 */
const SHELF_ROW = Symbol("shelf-row");

/*
  A `type` AND NOT AN `interface`, and the difference is load-bearing rather than stylistic.
  The adapter takes `Record<string, unknown>`, and TypeScript gives a type alias an implicit
  index signature while an interface gets none -- so the interface form fails to assign with
  "Index signature for type 'string' is missing", on all three call sites at once. Measured,
  because the error names the missing signature rather than the declaration keyword.
*/
export type ShelfRowData = {
  [SHELF_ROW]: true;
  shelfId: string;
};

export function shelfRowData(shelfId: string): ShelfRowData {
  return { [SHELF_ROW]: true, shelfId };
}

export function isShelfRowData(data: Record<string | symbol, unknown>): data is ShelfRowData {
  return data[SHELF_ROW] === true;
}

/** Which edge of a row the pointer is nearest, or null when this row is not the target. */
type DropEdge = Edge | null;

export function ShelfRow({
  shelf,
  index,
  total,
  onMove,
  onToggle,
}: {
  shelf: ShelfChoiceView;
  index: number;
  total: number;
  onMove: (direction: ShelfMove) => void;
  onToggle: () => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  /** True while THIS row is the one being dragged. Drives the row's own dimming. */
  const [dragging, setDragging] = useState(false);
  /** Where the dragged row would land relative to this one, or null. Drives the indicator. */
  const [edge, setEdge] = useState<DropEdge>(null);

  useEffect(() => {
    const row = rowRef.current;
    const grip = gripRef.current;
    if (!row || !grip) return;

    return combine(
      draggable({
        element: row,
        // SCOPED TO THE GRIP. See the header: the row's other three controls are click
        // targets, and a whole-row draggable turns a mis-aimed press into a silent no-op.
        dragHandle: grip,
        getInitialData: () => shelfRowData(shelf.id),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: row,
        // Only shelf rows. A drop from anywhere else on the page is not ours to interpret.
        canDrop: ({ source }) => isShelfRowData(source.data) && source.data.shelfId !== shelf.id,
        getData: ({ input, element }) =>
          attachClosestEdge(shelfRowData(shelf.id), {
            input,
            element,
            allowedEdges: ["top", "bottom"],
          }),
        onDrag: ({ self }) => setEdge(extractClosestEdge(self.data)),
        onDragLeave: () => setEdge(null),
        onDrop: () => setEdge(null),
      }),
    );
  }, [shelf.id]);

  return (
    <li
      ref={rowRef}
      /*
        `relative` is for the drop indicator below, which is an absolutely positioned child
        rather than a border: a border would change the row's height mid-drag and shove every
        row under it by a pixel, which is exactly the jitter a drop indicator exists to avoid.
      */
      className={`relative flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2 transition-opacity ${
        dragging ? "opacity-40" : ""
      }`}
    >
      {edge && <DropIndicator edge={edge} />}

      <span className="flex min-w-0 items-center gap-2">
        <button
          ref={gripRef}
          type="button"
          /*
            A BUTTON RATHER THAN A BARE `<span>`, and it is not decorative. It is in the tab
            order and it is where the drag starts, so a pointer reader finds it by hovering and
            a screen reader is told what it is for. It has no `onClick` because pressing it does
            nothing -- the arrows beside it are the keyboard path, which is what the label says.
          */
          aria-label={`Drag ${shelf.title} to reorder, or use the arrow buttons`}
          className="-ml-1 shrink-0 cursor-grab rounded p-1 text-muted hover:text-ink active:cursor-grabbing"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
        <span className={`min-w-0 truncate text-sm${shelf.hidden ? " text-muted" : ""}`}>
          {shelf.title}
          {shelf.hidden && <span className="text-muted"> · hidden</span>}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-3">
        <MoveButton shelf={shelf} direction="up" atEnd={index === 0} onMove={() => onMove("up")} />
        <MoveButton
          shelf={shelf}
          direction="down"
          atEnd={index === total - 1}
          onMove={() => onMove("down")}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${shelf.hidden ? "Show" : "Hide"} ${shelf.title}`}
          className={LINK_BUTTON}
        >
          {shelf.hidden ? "Show" : "Hide"}
        </button>
      </span>
    </li>
  );
}

/**
 * The line showing where the row would land.
 *
 * `absolute` and `aria-hidden`: it occupies no space, so nothing under it moves while the
 * pointer travels, and it says nothing to a screen reader because the live region in
 * `ShelfArrangement` already announces the result of a move in words.
 */
function DropIndicator({ edge }: { edge: Edge }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-accent ${
        edge === "top" ? "-top-1" : "-bottom-1"
      }`}
    />
  );
}

/**
 * One arrow, which stays pressable at the end of the list.
 *
 * `aria-disabled` and NOT `disabled`, deliberately: a `disabled` button is dropped from the tab
 * order the instant it becomes disabled, so moving a shelf to the top would blow focus back to
 * `<body>` and strand a keyboard reader halfway through arranging their page. Announcing the
 * state and making the press a no-op keeps the caret where the reader left it.
 */
function MoveButton({
  shelf,
  direction,
  atEnd,
  onMove,
}: {
  shelf: ShelfChoiceView;
  direction: ShelfMove;
  /** Is this shelf already as far this way as it goes? */
  atEnd: boolean;
  onMove: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onMove}
      aria-disabled={atEnd}
      aria-label={`Move ${shelf.title} ${direction}`}
      className={`text-sm ${atEnd ? "text-line" : "text-muted hover:text-ink"}`}
    >
      <span aria-hidden="true">{direction === "up" ? "↑" : "↓"}</span>
    </button>
  );
}
