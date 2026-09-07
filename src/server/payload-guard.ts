/**
 * The outer fence: a request whose URL is absurd is refused before any handler runs.
 *
 * ONE WRAPPER OVER THE WHOLE ROUTE TABLE, for exactly the reason `withAuth` is one wrapper
 * over the whole route table: a per-handler check is a rule with one owner per handler, and
 * the failure is the route somebody adds next month having never read this file. A new route
 * is bounded by having been added.
 *
 * > [!IMPORTANT] This bounds the ENVELOPE. It does not bound the MEANING, and it must not try.
 * > A 2,048-character cap says nothing about whether `?q=` is a sane query -- 200 characters
 * > of `"a* OR` is still 33 tokens of FTS5 union. The semantic bounds belong at the field,
 * > in `src/lib/input-guards.ts`, where the code that knows what the field IS can apply them.
 * > Two layers, and neither is redundant: this one is cheap and universal, that one is
 * > specific and informed.
 *
 * **THE COST IS ONE `.length` ON A STRING THAT ALREADY EXISTS**, measured at 2.8 ns on the
 * M1 Max, 2026-09-07. That is what lets it sit in front of every route including the ones
 * that never read a query parameter. The obvious alternative -- walk `searchParams` and
 * bound each value -- costs a `new URL` at 59 ns on every request whether or not the handler
 * wanted one, and bounding the whole URL bounds every parameter, every parameter name and
 * the parameter count together anyway.
 *
 * **The body is Bun's job and is already done**: `maxRequestBodySize` is set on `Bun.serve`,
 * so an oversized body never reaches a handler and needs no wrapper. This closes the other
 * half, which nothing was watching.
 */

import { LIMITS, urlWithinBounds } from "../lib/input-guards";
import { json } from "./json-response";
import { type HandlerWrap, wrapRoutes } from "./route-wrap";

/**
 * `414 URI Too Long` -- the status that exists for precisely this, rather than a 400.
 *
 * The body names the limit and never the URL. Reflecting the offending URL back is how a
 * hostile string reaches a log, an error toast or a screenshot of one; the caller already
 * knows what they sent.
 */
const TOO_LONG = () => json({ error: `URL is too long (limit ${LIMITS.url})` }, { status: 414 });

export function withPayloadGuard<T extends Record<string, unknown>>(routes: T): T {
  const wrap: HandlerWrap =
    (_path, handler) =>
    (...args: unknown[]) => {
      const req = args[0] as Request | undefined;
      if (req && !urlWithinBounds(req.url)) return TOO_LONG();
      return (handler as (...a: unknown[]) => unknown)(...args);
    };
  return wrapRoutes(routes, wrap);
}
