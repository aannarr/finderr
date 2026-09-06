/**
 * The one control that puts a title on your list, and takes it off again.
 *
 * A TOGGLE, declared as one: `aria-pressed` carries the state, so a screen reader is told
 * "Watchlist, pressed" rather than being handed two buttons that swap places under it. The
 * two tones differ in SIZE and nothing else -- `icon` sits beside Request in a card footer
 * where there is room for a glyph, `block` is the labelled button the title page draws, and
 * they share this file for the reason `RequestAction` gives for sharing its own: a second
 * copy would have drifted on the first change to what the two states are called.
 *
 * > [!IMPORTANT] SAVING IS NOT REQUESTING, and the card footer is where that has to be
 * > obvious
 * > Pressing this writes one row and calls no arr. It spends no quota, starts no search and
 * > downloads nothing -- Request, right next to it, is still the only control in this product
 * > that does. That is why the two sit side by side at different weights rather than one
 * > replacing the other: a reader has to be able to see which one costs the household disk.
 *
 * The mutation is optimistic and lives in `lib/watchlist.ts`; this component owns only the
 * words, the shape, and what a failure sounds like.
 */

import { Bookmark } from "lucide-react";
import { useState } from "react";
import type { Title } from "../lib/api";
import { useToasts } from "../lib/toasts";
import { saveTitle, unsaveTitle, useIsSaved } from "../lib/watchlist";

/** `icon` is a square beside a card's Request button; `block` fills the title page's column. */
export type SaveTone = "icon" | "block";

const SHELL: Record<SaveTone, string> = {
  icon: "flex shrink-0 items-center justify-center rounded-lg border px-2 text-xs",
  block: "mt-2 flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm",
};

/**
 * A saved title is marked in the ACCENT the product already uses for "this one is yours" --
 * the same colour the In-library badge carries -- so the two states differ by more than a
 * filled shape, which is the only version of this that works for a reader who cannot tell
 * the outlines apart.
 */
const STATE_CLASS: Record<"saved" | "unsaved", string> = {
  saved: "border-accent/60 text-accent",
  unsaved: "border-line text-muted hover:border-ink hover:text-ink",
};

export function SaveToWatchlist({ title, tone = "icon" }: { title: Title; tone?: SaveTone }) {
  const saved = useIsSaved(title.tconst);
  const toasts = useToasts();
  /*
    The lock is not about the OPTIMISM -- the list has already flipped -- it is about the
    round trip. Without it a double-click sends a save and a remove that can land in either
    order, and the row that survives is decided by the network rather than by the reader.
  */
  const [busy, setBusy] = useState(false);

  const label = saved ? "On your watchlist" : "Add to watchlist";

  async function toggle() {
    setBusy(true);
    try {
      if (saved) await unsaveTitle(title.tconst);
      else await saveTitle(title);
    } catch (err) {
      /*
        The store has already put the list back, so this toast is the only thing that says
        so. Pushed and resolved in one go: there is nothing to watch, only an outcome, and
        an error toast stays until the reader dismisses it.
      */
      const id = toasts.push(saved ? `Removing ${title.title}` : `Saving ${title.title}`);
      toasts.resolve(id, "error", (err as Error).message, () => void toggle());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={saved}
      // The visible text already says it in `block`; in `icon` the glyph is all there is, so
      // the accessible name has to name the film as well as the action.
      aria-label={tone === "icon" ? `${label}: ${title.title}` : undefined}
      title={tone === "icon" ? label : undefined}
      className={`${SHELL[tone]} ${STATE_CLASS[saved ? "saved" : "unsaved"]}
                  transition disabled:opacity-60`}
    >
      <Bookmark className="size-4 shrink-0" aria-hidden="true" fill={saved ? "currentColor" : "none"} />
      {tone === "block" && <span>{label}</span>}
    </button>
  );
}
