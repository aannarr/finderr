import { describe, expect, test } from "bun:test";
import { type CapabilitySource, readCapabilities } from "./bench-caps";
import type { FuzzyAbsence } from "./search";

/**
 * A bench report that does not say whether the fuzzy tier was loaded is not comparable to
 * another one -- `search.fuzzy` is fast when it works and faster when it is absent, and only
 * this line tells the two apart.
 *
 * The reason these assertions are worth having twice over: BOTH harnesses print them now
 * (`bench-index.ts` and `bench-memory.ts`), from this one owner, so a wording change here
 * moves both reports or neither. A silent divergence between them is exactly what a second
 * hand-written copy would have produced.
 */
describe("readCapabilities", () => {
  const engine = (over: Partial<CapabilitySource> = {}): CapabilitySource => ({
    hasRank: true,
    hasPeople: true,
    hasIds: true,
    hasEpisodes: true,
    fuzzyOff: null,
    ...over,
  });

  const absent = (cause: FuzzyAbsence["cause"], detail: string): FuzzyAbsence => ({ cause, detail });

  test("a fully loaded engine reports fuzzy=on and nothing else", () => {
    const { caps, lines } = readCapabilities(engine());
    expect(caps.fuzzy).toBe("on");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("# caps: rank=true people=true ids=true episodes=true fuzzy=on");
  });

  test("an absent tier names its CAUSE, because each has a different remedy", () => {
    // A boolean would send a reader hunting for a missing binary that is sitting right there.
    expect(readCapabilities(engine({ fuzzyOff: absent("extension", "x") })).caps.fuzzy).toBe("off:extension");
    expect(readCapabilities(engine({ fuzzyOff: absent("vocabulary", "x") })).caps.fuzzy).toBe(
      "off:vocabulary",
    );
    expect(readCapabilities(engine({ fuzzyOff: absent("unprepared", "x") })).caps.fuzzy).toBe(
      "off:unprepared",
    );
  });

  test("an absent tier also gets a LOUD line carrying the remedy verbatim", () => {
    const detail = "spellfix1 is not loadable; build it or install a libsqlite3 that permits extensions";
    const { lines } = readCapabilities(engine({ fuzzyOff: absent("extension", detail) }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("FUZZY TIER ABSENT");
    expect(lines[1]).toContain("search.fuzzy measures nothing");
    // The sentence explaining the cause has ONE owner, `FuzzyAbsence` in search.ts. This line
    // quotes it rather than restating it, and that is what this assertion pins.
    expect(lines[1]).toContain(detail);
  });

  test("the header and the JSON cannot disagree -- they are one reading", () => {
    const { caps, lines } = readCapabilities(engine({ hasEpisodes: false, hasIds: false }));
    expect(caps).toEqual({ rank: true, people: true, ids: false, episodes: false, fuzzy: "on" });
    expect(lines[0]).toBe("# caps: rank=true people=true ids=false episodes=false fuzzy=on");
  });
});
