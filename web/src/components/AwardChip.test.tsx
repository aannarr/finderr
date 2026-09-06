/**
 * The mark a card draws for a top-prize winner.
 *
 * `renderInRouter` because the chip is a `<Link>` and a link with no router in context
 * throws. What is worth pinning is that the WORDS come from the registry rather than from
 * the payload -- that is the whole reason a mark is three fields wide -- and that the two
 * awards number their editions differently, which is a real difference between the sources
 * and not a formatting preference.
 */

import { describe, expect, test } from "bun:test";
import type { AwardMark } from "../lib/api";
import { renderInRouter } from "../test/render-in-router";
import { AwardChip } from "./AwardChip";

const render = (mark: AwardMark) => renderInRouter(<AwardChip mark={mark} />, ["/awards/$award/$ceremony"]);

describe("AwardChip", () => {
  test("names the prize from the registry and links to the edition that gave it", async () => {
    const html = await render({ award: "oscars", ceremony: 96, year: "2024" });
    expect(html).toContain("Best Picture");
    expect(html).toContain('href="/awards/oscars/96"');
  });

  test("the accessible name says what was won and when", async () => {
    // "Best Picture" alone, read out of context, is a category rather than a result.
    const html = await render({ award: "oscars", ceremony: 96, year: "2024" });
    expect(html).toContain('aria-label="Best Picture winner · 96th · 2024"');
  });

  test("a dated award prints its year and never an ordinal", async () => {
    // Wikidata records a point in time and no edition number at all, so `1994th` would be
    // an invention. `editionLabel` owns the rule; this asserts the chip goes through it.
    const html = await render({ award: "palme-dor", ceremony: 1994, year: "1994" });
    expect(html).toContain("Palme d&#x27;Or");
    expect(html).toContain('aria-label="Palme d&#x27;Or winner · 1994"');
    expect(html).toContain('href="/awards/palme-dor/1994"');
  });

  test("an award this bundle does not know draws nothing at all", async () => {
    // One deploy window: a server carrying a fourth award, a browser still on the previous
    // bundle. A chip with no name for its prize is worse than no chip.
    expect(await render({ award: "golden-raspberry", ceremony: 44, year: "2024" })).toBe("");
  });
});
