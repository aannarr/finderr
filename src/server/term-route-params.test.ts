/**
 * The assumption `/api/term/:dimension/:value` is built on: Bun decodes a path parameter.
 *
 * A REGRESSION TEST FOR A BUG CAUGHT BEFORE IT SHIPPED. The handler originally ran
 * `decodeURIComponent(req.params.value)`, which is a second decode -- and a second decode
 * of a term carrying a literal `%` ("100% pure" is a real TMDB keyword) throws `URIError`
 * and 500s the route. `/api/collection/:id` already relies on the same behaviour for
 * `tmdb:2344` and has never said so out loud, so this is where it is written down.
 *
 * It boots the same ROUTE SHAPE rather than the server, which needs an index, a config and
 * a store. What is under test is the framework contract both routes depend on: if a Bun
 * upgrade ever changes it, this goes red and the two handlers get revisited together
 * instead of one of them silently mangling a studio name.
 */

import { describe, expect, test } from "bun:test";

/** Every awkward shape a real term or collection id actually takes. */
const VALUES = [
  "sci-fi & fantasy",
  // The one that broke it: a second decode turns `%20` back into a space and `%` alone
  // into a `URIError`.
  "100% pure",
  "time loop",
  // Studio names carry slashes, which `encodeURIComponent` sends as `%2F` -- a path
  // separator the router must not split on.
  "Warner Bros. / DC",
  // A collection id, namespace and all.
  "tmdb:2344",
];

describe("a term arrives at the handler exactly as it was typed", () => {
  test("Bun percent-decodes a path parameter, so the handler must not decode again", async () => {
    const server = Bun.serve({
      port: 0,
      routes: {
        "/api/term/:dimension/:value": (req: Bun.BunRequest<"/api/term/:dimension/:value">) =>
          Response.json({ dimension: req.params.dimension, value: req.params.value }),
      },
      fetch: () => new Response("no route", { status: 404 }),
    });

    try {
      for (const value of VALUES) {
        const res = await fetch(`${server.url}api/term/keyword/${encodeURIComponent(value)}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ dimension: "keyword", value });
      }
    } finally {
      server.stop(true);
    }
  });
});
