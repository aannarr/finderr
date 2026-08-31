/**
 * What the season chooser puts on the page.
 *
 * `react-dom/server` like `SeriesPane.test.tsx`, and for the same reason: these
 * assertions are about WHICH markup appears, and static markup answers that with no DOM
 * and no test-library dependency. The behaviour behind a click -- what the default
 * selection is, what toggling does, how a selection reads back as a sentence -- is
 * tested as pure functions in `../lib/season-select.test.ts`.
 *
 * `showModal()` is a DOM call and does not run here, so these cover the rendered
 * content, not the open/close cycle.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Season } from "../lib/facets";
import { SeasonRequestDialog } from "./SeasonRequestDialog";

function season(over: Partial<Season> & { number: number }): Season {
  return { name: null, episodeCount: 10, premiereDate: null, endDate: null, image: null, ...over };
}

const GOT: Season[] = [
  season({ number: 0, episodeCount: 55 }),
  season({ number: 1, name: "Winter is Coming" }),
  season({ number: 2, name: "Hear me Roar!" }),
  season({ number: 3, name: "Fire and Blood" }),
];

function render(seasons: Season[] = GOT) {
  return renderToStaticMarkup(
    <SeasonRequestDialog
      open
      seasons={seasons}
      title="Game of Thrones"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
}

describe("SeasonRequestDialog", () => {
  test("draws a chip for every season, specials included", () => {
    const html = render();
    for (const name of ["Winter is Coming", "Hear me Roar!", "Fire and Blood"]) {
      expect(html).toContain(name);
    }
    expect(html).toContain("Specials");
  });

  test("specials are ordered last, so the eye lands on season 1 first", () => {
    const html = render();
    expect(html.indexOf("Specials")).toBeGreaterThan(html.indexOf("Winter is Coming"));
  });

  test("opens with every real season selected and specials not", () => {
    // aria-pressed is the selected state -- ToggleChip's own contract. Three real
    // seasons pressed, the specials chip not.
    const html = render();
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
  });

  test("the confirm button names what will be requested, not just 'Request'", () => {
    // The reader is told the consequence before pressing Enter.
    expect(render()).toContain("Request Seasons 1-3");
  });

  test("says what Sonarr will monitor", () => {
    expect(render()).toContain("Sonarr will monitor Seasons 1-3.");
  });

  test("offers 'Select all' when specials are unticked", () => {
    // The default selection is deliberately NOT every season, so the escape hatch to
    // include specials has to be offered rather than reading "Clear all".
    expect(render()).toContain("Select all");
  });

  test("a series with only specials opens with nothing selected and refuses to submit", () => {
    const html = render([season({ number: 0, episodeCount: 12 })]);
    expect(html).toContain("Pick at least one season.");
    expect(html).toContain("disabled");
  });

  test("the season group is a real fieldset with a legend", () => {
    const html = render();
    expect(html).toContain("<fieldset");
    expect(html).toContain("Seasons to request");
  });

  test("episode counts ride along on the chips", () => {
    expect(render()).toContain("55");
  });
});
