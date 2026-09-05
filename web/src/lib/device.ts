/**
 * Naming the thing a session is open on, from its user agent.
 *
 * Two readers now -- your own `/account` and an admin reading somebody else's page -- which
 * is what earned it one owner. A second copy would drift into two vocabularies for the same
 * fact, and the whole point of the word is that a person can match it to a device they own
 * and end the session they meant to end.
 */

/** Enough of a user agent to tell a phone from a laptop, and no more. */
export function device(ua: string | null): string {
  if (!ua) return "unknown device";
  if (/iPhone|Android.*Mobile/.test(ua)) return "phone";
  if (/iPad|Tablet/.test(ua)) return "tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "browser";
}
