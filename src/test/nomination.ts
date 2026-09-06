/**
 * One nomination, with only the fields a given test cares about.
 *
 * Four test files build award rows and three of them held a byte-identical copy of this
 * builder. `Nomination` has fourteen fields and every test cares about two or three, so the
 * copies existed for a reason -- but a fifteenth field would have had to be added in four
 * places, and whichever copy was missed would fail as a type error in a file nobody was
 * editing.
 *
 * Test-only, and in `src/test/` rather than `src/lib/` to say so -- nothing the app ships
 * imports it. Same rule and same reason as `web/src/test/render-in-router.tsx`.
 *
 * The defaults describe a LOSING Best Picture nomination at a recent ceremony: the shape most
 * tests then bend one field of, and the one that cannot be mistaken for a win.
 */

import type { Nomination } from "../lib/awards";

export function nomination(over: Partial<Nomination> = {}): Nomination {
  return {
    award: "oscars",
    ceremony: 98,
    seq: 0,
    year: "2025",
    className: "Title",
    category: "BEST PICTURE",
    rawCategory: "BEST PICTURE",
    films: [],
    filmIds: [],
    nominees: [],
    nconsts: [],
    won: false,
    detail: null,
    note: null,
    ...over,
  };
}
