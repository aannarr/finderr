/**
 * The shadcn button, retuned to finderr's palette.
 *
 * > [!IMPORTANT] shadcn is the SUBSTRATE here, not a new visual direction
 * > The API is the registry's -- `variant`, `size`, `asChild`, `cva`, `cn` -- so anything
 * > added later with `shadcn add` composes with it and reads the same. The CLASSES are
 * > finderr's: `bg-accent text-black` is lifted from `RequestAction`, `border-line
 * > bg-surface` from `ToggleChip`, `rounded-lg` from the header controls. Where a shadcn
 * > default fought what was already on screen, what was already on screen won.
 *
 * > [!NOTE] THREE REGISTRY COMPONENTS ARE DELIBERATELY ABSENT, because this tree owns them
 * > `badge` -> `CHIP_PILL`/`InertChip` (`../Chip.tsx`) is the same pill, already shared by
 * > five surfaces. `card` -> `Pane variant="panel"` (`../FacetPane.tsx`) is the same
 * > bordered box. `skeleton` -> `Skeleton` (`../FacetPane.tsx`), which callers already size
 * > to the content it replaces. Adding the registry's version of any of them would be a
 * > second copy that drifts on the next restyle, which is the one rule in this repo that
 * > outranks matching a convention.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // `focus-visible` and never `focus`: every other control in this app rings only for a
  // keyboard, and a ring appearing under the mouse reads as a stuck state.
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-black hover:opacity-90 active:opacity-75",
        secondary: "bg-surface-2 text-ink hover:bg-line",
        outline: "border border-line bg-surface text-muted hover:border-muted hover:text-ink",
        ghost: "text-muted hover:bg-surface-2 hover:text-ink",
        destructive: "border border-danger/50 bg-danger/10 text-ink hover:bg-danger/20",
        // The quiet inline action, and it reads the SAME string `AccountRoute` and
        // `AdminRoute` already share rather than restating it here.
        link: "underline underline-offset-4 text-muted hover:text-ink",
      },
      size: {
        default: "h-9 px-3 py-2",
        sm: "h-7 rounded-md px-2 text-xs",
        lg: "h-11 px-5",
        // Square, for a control whose label is its glyph. It still needs an `aria-label`;
        // nothing here can supply one.
        icon: "size-9 [&_svg]:size-4",
        "icon-sm": "size-7 rounded-md [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a `<button>`, keeping the classes. A `<Link>`. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
