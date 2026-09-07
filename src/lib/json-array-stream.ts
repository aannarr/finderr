/**
 * Read a top-level JSON array off a response body one element at a time, so a huge list
 * never exists as one string and one parsed object at the same moment.
 *
 * ## Why this exists rather than `await res.json()`
 *
 * Radarr's `/api/v3/movie` and Sonarr's `/api/v3/series` answer with EVERYTHING, in one
 * array, and neither can be asked for a page -- measured against the live servers on
 * 2026-09-07: `?page=1&pageSize=10` is accepted, ignored, and answers with the whole library
 * byte for byte (7,627,558 bytes for 1,389 movies either way), and `/movie/paged` is a 404.
 * A parameter that is silently ignored is the worst shape of all, because the call looks like
 * it worked.
 *
 * So the only lever left is HOW we read the one response we are given. `res.json()` holds the
 * whole body as a string AND the whole parsed graph at once, and each arr record is fat --
 * 5.5 KB per movie here, most of it `images`, `alternateTitles` and `ratings` that nothing in
 * the mirror reads. Seerr measured that shape on a 16,451-movie library: 79.7 MiB on the wire,
 * a +335 MB heap step in one sampling interval, and ~450 MB never given back seven hours later
 * (their issue #3307). This walks the body instead, hands the caller one record at a time, and
 * lets each one be projected down to the handful of fields the mirror keeps before the next one
 * is parsed. Peak is then one element plus one chunk, whatever the library's size.
 *
 * ## What it deliberately is NOT
 *
 * Not a JSON parser. Every element is still handed to `JSON.parse`, which is the only thing in
 * here allowed to have an opinion about what JSON means -- this scanner's whole job is finding
 * where one element ends, which needs to know about strings, escapes and nesting and nothing
 * else. Rewriting the value parsing would be a second, worse implementation of a thing the
 * platform already has.
 *
 * Not a general JSONPath reader either: the array has to be the top-level value. Plex nests its
 * list inside a `MediaContainer` and is therefore NOT read through here -- it takes real server
 * pagination instead (`PlexClient.sectionItems`), which is better than streaming when the
 * server offers it.
 */

/** Between elements, these separate rather than belong to anything. */
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * `streamJsonArray` over a response that has not arrived yet.
 *
 * The `Promise<Response>` rather than a `Response` is what lets a caller build the whole
 * pipeline in one expression and still have the request's own failure -- a refused
 * connection, a 401 -- surface from the first `next()` instead of from the call that made it.
 *
 * A response with no body at all is the same failure as one that ends early: something
 * answered, and it was not a library. Saying so beats yielding nothing, because "nothing"
 * reads to every caller here as "your library is empty" and empties a working mirror.
 */
export async function* streamResponseArray<T>(pending: Promise<Response>): AsyncGenerator<T> {
  const res = await pending;
  if (!res.body) throw new SyntaxError("the response held no body to read a JSON array from");
  yield* streamJsonArray<T>(res.body);
}

/**
 * Yield each element of a top-level JSON array as the body arrives.
 *
 * A body that ends before its closing `]` THROWS rather than yielding a short list, and that
 * matters more than it looks: every caller here replaces a mirror wholesale, so a truncated
 * response that parsed as "your library has 40 films in it" would delete the other 1,349. A
 * throw leaves the previous mirror standing, which is the behaviour the callers already have
 * for a connection that fails outright.
 */
export async function* streamJsonArray<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  // Everything read and not yet handed over. It is trimmed after every element, so it holds
  // about one chunk plus the element currently being scanned -- never the whole body.
  let buf = "";
  let cursor = 0; // how far into `buf` the scanner has already looked
  let entered = false; // the opening `[` has been consumed
  let closed = false; // the closing `]` has been consumed
  let start = -1; // where the element under construction begins; -1 means between elements
  let depth = 0; // nesting inside that element; 0 while scanning a scalar one
  let inString = false;
  let escaped = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += value ? decoder.decode(value, { stream: true }) : decoder.decode();

      while (!closed && cursor < buf.length) {
        const ch = buf[cursor] as string;

        if (!entered) {
          if (ch === "[") entered = true;
          else if (!WHITESPACE.has(ch)) {
            throw new SyntaxError(`expected a JSON array, found ${JSON.stringify(ch)}`);
          }
          cursor += 1;
          continue;
        }

        if (start === -1) {
          if (WHITESPACE.has(ch) || ch === ",") {
            cursor += 1;
            continue;
          }
          if (ch === "]") {
            closed = true;
            cursor += 1;
            continue;
          }
          // An element begins here. `ch` is scanned below as its first character.
          start = cursor;
          depth = 0;
        }

        if (escaped) {
          escaped = false;
          cursor += 1;
          continue;
        }
        if (inString) {
          if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          cursor += 1;
          continue;
        }
        if (ch === '"') {
          inString = true;
          cursor += 1;
          continue;
        }
        // A scalar element -- a number, `true`, `false`, `null` -- has no closing bracket to
        // end it, so it ends at the first thing that belongs to the ARRAY instead. That
        // character is left in place for the next pass rather than consumed here.
        if (depth === 0 && (WHITESPACE.has(ch) || ch === "," || ch === "]")) {
          yield JSON.parse(buf.slice(start, cursor)) as T;
          buf = buf.slice(cursor);
          cursor = 0;
          start = -1;
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth += 1;
          cursor += 1;
          continue;
        }
        if (ch === "}" || ch === "]") {
          depth -= 1;
          cursor += 1;
          if (depth === 0) {
            yield JSON.parse(buf.slice(start, cursor)) as T;
            buf = buf.slice(cursor);
            cursor = 0;
            start = -1;
          }
          continue;
        }
        cursor += 1;
      }

      if (closed) return;
      if (done) {
        throw new SyntaxError(
          entered ? "the JSON array ended before its closing bracket" : "the response held no JSON array",
        );
      }
    }
  } finally {
    // A consumer that breaks out of `for await` early lands here, and the socket is still
    // open at that point: without this it stays open until the whole body has drained.
    await reader.cancel().catch(() => {});
  }
}
