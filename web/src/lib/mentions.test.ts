/**
 * The dead-end rule, at the one place a model's mistake can reach a reader as a link.
 */

import { describe, expect, test } from "bun:test";
import { splitMentions, stripMentions } from "./mentions";

const FURIOUS = { id: "tt36303968", kind: "title" as const, label: "Furious", path: "/title/tt36303968/" };
const ROSSUM = { id: "nm0002536", kind: "person" as const, label: "Emmy Rossum", path: "/person/nm0002536/" };

describe("splitMentions", () => {
  test("a resolved id becomes a link and the brackets vanish", () => {
    const parts = splitMentions("You should watch Furious [tt36303968] tonight.", [FURIOUS]);
    expect(parts).toEqual([
      { kind: "text", text: "You should watch " },
      { kind: "link", id: "tt36303968", label: "Furious", path: "/title/tt36303968/", entity: "title" },
      { kind: "text", text: " tonight." },
    ]);
  });

  test("AN UNRESOLVED ID STAYS PLAIN TEXT -- the whole point", () => {
    // A model can emit a well-formed id that never existed. A link built from the shape of
    // an id would hand the reader a confident 404.
    const parts = splitMentions("Try The Ghost Sequel [tt99999999] as well.", [FURIOUS]);
    expect(parts).toEqual([{ kind: "text", text: "Try The Ghost Sequel as well." }]);
  });

  test("the brackets are never visible, resolved or not", () => {
    const both = splitMentions("Furious [tt36303968] and Nothing [tt00000000].", [FURIOUS]);
    const rendered = both.map((p) => (p.kind === "text" ? p.text : p.label)).join("");
    expect(rendered).not.toContain("[");
    expect(rendered).not.toContain("]");
  });

  test("a DISAGREEMENT is shown, not laundered", () => {
    /*
      "The Sopranos [tt36303968]" is the model being wrong -- that id is Furious.

      The link is always labelled from OUR row, so the destination and its text are correct.
      The model's own wording is LEFT STANDING beside it rather than deleted: quietly
      removing the words it wrote would hide that it disagreed with us about what the id
      refers to. A reader seeing "The Sopranos Furious" knows something is off; a reader
      shown only "Furious" would never learn the model had mislabelled it.
    */
    const parts = splitMentions("Watch The Sopranos [tt36303968].", [FURIOUS]);
    expect(parts.find((p) => p.kind === "link")).toMatchObject({ label: "Furious" });
    const rendered = parts.map((p) => (p.kind === "text" ? p.text : p.label)).join("");
    expect(rendered).toContain("Sopranos");
    expect(rendered).toContain("Furious");
  });

  test("the label is consumed when the model DID write our name", () => {
    // The ordinary case, and what the prompt asks for: no duplication.
    const parts = splitMentions("Watch Furious [tt36303968].", [FURIOUS]);
    const rendered = parts.map((p) => (p.kind === "text" ? p.text : p.label)).join("");
    expect(rendered).toBe("Watch Furious.");
  });

  test("NEVER swallows the sentence before it", () => {
    /*
      The bug this file's regex was rewritten to fix. A lazy name capture still starts at the
      earliest position the engine can, so "You should watch Furious [tt…]" ate four words of
      prose into the link. Matching only the bracket makes that impossible by construction.
    */
    const parts = splitMentions("You should watch Furious [tt36303968] tonight.", [FURIOUS]);
    expect(parts[0]).toEqual({ kind: "text", text: "You should watch " });
    expect(parts[1]).toMatchObject({ kind: "link", label: "Furious" });
    expect(parts[2]).toEqual({ kind: "text", text: " tonight." });
  });

  test("people and titles both resolve, in order", () => {
    const parts = splitMentions("Emmy Rossum [nm0002536] is in Furious [tt36303968].", [ROSSUM, FURIOUS]);
    const links = parts.filter((p) => p.kind === "link");
    expect(links.map((l) => (l.kind === "link" ? l.entity : ""))).toEqual(["person", "title"]);
  });

  test("an answer with no ids is one text part", () => {
    expect(splitMentions("Nothing matched that.", [])).toEqual([
      { kind: "text", text: "Nothing matched that." },
    ]);
  });

  test("an empty answer is no parts, not one empty part", () => {
    expect(splitMentions("", [FURIOUS])).toEqual([]);
  });
});

describe("stripMentions", () => {
  test("removes every bracket regardless of resolution", () => {
    expect(stripMentions("Furious [tt36303968] and Ghost [tt99999999].")).toBe("Furious and Ghost.");
  });
});
