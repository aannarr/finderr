/**
 * The single owner of what an untrusted value is ALLOWED TO BE.
 *
 * Every bound in this file was read off the corpus or off a measurement, never guessed --
 * the numbers are in `LIMITS` with the measurement that produced each one. Nothing here
 * decides POLICY about who may call; that is `withAuth` and `RateLimiter`. This decides
 * only what a value may look like once somebody is allowed to send one.
 *
 * > [!CAUTION] MEASURED 2026-09-07 on the M1 Max against the real 1.27M-row index: ONE
 * > 22 KB search query costs 26,631 ms of single-threaded CPU
 * > `?q=` had no length cap at all. `matchExpr` turns each token into `"tok"*` and joins
 * > them with ` OR `, so a 3,200-token query asks FTS5 to union 3,200 prefix postings
 * > lists, and the cost is roughly QUADRATIC in the token count:
 * >
 * > | tokens | chars | search() |
 * > |---|---|---|
 * > | 100 | 699 | 85.6 ms |
 * > | 400 | 2,799 | 556.0 ms |
 * > | 1,600 | 11,199 | 8,008.8 ms |
 * > | 3,200 | 22,399 | **26,631.0 ms** |
 * >
 * > 32x the tokens for 311x the time. A plain-word query of the same length is LINEAR
 * > (100 -> 3.4 ms, 3,200 -> 94.4 ms), so the blowup belongs to the OR expression rather
 * > than to length as such -- which is why the cap that matters is on TOKENS and the
 * > character cap is only the cheap outer fence.
 * >
 * > Six concurrent requests of that shape occupy every core on the box for the better part
 * > of a minute, and the search limiter counts REQUESTS, so all six are within their
 * > budget. That is the whole reason this file exists.
 *
 * **REFUSE, NEVER TRUNCATE.** A truncated query answers a question nobody asked and a
 * truncated name stores something the reader did not type, both silently. `parseClickBody`
 * already set this rule for the tuning log -- refuse what you do not recognise rather than
 * storing a coerced version of it -- and it generalises. The one exception is the invisible
 * and direction-controlling characters below, which are STRIPPED: nobody typed them on
 * purpose and refusing a paste from a word processor over a soft hyphen is hostile.
 */

/**
 * Every bound, with the measurement that chose it.
 *
 * They are all deliberately GENEROUS against real data -- the job is to make a hostile
 * payload impossible, not to police a long film title. Where a bound has a corpus number
 * behind it, the headroom over that number is stated.
 */
export const LIMITS = {
  /**
   * A search query.
   *
   * Measured on the real index 2026-09-07: across every title at `votes >= 1000` the
   * LONGEST is 20 tokens / 104 characters ("DanMachi: Is It Wrong to Try to Pick Up Girls
   * in a Dungeon? On the Side - Sword Oratoria"), p99.99 is 17 tokens, and the median is 2.
   * The longest canary case is 6 tokens / 35 characters. So 32 tokens is 1.6x the longest
   * title that exists and 200 characters is 1.9x -- no human query can reach either, and
   * the 3,200-token payload above is refused 100x over.
   */
  queryChars: 200,
  queryTokens: 32,

  /**
   * The whole request URL, checked as a raw string before anything parses it.
   *
   * This is the CHEAP OUTER FENCE and it is deliberately not per-parameter: bounding the
   * whole URL bounds every parameter, every parameter NAME and the parameter COUNT at once,
   * for the cost of reading `.length` on a string that already exists. A per-parameter walk
   * would mean parsing a `URL` on every request including the ones that never look at the
   * query string, which is a cost on the render path the fourth rule does not permit.
   *
   * 2,048 is the practical ceiling browsers have enforced for two decades, and finderr's
   * own longest generated URL is a browse page with five filters -- under 200.
   */
  url: 2048,

  /** A free-text field somebody stores: an invite note, an agent-key label. */
  text: 500,
  /** A display name. Long enough for any real name in any script, short enough to render. */
  name: 100,
  /**
   * One assistant turn.
   *
   * The AI spend gate (`aiGate`) already bounds the MONEY, so this bounds the thing the
   * spend gate cannot see: a single 256 KB message is one call the budget check waves
   * through before discovering what it cost. 8,000 characters is a long paragraph of
   * genuine question and about 2,000 tokens.
   */
  message: 8000,
  /** An opaque id we echo back or key a map on -- a conversation id, a token, a slug. */
  id: 64,
  /**
   * A browser-supplied `User-Agent`, as STORED and later RENDERED.
   *
   * It is a header rather than a body field, which is exactly why it gets forgotten: nobody
   * thinks of a header as user input, and this one is written into a session row and a push
   * subscription and then drawn on the account page as "which device is this". A header is
   * as attacker-controlled as any JSON field and this one is displayed, so it takes the same
   * sanitizing as a display name.
   *
   * 300 rather than `name`'s 100: real user agents are genuinely long (Chrome on Android is
   * around 130) and this string is never something a person chose.
   */
  userAgent: 300,
  /**
   * A Web Push `p256dh` or `auth` key, base64url.
   *
   * They are fixed-size in practice -- 87 and 22 characters -- but they are somebody else's
   * format rather than ours, so the bound is generous and its job is only to stop an
   * unbounded string reaching the database.
   */
  pushKey: 200,
  /** How many items a client may put in one array field. */
  listItems: 200,
  /**
   * A filesystem path reported by an arr, before we try to open it.
   *
   * It is not typed by a human, which is exactly why it needs a bound: it arrives over HTTP
   * from Radarr or Sonarr and the fifth rule does not care that the sender is usually
   * friendly. 4,096 is `PATH_MAX` on Linux, so a path past it cannot name a real file on the
   * machine the arr is describing -- refusing it is strictly correct rather than cautious.
   *
   * The bound is the CHEAP half and it is not the guard. `mapMediaPath` (`media-path.ts`)
   * decides whether a path may be opened at all, and it is an ALLOW-LIST rather than a
   * length check.
   */
  mediaPath: 4096,
  /**
   * How many combining marks may stack on ONE base character.
   *
   * Unicode's own stream-safe format (UAX #15) uses 30. Real text never approaches it:
   * Vietnamese and Thai peak at 2-3. Past this the string is a rendering attack ("Zalgo"),
   * which overflows its line box and can cover the rest of the page.
   */
  combiningRun: 8,
} as const;

/** Why a value was refused. A CODE, so a caller can decide what to say about it. */
export type RefusalReason = "too-long" | "too-many" | "wrong-type" | "empty";

export type Guarded<T> = { ok: true; value: T } | { ok: false; reason: RefusalReason; limit?: number };

const refuse = (reason: RefusalReason, limit?: number): Guarded<never> => ({ ok: false, reason, limit });

/**
 * Characters that are removed from any text before it is stored or matched.
 *
 * WRITTEN AS ESCAPE SEQUENCES AND BUILT WITH `new RegExp`, deliberately: every character in
 * here is invisible by definition, so a regex literal containing them is a line no reviewer
 * can read and no diff can show. The escapes are the documentation.
 *
 * Three families, and each is a real attack rather than tidiness:
 *
 *  - **C0 and C1 controls.** A NUL terminates a C string, so a value SQLite stores happily
 *    can be truncated by something downstream that does not; an ESC in a value that reaches
 *    a terminal log is an ANSI escape sequence somebody else's terminal will execute. Tab
 *    and newline are stripped with the rest -- no field guarded here wants either, and a
 *    newline in a display name is a log-injection primitive.
 *  - **Bidi overrides and isolates** (U+202A-202E, U+2066-2069). U+202E RIGHT-TO-LEFT
 *    OVERRIDE is the classic display spoof: a display name carrying one renders reversed,
 *    so an admin reading the user list sees a name that is not the one stored. Same trick
 *    as the `exe.txt` filename spoof, and it works in every browser.
 *  - **Zero-width and invisible formatting** (U+200B-200F, U+2060-2064, U+FEFF). A name
 *    made only of these is a row with no visible content; two names differing only by one
 *    are indistinguishable on screen and distinct in the database.
 *
 * U+00AD SOFT HYPHEN is deliberately NOT here: it is ordinary in text pasted out of a word
 * processor and it renders as nothing harmful.
 */
// biome-ignore lint/complexity/useRegexLiterals: a literal here would contain the invisible characters themselves -- see above
const INVISIBLE_OR_SPOOFING = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]",
  "gu",
);

/**
 * Combining marks, for the stacking check. The same blocks `normalize.ts` strips, plus the
 * three later ones a Zalgo generator actually reaches for.
 */
// biome-ignore lint/complexity/useRegexLiterals: same reason as INVISIBLE_OR_SPOOFING above
const COMBINING = new RegExp(
  "[\\u0300-\\u036F\\u0483-\\u0489\\u1AB0-\\u1AFF\\u1DC0-\\u1DFF\\u20D0-\\u20F0\\uFE20-\\uFE2F]",
  "u",
);

/**
 * Strip what nobody typed on purpose, and fold to one canonical form.
 *
 * NFC rather than NFKD: this is text a human will READ BACK, so a ligature must survive as
 * the character they typed. `normalize.ts` does the aggressive NFKD fold, and that is for
 * MATCHING, where losing the distinction is the goal. Two different jobs, two normal forms
 * -- do not collapse them.
 *
 * Composing FIRST matters: it turns a legitimate "e + combining acute" into a single "é",
 * so the stacking check below counts only marks that genuinely could not compose away.
 */
export function sanitizeText(raw: string): string {
  return raw.normalize("NFC").replace(INVISIBLE_OR_SPOOFING, "").trim();
}

/**
 * Is this a rendering attack -- more than `LIMITS.combiningRun` marks on one base?
 *
 * Counted as a RUN rather than as a total, because a long sentence in Vietnamese has many
 * marks and no run longer than about three. A total would refuse the sentence and admit a
 * short Zalgo string.
 */
export function hasMarkStack(s: string, max: number = LIMITS.combiningRun): boolean {
  let run = 0;
  for (const ch of s) {
    if (COMBINING.test(ch)) {
      run += 1;
      if (run > max) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/**
 * A string off the wire, bounded and cleaned. The workhorse.
 *
 * Length is measured in CODE POINTS (`[...s].length`), not UTF-16 units, so an emoji costs
 * one and a name in an astral script is not refused for being written in it. Both are still
 * bounded in bytes, because a code point is at most 4 of them.
 *
 * `allowEmpty: false` (the default) reports an empty value as a refusal rather than as an
 * empty string, so a caller distinguishes "not sent" from "sent as blank" without a second
 * check at every call site.
 */
export function boundedText(v: unknown, max: number, opts: { allowEmpty?: boolean } = {}): Guarded<string> {
  if (typeof v !== "string") return refuse("wrong-type");
  const clean = sanitizeText(v);
  if (clean === "") return opts.allowEmpty ? { ok: true, value: "" } : refuse("empty");
  if ([...clean].length > max) return refuse("too-long", max);
  if (hasMarkStack(clean)) return refuse("too-long", LIMITS.combiningRun);
  return { ok: true, value: clean };
}

/**
 * A search query: bounded in characters AND in tokens, and the token bound is the one that
 * defends the index.
 *
 * Tokens are counted on WHITESPACE rather than on `normalize()`'s alphabet, because the
 * point is to refuse BEFORE doing work and normalizing a hostile string is work. That
 * under-counts -- `normalize` turns punctuation into spaces, so `a.b.c` is one token here
 * and three there -- which is exactly why the character cap is not redundant: 200
 * characters cannot become more than 100 normalized tokens whatever the punctuation, and
 * 100 tokens measured at 85.6 ms rather than 26 seconds. The two bounds together are what
 * make the worst case affordable; neither alone does.
 */
export function boundedQuery(v: unknown): Guarded<string> {
  const text = boundedText(v, LIMITS.queryChars, { allowEmpty: true });
  if (!text.ok) return text;
  if (text.value === "") return { ok: true, value: "" };
  const tokens = text.value.split(/\s+/).filter(Boolean);
  if (tokens.length > LIMITS.queryTokens) return refuse("too-many", LIMITS.queryTokens);
  return { ok: true, value: text.value };
}

/**
 * A whole number in a range, or the fallback.
 *
 * Returns a VALUE rather than a `Guarded`, because every existing caller reads a malformed
 * number as "not sent" and that is the right reading for a tuning parameter: `?limit=abc`
 * is a broken client, not an attack, and refusing the page over it helps nobody. What
 * matters is that no such value ever reaches a `LIMIT` clause unclamped.
 */
export function clampInt(
  v: unknown,
  opts: { min: number; max: number; fallback?: number },
): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, Math.trunc(n)));
}

/**
 * An array off the wire, bounded in length, with every item guarded.
 *
 * The whole list is refused when any item is, rather than the bad items being dropped: a
 * partially accepted list is a request that half happened, which is the worst answer
 * available to a caller trying to work out what went wrong.
 */
export function boundedList<T>(
  v: unknown,
  item: (x: unknown) => Guarded<T>,
  max: number = LIMITS.listItems,
): Guarded<T[]> {
  if (!Array.isArray(v)) return refuse("wrong-type");
  if (v.length > max) return refuse("too-many", max);
  const out: T[] = [];
  for (const x of v) {
    const g = item(x);
    if (!g.ok) return g;
    out.push(g.value);
  }
  return { ok: true, value: out };
}

/**
 * A header, bounded and sanitized, or `null`.
 *
 * > [!IMPORTANT] A HEADER IS USER INPUT, and it is the kind that gets forgotten
 * > Nothing about `req.headers.get("user-agent")` looks like a form field, so it does not
 * > read as untrusted -- and finderr STORES that one on a session row and a push
 * > subscription and then DRAWS it on the account page as "which device is this". An
 * > attacker controls it completely. Unbounded and unsanitized it is a wall of text in
 * > somebody's device list, or a right-to-left override making one device impersonate
 * > another in the one UI a reader uses to revoke access.
 *
 * `null` rather than a refusal, because a header is not a field the caller can be told to
 * fix and no request should fail over one: the device row simply records nothing.
 */
export function boundedHeader(v: string | null | undefined, max: number): string | null {
  if (typeof v !== "string") return null;
  const g = boundedText(v, max);
  return g.ok ? g.value : null;
}

/**
 * Is the raw request URL within `LIMITS.url`?
 *
 * A STRING LENGTH CHECK ON A STRING THAT ALREADY EXISTS -- no `URL` is constructed, nothing
 * is decoded, nothing is allocated. That is what lets this sit in front of every route
 * including the ones that never read a query parameter. See `LIMITS.url` for why bounding
 * the whole URL is preferred to walking the parameters.
 */
export function urlWithinBounds(url: string): boolean {
  return url.length <= LIMITS.url;
}

/**
 * The one sentence a refusal is allowed to say.
 *
 * It names the LIMIT and never the value. Echoing the offending input back is how a
 * reflected payload gets into a log, an error toast or a screenshot, and the caller
 * already has the value they sent.
 */
export function refusalMessage(field: string, g: { reason: RefusalReason; limit?: number }): string {
  switch (g.reason) {
    case "too-long":
      return `${field} is too long (limit ${g.limit})`;
    case "too-many":
      return `${field} has too many items (limit ${g.limit})`;
    case "empty":
      return `${field} is required`;
    default:
      return `${field} has the wrong type`;
  }
}
