/**
 * The headers every HTML response carries. finderr will be internet-facing, and the app
 * ships no inline scripts, no external fonts and no cross-origin fetches (posters and
 * facet images are proxied through our own origin; the only third-party URLs are plain
 * navigations) -- so `'self'` everywhere is a statement of fact, not an aspiration.
 * `style-src` allows inline because Tailwind-driven style ATTRIBUTES fall under it.
 *
 * > [!CAUTION] `media-src blob:` IS WHAT LETS THE PLAYER PLAY AT ALL
 * > hls.js hands the `<video>` element a MediaSource through a `blob:` object URL, and with no
 * > `media-src` the browser falls back to `default-src 'self'`, which refuses it. The element
 * > then reports `error 4` with no request made and nothing wrong server-side -- which is how
 * > playback shipped broken on finderr.frst.dev until 2026-09-15 and was first misdiagnosed as
 * > a codec problem. `worker-src blob:` is hls.js's transmux worker, built the same way.
 */
export const HTML_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
} as const;
