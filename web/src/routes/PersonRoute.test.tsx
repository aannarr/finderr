/**
 * The header of a person page: who it is about, as markup.
 *
 * Only the header, because it is the only part of this route that renders from props alone
 * -- the rest is a fetch, an effect and a router navigation, none of which happen under
 * `renderToStaticMarkup`. Through a memory router for the reason `PeopleRow.test.tsx` gives:
 * the award record links to a ceremony, and a `<Link>` with no router in context throws.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { PersonPage } from "../lib/api";
import { renderInRouter as render } from "../test/render-in-router";
import { PersonHeader } from "./PersonRoute";

type HeaderProps = Pick<PersonPage, "person" | "image" | "total" | "awards">;

const header = (over: Partial<HeaderProps> = {}): HeaderProps => ({
  person: { nconst: "nm0634240", name: "Christopher Nolan", birthYear: 1970, deathYear: null },
  total: 24,
  ...over,
});

const renderInRouter = (node: ReactNode) => render(node, ["/awards/$award/$ceremony", "/title/$tconst"]);

describe("PersonHeader", () => {
  test("the name, the span and the credit count", async () => {
    const html = await renderInRouter(<PersonHeader {...header()} />);
    expect(html).toContain("Christopher Nolan");
    expect(html).toContain("1970");
    expect(html).toContain("24 credits");
  });

  /**
   * The bug this route half of the card exists for: a search row drew the face and the page
   * that row links to drew nothing, so opening somebody lost the picture that identified
   * them. `image` is the same `/img/f/<key>` path the row already receives.
   */
  test("a face when the server sent one", async () => {
    const html = await renderInRouter(<PersonHeader {...header({ image: "/img/f/a1b2c3" })} />);
    expect(html).toContain('src="/img/f/a1b2c3"');
    expect(html).not.toContain("CN");
  });

  /**
   * Initials are the ORDINARY answer rather than a failure -- coverage grows only with the
   * titles somebody has opened. Absent and explicitly null must render identically, so a
   * client holding a cached older payload keeps working.
   */
  test("initials when there is no face, absent and null alike", async () => {
    for (const props of [header(), header({ image: null })]) {
      const html = await renderInRouter(<PersonHeader {...props} />);
      expect(html).not.toContain("<img");
      expect(html).toContain("CN");
    }
  });

  /** `localImageUrl` drops anything not same-origin, so no provider address can ever paint. */
  test("an upstream URL is refused, and falls back to initials", async () => {
    const html = await renderInRouter(
      <PersonHeader {...header({ image: "https://image.tmdb.org/t/p/original/face.jpg" })} />,
    );
    expect(html).not.toContain("image.tmdb.org");
    expect(html).toContain("CN");
  });

  test("one credit is not '1 credits'", async () => {
    expect(await renderInRouter(<PersonHeader {...header({ total: 1 })} />)).toContain("1 credit<");
  });

  test("no birth or death year means no span at all, not an empty separator", async () => {
    const html = await renderInRouter(
      <PersonHeader
        {...header({
          person: { nconst: "nm1", name: "Anon", birthYear: null, deathYear: null },
        })}
      />,
    );
    expect(html).not.toContain("·");
  });

  /** Null for nearly everybody, and it draws nothing rather than "0 nominations". */
  test("no award record draws no summary", async () => {
    expect(await renderInRouter(<PersonHeader {...header()} />)).not.toContain("Nominated");
  });
});
