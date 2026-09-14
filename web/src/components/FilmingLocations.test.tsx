/**
 * The filming-locations fold, as BEHAVIOUR: a long list shows eight chips and one control,
 * and pressing the control is what brings the rest back.
 *
 * Driven through `TitleFactsCard`, the exported mount, because that is where a reader meets
 * it -- and because the card's own emptiness check is the other half of the rule: a title
 * every fact provider came back empty for must still draw a card when it has places.
 */

import { describe, expect, test } from "bun:test";
import type { Place } from "../lib/api";
import { fireEvent, render, screen } from "../test/interact";
import { inRouter } from "../test/render-in-router";
import { TitleFactsCard } from "./TitlePanes";

const place = (i: number): Place => ({
  id: `Q${i + 1}`,
  label: `Place ${i + 1}`,
  kind: "site",
  studio: false,
  country: "ES",
  lat: 1,
  lon: 2,
  titles: 3,
});

/** No facet answered and nobody owes one, so every facet pane is hidden and only places remain. */
async function renderFacts(places: Place[]) {
  return render(
    await inRouter(<TitleFactsCard facets={{}} working={[]} problems={[]} places={places} />, ["/place/$id"]),
  );
}

describe("TitleFactsCard filming locations", () => {
  test("a card with no facts but a place still draws, with the place in it", async () => {
    await renderFacts([place(0)]);
    expect(screen.getByText("Filming locations")).toBeTruthy();
    expect(screen.getByText("Place 1")).toBeTruthy();
  });

  test("no places and no facts draws no card at all", async () => {
    const { container } = await renderFacts([]);
    expect(container.textContent).toBe("");
  });

  test("more than eight places fold behind one toggle that opens, stays put, and closes again", async () => {
    await renderFacts(Array.from({ length: 11 }, (_, i) => place(i)));
    expect(screen.queryByText("Place 9")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show all 11" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("Place 11")).toBeTruthy();

    // The SAME element, still mounted -- which is what keeps keyboard focus from falling to <body>.
    const open = screen.getByRole("button", { name: "Show fewer" });
    expect(open).toBe(toggle);
    expect(open.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(open);
    expect(screen.queryByText("Place 9")).toBeNull();
  });

  test("exactly eight places need no control", async () => {
    await renderFacts(Array.from({ length: 8 }, (_, i) => place(i)));
    expect(screen.getByText("Place 8")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
