/**
 * The native share sheet, and the one address a shared page goes out under.
 *
 * **Offered only where the browser has a sheet of its own.** There is no fallback: a
 * copy-to-clipboard button wearing a share icon is a different control that happens to look
 * the same, and a reader who presses it expecting their contacts gets a silent clipboard.
 * `navigator.share` also needs a secure context, so a plain-http LAN address hides the button
 * with no rule of ours -- the same way the passkey buttons hide there.
 *
 * **The path carries NO trailing slash, deliberately.** `PREVIEW_PATH` and
 * `PREVIEW_PERSON_PATH` (`src/server/preview-resolver.ts`) are anchored with `$`, so
 * `/title/tt0113277/` is not a preview path: a chat client unfurling it would be handed the
 * sign-in shell and draw the word "finderr" beside a favicon, which is the failure the preview
 * page exists to prevent. The address shared is the one the preview answers.
 */

/** What goes into the sheet. No `text`: Messages prints the text AND the link, so it reads twice. */
export interface SharePayload {
  title: string;
  url: string;
}

/**
 * Whether this browser can open a share sheet for a link.
 *
 * `canShare` is asked where it exists because a browser may expose `share` and still refuse a
 * payload shape; where it does not exist, a function-valued `share` is the whole evidence.
 */
export function canShareLinks(nav: Navigator | undefined = globalThis.navigator): boolean {
  if (!nav || typeof nav.share !== "function") return false;
  if (typeof nav.canShare !== "function") return true;
  return nav.canShare({ url: "https://example.com/" });
}

/** The page's own address on this origin, in the one shape the preview page recognises. */
export function shareUrl(path: string, origin: string = globalThis.location.origin): string {
  return `${origin}${path}`;
}

/** "Heat (1995)" when there is a year, the bare name when there is not. */
export function shareTitle(name: string, year?: number | null): string {
  return year ? `${name} (${year})` : name;
}

/**
 * Open the sheet. Resolves quietly when the reader dismisses it -- closing a share sheet is a
 * decision, not an error -- and rethrows anything else so the caller can say so.
 */
export async function shareLink(payload: SharePayload, nav: Navigator = globalThis.navigator): Promise<void> {
  try {
    await nav.share(payload);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw err;
  }
}
