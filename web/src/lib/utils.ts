/**
 * `cn` -- the class merger every `components/ui/*` file is written against.
 *
 * This is shadcn's own helper, verbatim, and it lives at the path `components.json` names
 * (`@/lib/utils`) so anything added later with `shadcn add` lands beside the components
 * already here instead of bringing a second copy of it.
 *
 * WHY IT IS NOT `[a, b].join(" ")`, which is what the rest of this tree does. Those call
 * sites build a class list from conditions they own; a `ui` component takes a `className`
 * from a CALLER that wants to override what the variant already set. `twMerge` is what
 * makes `<Button variant="ghost" className="text-danger">` actually red rather than two
 * colour utilities fighting over source order -- the later-defined one wins in CSS, and
 * which that is depends on Tailwind's output order rather than on the caller's intent.
 *
 * It understands finderr's palette without being told: the `@theme` names in `styles.css`
 * are real Tailwind colour utilities, so `bg-surface` and `bg-accent` land in one conflict
 * group and the caller's wins.
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
