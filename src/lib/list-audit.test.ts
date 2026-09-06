/**
 * The drift guard, tested against the drift it was written for.
 *
 * `lists.test.ts` cannot do this and never could: every assertion there derives FROM
 * `LIST_LANGUAGES`, so deleting a row leaves it green. These cases are the opposite shape --
 * a CORPUS that disagrees with the array, asserted to be caught. The `sh` case below is the
 * real one, found by a person in 2026-09-06 after sitting over the floor and out of the array
 * for as long as the array had existed.
 *
 * Fixed counts rather than a database. The query that produces them is tested in
 * `origin.test.ts`, where a faithful `title_lang` already lives.
 */

import { describe, expect, test } from "bun:test";
import { auditFailed, auditListLanguages, formatListLanguageAudit } from "./list-audit";
import { LIST_LANGUAGES, LIST_SIZE } from "./lists";

/** A corpus where every listed language is exactly at the floor and nothing else is near it. */
function agreeing(): Map<string, number> {
  const counts = new Map<string, number>(LIST_LANGUAGES.map((l) => [l.code, LIST_SIZE]));
  // A language with a real catalogue that is still under the floor. It belongs in every
  // fixture: "nothing else is in the corpus at all" would pass an audit that ignored the
  // unlisted direction entirely.
  counts.set("is", LIST_SIZE - 1);
  return counts;
}

const WIDENED = true;

describe("the audit against a corpus that agrees with the array", () => {
  test("passes, and counts what it looked at", () => {
    const a = auditListLanguages(agreeing(), WIDENED);
    expect(a).toEqual({ unlisted: [], short: [], counted: LIST_LANGUAGES.length + 1 });
    expect(auditFailed(a)).toBe(false);
  });

  test("the floor is inclusive -- exactly LIST_SIZE films earns a list", () => {
    // `at least LIST_SIZE` is what the rule says, so a language sitting on the number is IN.
    // An off-by-one here would fail the whole array on the day a catalogue stopped growing.
    const counts = new Map([["is", LIST_SIZE]]);
    expect(auditListLanguages(counts, WIDENED).unlisted).toEqual([{ code: "is", films: LIST_SIZE }]);
    expect(auditListLanguages(new Map([["is", LIST_SIZE - 1]]), WIDENED).unlisted).toEqual([]);
  });
});

describe("a language over the floor with no list -- the `sh` case", () => {
  test("is caught, whatever else the corpus looks like", () => {
    const counts = agreeing();
    counts.set("is", 417);
    const a = auditListLanguages(counts, WIDENED);
    expect(a.unlisted).toEqual([{ code: "is", films: 417 }]);
    expect(auditFailed(a)).toBe(true);
  });

  test("is caught on a file too old to check the other direction", () => {
    // Widening the crosswalk only ever ADDS folds, so a code over the floor on an older build
    // is still over it on a newer one. This direction needs no current index and must not be
    // skipped along with the one that does.
    const counts = agreeing();
    counts.set("is", 417);
    const a = auditListLanguages(counts, false);
    expect(a.unlisted).toEqual([{ code: "is", films: 417 }]);
    expect(a.short).toBeNull();
    expect(auditFailed(a)).toBe(true);
  });

  test("worst first, so the biggest omission is the one that gets read", () => {
    const counts = agreeing();
    counts.set("is", 300);
    counts.set("cy", 900);
    expect(auditListLanguages(counts, WIDENED).unlisted.map((l) => l.code)).toEqual(["cy", "is"]);
  });
});

describe("a listed language under the floor", () => {
  test("is caught, and named, so the row can be dropped or defended", () => {
    const counts = agreeing();
    const [first] = LIST_LANGUAGES;
    counts.set(first.code, 12);
    const a = auditListLanguages(counts, WIDENED);
    expect(a.short).toEqual([{ ...first, films: 12 }]);
    expect(auditFailed(a)).toBe(true);
  });

  test("a listed language the corpus does not reach AT ALL is a shortfall of zero", () => {
    const counts = agreeing();
    const [first] = LIST_LANGUAGES;
    counts.delete(first.code);
    expect(auditListLanguages(counts, WIDENED).short).toEqual([{ ...first, films: 0 }]);
  });

  test("is NOT MEASURED on a pre-widening index, rather than reported as the array's fault", () => {
    /*
      The one caveat this check has. On such a file `el` reaches 3 films and `tl` reaches 204,
      both legitimately listed -- the widening is what carried them over the floor. Failing
      there would be a red gate for the FILE's age, which is the "red for the wrong reason"
      the gate refuses on the canary for the same reason.
    */
    const counts = agreeing();
    counts.set(LIST_LANGUAGES[0].code, 3);
    const a = auditListLanguages(counts, false);
    expect(a.short).toBeNull();
    expect(auditFailed(a)).toBe(false);
  });
});

describe("what it prints", () => {
  test("a pass says which claim held", () => {
    const out = formatListLanguageAudit(auditListLanguages(agreeing(), WIDENED));
    expect(out).toContain("PASS: LIST_LANGUAGES is exactly the set of codes over the floor");
    expect(out).not.toContain("NOT MEASURED");
  });

  test("an unmeasured direction narrows what the pass claims, and says so ABOVE it", () => {
    const out = formatListLanguageAudit(auditListLanguages(agreeing(), false));
    // The order matters: the absence is what makes the verdict mean something other than what
    // a reader would assume, so it cannot sit below the word PASS.
    expect(out.indexOf("NOT MEASURED")).toBeLessThan(out.indexOf("PASS"));
    expect(out).toContain("PASS: no unlisted language clears the floor");
  });

  test("a failure names the code, the count and what to do about it", () => {
    const counts = agreeing();
    counts.set("is", 417);
    counts.set(LIST_LANGUAGES[0].code, 1);
    const out = formatListLanguageAudit(auditListLanguages(counts, WIDENED));
    expect(out).toContain("FAIL: 1 over the floor with no list, 1 listed under it");
    expect(out).toContain("no list: is (417 films) -- add it to LIST_LANGUAGES");
    expect(out).toContain(`under floor: ${LIST_LANGUAGES[0].code} "${LIST_LANGUAGES[0].name}" (1 film)`);
  });
});
