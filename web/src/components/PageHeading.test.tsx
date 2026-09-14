/**
 * The heading's TEXT, which is what a screen reader announces and what a copy-paste carries.
 *
 * Found 2026-09-14 by the filming-locations critique: the prefix was separated from the name by
 * a margin alone, so the heading's accessible name read "Filmed inAlmería" -- and "KeywordHeist"
 * on every term page, where the markup was first written. A margin is invisible to text.
 */

import { describe, expect, test } from "bun:test";
import { render, screen } from "../test/interact";
import { PageHeading } from "./PageHeading";

describe("PageHeading", () => {
  test("the prefix and the name are separate words in the heading's text", () => {
    render(<PageHeading prefix="Filmed in">Almería</PageHeading>);
    expect(screen.getByRole("heading").textContent).toBe("Filmed in Almería");
  });
});
