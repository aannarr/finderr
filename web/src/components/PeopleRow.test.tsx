/**
 * The people half of a search answer, as markup.
 *
 * Through a memory router, like `TermChip.test.tsx`: every tile is a `<Link>`, which reads
 * the router out of context and throws without one. The ceremony -- including the
 * `await router.load()` every copy of it had to rediscover -- is `../test/render-in-router`.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { PersonHit } from "../lib/api";
import { renderInRouter as render } from "../test/render-in-router";
import { PeopleRow } from "./PeopleRow";

const person = (over: Partial<PersonHit> = {}): PersonHit => ({
  nconst: "nm0634240",
  name: "Christopher Nolan",
  birthYear: 1970,
  deathYear: null,
  credits: 24,
  ...over,
});

/** Just enough router for a `<Link to="/person/$nconst">` to resolve an href. */
const renderInRouter = (node: ReactNode) => render(node, ["/person/$nconst"]);

describe("PeopleRow", () => {
  test("a person is a name, a credit count and a link to their filmography", async () => {
    const html = await renderInRouter(<PeopleRow people={[person()]} />);
    expect(html).toContain("Christopher Nolan");
    expect(html).toContain("24 titles");
    expect(html).toContain('href="/person/nm0634240"');
  });

  test("one title is not '1 titles'", async () => {
    const html = await renderInRouter(<PeopleRow people={[person({ credits: 1 })]} />);
    expect(html).toContain("1 title<");
  });

  /**
   * A pane is not an obligation to fill. `SearchResponse.people` is absent rather than
   * empty on an index that cannot search people, and the route passes `[]` for both -- so
   * the heading has to be conditional or a missing capability draws an empty "People".
   */
  test("nobody to draw means no heading and no row", async () => {
    expect(await renderInRouter(<PeopleRow people={[]} />)).not.toContain("People");
  });

  /**
   * The bug reported 2026-09-05: searching a name drew a grey box with initials in it
   * while the app DB held that person's headshot on six titles' cast facets. `person_image`
   * is the edge that answers, and this is the row finally drawing it.
   */
  test("a face when the server sent one", async () => {
    const html = await renderInRouter(<PeopleRow people={[person({ image: "/img/f/a1b2c3" })]} />);
    expect(html).toContain('src="/img/f/a1b2c3"');
    expect(html).not.toContain("CN");
  });

  /**
   * Initials remain the ordinary answer, not an error: coverage grows with the titles
   * somebody has opened, so most people have no face on file at any given moment. Absent
   * and explicitly null must render identically -- the field is optional precisely so a
   * client holding a cached older answer keeps working.
   */
  test("initials when the server sent no face, absent or null alike", async () => {
    for (const p of [person(), person({ image: null })]) {
      const html = await renderInRouter(<PeopleRow people={[p]} />);
      expect(html).not.toContain("<img");
      expect(html).toContain("CN");
    }
  });

  /**
   * The one rule no person tile may ever break, and the reason it is worth a test now that
   * a real URL travels: `localImageUrl` drops anything not same-origin, so a provider's CDN
   * address cannot reach an `<img>` even if one were ever written into the row.
   */
  test("an upstream URL is refused, and falls back to initials", async () => {
    const html = await renderInRouter(
      <PeopleRow people={[person({ image: "https://image.tmdb.org/t/p/original/face.jpg" })]} />,
    );
    expect(html).not.toContain("image.tmdb.org");
    expect(html).not.toContain("<img");
    expect(html).toContain("CN");
  });

  test("order is the server's, never re-sorted here", async () => {
    // The rank is a fact about the index -- votes on the best-known title, then credits --
    // and a client that re-sorted on `credits` would put the wrong Nolan first.
    const html = await renderInRouter(
      <PeopleRow people={[person(), person({ nconst: "nm0634300", name: "Jonathan Nolan", credits: 99 })]} />,
    );
    expect(html.indexOf("Christopher Nolan")).toBeLessThan(html.indexOf("Jonathan Nolan"));
  });
});
