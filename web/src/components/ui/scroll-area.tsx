/**
 * The shadcn scroll area, over Radix.
 *
 * WHY A COMPONENT AND NOT `overflow-y-auto`. The message list is the one long scroller in
 * this product that a reader watches grow, and a native bar on macOS is invisible until it
 * moves -- so there is nothing on screen saying "there is more above this". Radix draws a
 * bar that is always there while the content overflows, which is the whole reason to pay
 * for it here and the reason `.shelf-row` in `styles.css` does the opposite (it HIDES its
 * bar; a shelf's overflow is obvious from the half-cut card at the edge).
 *
 * The thumb is `bg-line` rather than shadcn's `bg-border` alias for one reason: this file
 * is read next to the rest of the tree far more often than it is regenerated.
 */

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({
  className,
  children,
  viewportRef,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /**
   * The scrolling element itself.
   *
   * Radix puts a wrapper between the root and the thing that actually scrolls, so a caller
   * that wants to pin the view to the bottom has no way to reach it -- `scrollTop` on the
   * root does nothing. Not in the registry's version because nothing there needed it.
   */
  viewportRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className="size-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-colors",
        orientation === "vertical" && "h-full w-2 border-l border-l-transparent p-px",
        orientation === "horizontal" && "h-2 flex-col border-t border-t-transparent p-px",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-line" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
