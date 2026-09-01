/**
 * Wrapping every handler in a Bun route table, once, for all three wrappers that do it.
 *
 * THE SHAPE THIS EXISTS TO KEEP: variadic INSIDE, generic OUTSIDE. Bun infers `req.params`
 * from each path literal in the table, and a `Record<string, Handler>` parameter would
 * erase that inference for every route at once. Taking `T` and returning `T`, with the
 * per-handler function untyped in the middle, is what lets a wrapped table stay exactly as
 * typed as the one that went in. `withAuth` paid for that discovery; this is the same trick
 * with one owner instead of three copies.
 *
 * A table entry is one of three things and all three are handled here rather than in each
 * wrapper: a bare handler, an object of handlers keyed by method, or a value Bun accepts
 * that is neither (a static `Response`). The last is passed straight through.
 *
 * > [!CAUTION] `typeof new Response() === "object"`, so the pass-through has to be explicit
 * > Both wrappers that predate this file claimed in their own comments to pass a static
 * > `Response` through, and neither did: it fell into the method-table branch,
 * > `Object.entries` on a `Response` is empty, and the route was replaced by `{}` -- a
 * > route table entry that answers nothing, silently, with no error anywhere. It was
 * > invisible only because nothing in this tree registers one yet, which is exactly the
 * > kind of thing somebody adds without reading the wrapper first.
 * >
 * > The method branch also wraps only the FUNCTION values it finds, so a table mixing a
 * > handler and a static response per method survives both halves.
 */

/** What a wrapper does to ONE handler: it gets the route pattern and returns a replacement. */
export type HandlerWrap = (
  path: string,
  handler: (...args: never[]) => unknown,
) => (...args: unknown[]) => unknown;

export function wrapRoutes<T extends Record<string, unknown>>(routes: T, wrap: HandlerWrap): T {
  const out: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(routes)) {
    if (typeof entry === "function") {
      out[path] = wrap(path, entry as (...args: never[]) => unknown);
      continue;
    }
    if (entry && typeof entry === "object" && !(entry instanceof Response)) {
      const methods: Record<string, unknown> = {};
      for (const [method, handler] of Object.entries(entry as Record<string, unknown>)) {
        methods[method] =
          typeof handler === "function" ? wrap(path, handler as (...args: never[]) => unknown) : handler;
      }
      out[path] = methods;
      continue;
    }
    out[path] = entry;
  }
  return out as T;
}
