/**
 * The shadcn textarea, wearing the search box's chrome.
 *
 * Same border, same radius and the same `focus:border-accent/60` the header's input uses,
 * because a second text-entry look in one product is a second thing to keep in step.
 *
 * NO `text-sm` HERE, and that is not an oversight: `styles.css` floors every `textarea` at
 * 16px unlayered, precisely so a utility cannot reintroduce iOS's focus zoom. Writing one
 * would be a class that does nothing on a phone and shrinks the control everywhere else.
 */

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-ink outline-none placeholder:text-muted focus:border-accent/60 disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
