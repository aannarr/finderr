import { type CachePolicy, cacheHeaders, NO_STORE } from "./cache-policy";

/**
 * The one way this server sends JSON.
 *
 * There were two of these -- one in `index.ts` and one in `auth-routes.ts` -- and they had
 * already drifted: only the first sent `X-Content-Type-Options`, so the entire auth surface
 * answered without it. That is the ordinary fate of a second copy, and it is why the cache
 * policy could not be enforced until they were one function.
 *
 * > [!IMPORTANT] The default is `no-store`, and that is a posture rather than a shortcut
 * > It mirrors `withAuth`, which wraps the whole route table so a route added later is
 * > private by having been added. Same argument: a route added later is uncacheable by
 * > having been added, and a handler that wants a cache has to say so in a vocabulary
 * > (`CachePolicy`) that cannot express "reusable, and never mind who asked".
 */
export interface JsonInit extends Omit<ResponseInit, "headers"> {
  /** Who may keep this answer. Defaults to `NO_STORE`. */
  cache?: CachePolicy;
  /** Anything else the route needs to say -- `Retry-After`, `Set-Cookie`. */
  headers?: Record<string, string>;
}

export function json(data: unknown, init: JsonInit = {}): Response {
  const { cache = NO_STORE, headers, ...rest } = init;
  return new Response(JSON.stringify(data), {
    ...rest,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // A JSON body must never be sniffed into something executable, whoever asked.
      "X-Content-Type-Options": "nosniff",
      ...headers,
      // LAST, deliberately: the policy is the one thing a route may not talk its way out of.
      ...cacheHeaders(cache),
    },
  });
}
