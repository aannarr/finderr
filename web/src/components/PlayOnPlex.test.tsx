/**
 * The Play control, on both of the surfaces that draw it.
 *
 * What is worth pinning is that a VARIANT changes the size and nothing else: the moment one
 * of them drops the app link or renames a label, the two screens are telling a reader
 * different things about the same title, which is exactly what sharing the component was
 * meant to prevent.
 *
 * `plex://` NOT OPENING IN A TAB is the other one. It is a scheme handler, not a
 * destination -- `target="_blank"` leaves an empty tab behind on every machine where it
 * works, and there is nothing to see in it on the machines where it does not.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlexLinks } from "../lib/api";
import { PlayOnPlex, type PlayOnPlexVariant } from "./PlayOnPlex";

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

const VARIANTS: PlayOnPlexVariant[] = ["block", "inline"];

describe("the play control", () => {
  test("every variant offers both addresses and the same words", () => {
    for (const variant of VARIANTS) {
      const html = renderToStaticMarkup(<PlayOnPlex plex={PLEX} variant={variant} />);
      expect(html).toContain(PLEX.web);
      expect(html).toContain(APP_PREFIX);
      expect(html).toContain("Play on Plex");
      expect(html).toContain("Open in the Plex app");
    }
  });

  test("the app link never opens a tab, on any variant", () => {
    for (const variant of VARIANTS) {
      const html = renderToStaticMarkup(<PlayOnPlex plex={PLEX} variant={variant} />);
      // The app link is the last element, so everything from its href on IS its own tag.
      expect(html.slice(html.indexOf(`href="${APP_PREFIX}`))).not.toContain("target=");
    }
  });

  test("the web link opens away from finderr, safely", () => {
    const html = renderToStaticMarkup(<PlayOnPlex plex={PLEX} />);
    expect(html).toContain('rel="noreferrer"');
  });
});
