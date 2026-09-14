import { describe, expect, test } from "bun:test";
import { HTML_HEADERS } from "./html-headers";

/** The policy as a map of directive -> sources. */
function directives(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of HTML_HEADERS["Content-Security-Policy"].split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

describe("the content security policy", () => {
  /**
   * REGRESSION, tt37209937 on Safari 2026-09-15: `media element error 4` on every title. hls.js
   * attaches a MediaSource through a `blob:` object URL, and with no `media-src` the policy
   * fell back to `default-src 'self'`, which refuses it -- so no MSE playback could ever start,
   * in any browser, whatever the codec.
   */
  test("lets the player attach a MediaSource through a blob: URL", () => {
    expect(directives().get("media-src")).toEqual(["'self'", "blob:"]);
  });

  /** hls.js transmuxes in a worker it builds from a blob; without this it falls back to the main thread. */
  test("lets hls.js start its worker from a blob: URL", () => {
    expect(directives().get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  test("still refuses everything else from anywhere but our own origin", () => {
    const d = directives();
    expect(d.get("default-src")).toEqual(["'self'"]);
    expect(d.get("script-src")).toEqual(["'self'"]);
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
  });
});
