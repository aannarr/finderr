/**
 * Server-sent events, framed. Knows nothing about finderr.
 *
 * A `text/event-stream` body arrives as arbitrary byte chunks and a frame boundary lands
 * wherever the network decided -- mid-field, mid-word, mid-`\r\n`. So the parser is a state
 * machine over a carry buffer rather than a `split("\n\n")`, which is the shape that looks
 * right until the first slow answer arrives in two packets and one frame is silently lost.
 *
 * Pure and DOM-free on purpose: a `ReadableStream` is not needed to prove that a `data:`
 * split across three chunks reassembles, and that is the only property here worth defending.
 *
 * > [!IMPORTANT] The spec's rules that actually bite, all three implemented here
 * > 1. **One leading space after the colon is stripped, and only one.** `data: {"n":1}`
 * >    and `data:{"n":1}` are the same frame; `data:  x` carries a leading space.
 * > 2. **Repeated `data:` lines join with `\n`**, which is how a multi-line payload travels.
 * >    Dropping all but the last is the classic truncation bug.
 * > 3. **A line starting with `:` is a comment** -- heartbeats are sent as bare `:` lines to
 *      hold a proxy open, and reading one as data would hand the caller an empty event.
 */

export interface SseFrame {
  /** The `event:` field, or `"message"` where the stream sent none, as the spec says. */
  event: string;
  /** Every `data:` line of the frame, joined with newlines. */
  data: string;
}

export interface SseParser {
  /** Feed decoded text. Returns every COMPLETE frame the chunk finished. */
  push(chunk: string): SseFrame[];
  /**
   * The stream ended.
   *
   * A final frame with no trailing blank line is still a frame -- a server that closes the
   * socket straight after `event: done` is not malformed, and dropping that frame would
   * lose the one that matters most. Returns it if there is one.
   */
  flush(): SseFrame[];
}

export function createSseParser(): SseParser {
  /** Bytes that arrived without a line terminator yet. */
  let carry = "";
  let event = "";
  let data: string[] = [];

  /** Turn whatever fields have accumulated into a frame, or nothing if there were none. */
  function finish(): SseFrame[] {
    if (data.length === 0 && event === "") return [];
    const frame: SseFrame = { event: event || "message", data: data.join("\n") };
    event = "";
    data = [];
    return [frame];
  }

  function line(raw: string, out: SseFrame[]): void {
    // A blank line DISPATCHES. Everything else is a field on the frame being built.
    if (raw === "") {
      out.push(...finish());
      return;
    }
    if (raw.startsWith(":")) return; // comment / heartbeat
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    // No colon at all means the whole line is a field name with an empty value.
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    // `id` and `retry` are the spec's other two fields and neither is used here: this
    // transport is one POST that either completes or does not, so there is no reconnection
    // for a last-event-id to resume and no backoff for the server to suggest.
  }

  return {
    push(chunk: string): SseFrame[] {
      const out: SseFrame[] = [];
      // `\r\n`, `\n` and a lone `\r` are all line terminators per the spec. Normalising
      // first is cheaper than three cases in the scanner, and a `\r` stranded at the end of
      // a chunk stays in the carry so a split `\r\n` cannot become two blank lines -- which
      // would dispatch a frame early, in the middle of its own data.
      carry += chunk;
      let start = 0;
      for (;;) {
        const nl = carry.indexOf("\n", start);
        const cr = carry.indexOf("\r", start);
        if (nl === -1 && cr === -1) break;
        // A trailing lone `\r` might be the first half of a `\r\n` still in flight.
        if (nl === -1 && cr === carry.length - 1) break;
        const at = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
        line(carry.slice(start, at), out);
        start = at + (carry[at] === "\r" && carry[at + 1] === "\n" ? 2 : 1);
      }
      carry = carry.slice(start);
      return out;
    },

    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (carry !== "") {
        line(carry, out);
        carry = "";
      }
      out.push(...finish());
      return out;
    },
  };
}

/**
 * Read a `Response` body as frames, one `await` per frame.
 *
 * An async generator rather than a callback so the consumer keeps control of the loop: the
 * chat hook has to stop on the reader's abort, and a callback-driven pump would need a
 * second flag to tell it to. `body` being null is a real case -- a 204, and every test
 * environment that fakes a `Response` without one -- and it yields nothing rather than
 * throwing, because "the stream was empty" is a state the caller already has to handle.
 */
export async function* sseFrames(res: Response): AsyncGenerator<SseFrame> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` is what keeps a multi-byte character split across two chunks from
      // decoding as two replacement characters -- an accented title in a tool summary is
      // exactly the payload that would show it.
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame;
    }
    for (const frame of parser.flush()) yield frame;
  } finally {
    // Releasing matters on the abort path: the loop is abandoned mid-read and the socket
    // stays held otherwise.
    reader.releaseLock();
  }
}
