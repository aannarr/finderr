/**
 * Share this page through the device's own sheet -- Messages, Mail, AirDrop, whatever the
 * reader has -- and nothing at all where the browser has no sheet.
 *
 * A square glyph button in the same outline as `SaveToWatchlist`'s card tone, because it sits
 * beside that control on the title page and the two are the same kind of thing: something a
 * reader does for THEMSELVES, which asks the server for nothing. The link unfurls as a real
 * card because the Open Graph preview already answers for `/title/` and `/person/` paths.
 *
 * The rules about when a sheet exists and what address goes into it live in `lib/share.ts`.
 */

import { Share } from "lucide-react";
import { useState } from "react";
import { canShareLinks, shareLink, shareUrl } from "../lib/share";
import { useToasts } from "../lib/toasts";

interface ShareButtonProps {
  /** What the page is about, for the accessible name: "Share Heat". */
  name: string;
  /** The title handed to the sheet, which may carry more than the name (a year). */
  shareAs: string;
  /** This page's path, e.g. `/title/tt0113277`. */
  path: string;
  className?: string;
}

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
    setBusy(true);
    try {
      await shareLink({ title: shareAs, url: shareUrl(path) });
    } catch (err) {
      const id = toasts.push(`Sharing ${name}`);
      toasts.resolve(id, "error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void share()}
      // A second press while the sheet is up is refused by the browser with InvalidStateError.
      disabled={busy}
      aria-label={`Share ${name}`}
      title="Share"
      className={`flex shrink-0 items-center justify-center rounded-lg border border-line px-3 text-muted
                  transition hover:border-ink hover:text-ink disabled:opacity-60 ${className}`}
    >
      <Share className="size-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
