/**
 * The Play control on a `/requests` row.
 *
 * `plex://` NOT OPENING IN A TAB is the property worth pinning. It is a scheme handler, not a
 * destination -- `target="_blank"` leaves an empty tab behind on every machine where it
 * works, and there is nothing to see in it on the machines where it does not.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlexLinks } from "../lib/api";
import { PlayOnPlex } from "./PlayOnPlex";

const PLEX: PlexLinks = {
  web: "https://app.plex.tv/desktop#!/server/abc/details?key=%2Flibrary%2Fmetadata%2F42",
  app: "plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F42&server=abc",
};

/**
 * The app link up to its first `&`.
 *
 * React escapes an ampersand in an attribute to `&amp;`, so asserting the whole URL would
 * be asserting HTML escaping rather than the link -- and would go red the day a template
 * gained a second parameter. The scheme and the metadata key are the parts that matter.
 */
const APP_PREFIX = PLEX.app.split("&")[0] ?? "";

describe("the play control", () => {
  test("offers both addresses", () => {
    const html = renderToStaticMarkup(<PlayOnPlex plex={PLEX} />);
    expect(html).toContain(PLEX.web);
    expect(html).toContain(APP_PREFIX);
    expect(html).toContain("Play on Plex");
    expect(html).toContain("Open in the Plex app");
  });

  test("the app link never opens a tab", () => {
    const html = renderToStaticMarkup(<PlayOnPlex plex={PLEX} />);
    // The app link is the last element, so everything from its href on IS its own tag.
    expect(html.slice(html.indexOf(`href="${APP_PREFIX}`))).not.toContain("target=");
  });

  test("the web link opens away from finderr, safely", () => {
    const html = renderToStaticMarkup(<PlayOnPlex plex={PLEX} />);
    expect(html).toContain('rel="noreferrer"');
  });
});
