/**
 * Share this page through the device's own sheet -- Messages, Mail, AirDrop, whatever the
 * reader has -- and nothing at all where the browser has no sheet.
 *
 * A square glyph button in the same outline as `SaveToWatchlist`, because it sits beside that
 * control on the title page and the two are the same kind of thing: something a reader does
 * for THEMSELVES, which asks the server for nothing. The link unfurls as a real card because
 * the Open Graph preview already answers for `/title/` and `/person/` paths.
 *
 * The rules about when a sheet exists and what address goes into it live in `lib/share.ts`.
 */

import { Share } from "lucide-react";
import { useState } from "react";
import { canShareLinks, shareLink, shareUrl } from "../lib/share";
import { useToasts } from "../lib/toasts";
import { FOCUS_RING, OUTLINE_TONE } from "../lib/ui";

interface ShareButtonProps {
  /** What the page is about, for the accessible name: "Share Heat". */
  name: string;
  /** The title handed to the sheet, which may carry more than the name (a year). */
  shareAs: string;
  /** This page's path, e.g. `/title/tt0113277`. */
  path: string;
  className?: string;
}

/** What a reader is told when the sheet will not open. The browser's own message stays in the console. */
export const SHARE_FAILED = "Couldn't open the share sheet.";

export function ShareButton(props: ShareButtonProps) {
  // Asked once per mount: whether a browser has a sheet does not change while a page is open.
  const [available] = useState(() => canShareLinks());
  /*
    The gate is its own component so a page with no sheet touches nothing else -- in
    particular not `useToasts`, which throws outside a provider and would take down a static
    render of a header that was never going to draw this button.
  */
  return available ? <ShareControl {...props} /> : null;
}

function ShareControl({ name, shareAs, path, className = "" }: ShareButtonProps) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);

  async function share() {
    // A second press while the sheet is up is refused by the browser with InvalidStateError.
    if (busy) return;
    setBusy(true);
    try {
      await shareLink({ title: shareAs, url: shareUrl(path) });
    } catch (err) {
      /*
        "Failed to execute 'share' on 'Navigator': Must be handling a user gesture" is a fact
        for a developer, so it goes to the console and the reader gets one plain sentence.
      */
      console.warn("share failed", err);
      const id = toasts.push(`Sharing ${name}`);
      toasts.resolve(id, "error", SHARE_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void share()}
      /*
        `aria-disabled` rather than `disabled`: disabling the focused element drops keyboard
        focus to the body, so a keyboard reader would come back from the sheet at the top of
        the page. The guard in `share()` is what actually refuses the second press.
      */
      aria-disabled={busy}
      aria-label={`Share ${name}`}
      title="Share"
      className={`flex shrink-0 items-center justify-center rounded-lg border px-3 transition
                  aria-disabled:opacity-60 ${OUTLINE_TONE} ${FOCUS_RING} ${className}`}
    >
      <Share className="size-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
