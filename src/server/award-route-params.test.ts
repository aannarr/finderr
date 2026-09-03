/**
 * The promise `/awards/oscars` made before it became `/awards/:award`.
 *
 * A REGRESSION TEST FOR THE ONE THING GENERALISING A ROUTE CAN BREAK QUIETLY. The literal
 * `/api/awards/oscars` and `/api/awards/oscars/:ceremony` are linked from the top nav, from
 * every curated row, and from every title and person page that draws a nomination. Replacing
 * them with parameters is only correct if all of those still resolve -- and a router that
 * ranked the two patterns wrongly would answer the timeline URL with the edition handler, or
 * with a 404, and nothing in the type system would notice.
 *
 * It boots the same ROUTE SHAPE rather than the server, which needs an index, a config and a
 * store -- the same trade `term-route-params.test.ts` makes, for the same reason. What the
 * handlers do with a resolved award is `awards.test.ts`'s business.
 */

import { describe, expect, test } from "bun:test";
import { AWARDS, awardById } from "../lib/award-registry";

/** The two patterns `index.ts` registers, answering with which one matched. */
function serveAwardRoutes() {
  return Bun.serve({
    port: 0,
    routes: {
      "/api/awards/:award": (req: Bun.BunRequest<"/api/awards/:award">) => {
        const def = awardById(req.params.award);
        if (!def) return Response.json({ error: "unknown award" }, { status: 404 });
        return Response.json({ handler: "timeline", award: def.id });
      },
      "/api/awards/:award/:ceremony": (req: Bun.BunRequest<"/api/awards/:award/:ceremony">) => {
        const def = awardById(req.params.award);
        if (!def) return Response.json({ error: "unknown award" }, { status: 404 });
        return Response.json({ handler: "edition", award: def.id, ceremony: req.params.ceremony });
      },
    },
    fetch: () => new Response("no route", { status: 404 }),
  });
}

describe("the award routes", () => {
  test("every registered award resolves, and the Oscars' old URLs are among them", async () => {
    const server = serveAwardRoutes();
    try {
      for (const def of AWARDS) {
        const timeline = await fetch(`${server.url}api/awards/${def.id}`);
        expect(timeline.status).toBe(200);
        expect(await timeline.json()).toEqual({ handler: "timeline", award: def.id });
      }

      // The two URLs that existed as literals before this route took a parameter.
      const oscars = await fetch(`${server.url}api/awards/oscars`);
      expect(await oscars.json()).toEqual({ handler: "timeline", award: "oscars" });
      const ceremony = await fetch(`${server.url}api/awards/oscars/96`);
      expect(await ceremony.json()).toEqual({ handler: "edition", award: "oscars", ceremony: "96" });
    } finally {
      server.stop(true);
    }
  });

  test("an award we do not serve is a 404, never an empty timeline", async () => {
    // "We do not have that award" and "that award has no rows yet" are different facts and
    // the page draws them differently -- one is a wrong URL, the other is an import that has
    // not run.
    const server = serveAwardRoutes();
    try {
      const res = await fetch(`${server.url}api/awards/golden-globes`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("a dated award's edition is its year, and arrives as the string it was typed as", async () => {
    // `/awards/palme-dor/1994`. Both route shapes carry an integer, so one pattern serves an
    // ordinal ceremony and a year alike -- see `AwardEdition`.
    const server = serveAwardRoutes();
    try {
      const res = await fetch(`${server.url}api/awards/palme-dor/1994`);
      expect(await res.json()).toEqual({ handler: "edition", award: "palme-dor", ceremony: "1994" });
    } finally {
      server.stop(true);
    }
  });
});
