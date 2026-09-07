/**
 * THE STANDING ABUSE SUITE. Every function that takes text off the wire is walked over the
 * whole hostile corpus here, and the properties asserted are the ones no per-function test
 * thinks to check.
 *
 * > [!IMPORTANT] ADD YOUR FUNCTION TO `TEXT_ENTRY_POINTS` WHEN YOU WRITE ONE
 * > aannarr, 2026-09-07: *"make sure we test for this in all future development too."*
 * > That is what this table is. A new parser, normaliser, matcher or guard that sees user
 * > text gets one line in it and inherits every case in `abuse-corpus.ts` -- including the
 * > ones added after you stopped working on it.
 * >
 * > The alternative -- each author remembering to write their own hostile-input tests --
 * > has one failure mode and it is the only one that matters: they will remember the
 * > attacks they already know about. The corpus is the accumulated list.
 *
 * **THREE PROPERTIES, and none of them is "returns the right answer".** What a function
 * SHOULD return for a given input is its own test's business. What this suite asserts is
 * that no input in the corpus can make it throw, hang, or leak a character it was supposed
 * to remove -- the three failures that turn a bad input into somebody else's outage.
 */

import { describe, expect, test } from "bun:test";
import { stripImageExt } from "../server/cache-policy";
import { FORBIDDEN_PATTERNS, HOSTILE, HOSTILE_CASES, NON_STRINGS, RLO } from "./abuse-corpus";
import {
  boundedHeader,
  boundedList,
  boundedQuery,
  boundedText,
  clampInt,
  hasMarkStack,
  LIMITS,
  sanitizeText,
  urlWithinBounds,
} from "./input-guards";
import { mapMediaPath } from "./media-path";
import { despace, normalize, normalizeStripped, trigrams } from "./normalize";
import { parseQuery } from "./query-parser";

/** A guard's result, for the `textOut` readers below. */
type Guarded = { ok: boolean; value?: string };
const guardedText = (r: unknown) => ((r as Guarded).ok ? ((r as Guarded).value ?? null) : null);

/**
 * Every function in this codebase that takes untrusted text and returns something.
 *
 * `accepts` says what the function is willing to be handed -- a guard takes `unknown`
 * because that is what a JSON body field is, while a normaliser is only ever called with a
 * string. Getting that wrong would test a coercion nobody performs.
 */
const TEXT_ENTRY_POINTS: {
  name: string;
  run: (v: unknown) => unknown;
  accepts: "unknown" | "string";
  /**
   * How to get the TEXT this entry point produced, when it produces text a caller will
   * store or render. `null` means it refused and there is nothing to check.
   *
   * > [!CAUTION] AN ENTRY POINT THAT PRODUCES TEXT AND DECLARES NO `textOut` IS ONLY BEING
   * > TESTED FOR NOT CRASHING
   * > This field is the difference between a suite that catches a bad guard and one that
   * > watches it pass. Proved on 2026-09-07 by adding `(v) => v.trim().slice(0, 100)` -- a
   * > guard somebody would plausibly write -- to this table: with only the throw and timing
   * > checks it passed every hostile case while happily returning a RIGHT-TO-LEFT OVERRIDE,
   * > and it failed five of them the moment it declared what it returned.
   * > **Declare `textOut` whenever your function's output is text.**
   */
  textOut?: (r: unknown) => string | null;
}[] = [
  {
    name: "sanitizeText",
    run: (v) => sanitizeText(v as string),
    accepts: "string",
    textOut: (r) => r as string,
  },
  { name: "hasMarkStack", run: (v) => hasMarkStack(v as string), accepts: "string" },
  { name: "boundedText", run: (v) => boundedText(v, LIMITS.text), accepts: "unknown", textOut: guardedText },
  { name: "boundedQuery", run: (v) => boundedQuery(v), accepts: "unknown", textOut: guardedText },
  { name: "clampInt", run: (v) => clampInt(v, { min: 0, max: 100 }), accepts: "unknown" },
  { name: "boundedList", run: (v) => boundedList(v, (x) => boundedText(x, 10)), accepts: "unknown" },
  { name: "urlWithinBounds", run: (v) => urlWithinBounds(v as string), accepts: "string" },
  {
    name: "boundedHeader",
    run: (v) => boundedHeader(v as string, LIMITS.userAgent),
    accepts: "unknown",
    textOut: (r) => r as string | null,
  },
  /*
    The `normalize` family is `accepts: "string"`, and that is a claim about the CALL GRAPH
    rather than a shrug.

    They are declared `string | null | undefined` and handle both nullish cases, but a
    NUMBER makes them throw -- `(42).normalize` is not a function. That is only safe because
    nothing hands them a raw body field: every path from the wire reaches them through
    `boundedQuery` or `boundedText`, which have already refused a non-string. If a future
    caller ever passes one of these an `unknown` directly, move it to `"unknown"` HERE and
    let the resulting red line say what has to change.
  */
  {
    name: "normalize",
    run: (v) => normalize(v as string),
    accepts: "string",
    textOut: (r) => r as string,
  },
  {
    name: "normalizeStripped",
    run: (v) => normalizeStripped(v as string),
    accepts: "string",
    textOut: (r) => r as string,
  },
  { name: "despace", run: (v) => despace(v as string), accepts: "string", textOut: (r) => r as string },
  { name: "trigrams", run: (v) => trigrams(normalize(v as string)), accepts: "string" },
  { name: "parseQuery", run: (v) => parseQuery(v as string), accepts: "string" },
  /*
    `stripImageExt` DECLARES NO `textOut`, and that is the one entry here where the omission
    is argued rather than forgotten.

    It takes a route parameter and removes a trailing `.jpg`. It does not sanitize, and it
    must not: its output is never stored and never rendered. Every call site feeds it
    straight into a CLOSED regex -- `IMDB_ID`, the facet `KEY`, or `id.startsWith("nm")` --
    which refuses anything a hostile string could carry, and those refusals are pinned in
    `../server/facet-images.test.ts`. Declaring `textOut` would assert a property this
    function does not have and does not need, which is a worse failure than the missing
    check it would look like it was adding. What IS worth inheriting from this table is that
    it never throws and never goes quadratic on 22 KB of Zalgo -- it is a regex on a path.
  */
  { name: "stripImageExt", run: (v) => stripImageExt(v as string), accepts: "string" },
  /*
    `mapMediaPath` takes a filesystem path off the arr API and decides whether this process
    may open it. `accepts: "unknown"` because that is genuinely what a JSON field is, and it
    is the ONE entry here whose output is not text at all -- a refusal code, or a path this
    server generated by concatenating its own configured prefix onto an already-normalised
    remainder.

    So it declares no `textOut`, and unlike `stripImageExt` the reason is not that the check
    would be wrong: it is that the path it emits is not a string any reader is ever shown.
    What this table is buying is the half that matters for a path -- that 22 KB of Zalgo, a
    NUL, a bidi override and an FTS5 operator all fail to make it throw or go quadratic on
    the way to a decision. Its own hostile cases, the ones about traversal and symlinks that
    this corpus knows nothing about, live in `media-path.test.ts`.
  */
  {
    name: "mapMediaPath",
    run: (v) => mapMediaPath(v, [{ arr: "/plex", local: "/plex" }]),
    accepts: "unknown",
  },
];

describe("no text entry point throws on any hostile input", () => {
  for (const ep of TEXT_ENTRY_POINTS) {
    for (const [label, value] of HOSTILE_CASES) {
      test(`${ep.name} <- ${label}`, () => {
        expect(() => ep.run(value)).not.toThrow();
      });
    }
  }
});

describe("no guard throws on a value that is not a string", () => {
  // A JSON body field is `unknown`, and the field that is a number today is the one that
  // arrives as an object tomorrow. Anything declared to take `unknown` must survive all of
  // these; a normaliser is exempt because nothing ever hands it one.
  for (const ep of TEXT_ENTRY_POINTS.filter((e) => e.accepts === "unknown")) {
    test(ep.name, () => {
      for (const v of NON_STRINGS) {
        expect(() => ep.run(v)).not.toThrow();
      }
    });
  }
});

describe("no text entry point is slow on any hostile input", () => {
  /*
    A BUDGET RATHER THAN A STOPWATCH.

    The failure being caught is CATASTROPHIC -- a regex that backtracks exponentially, a
    quadratic loop over tokens -- and those are three or more orders of magnitude over
    budget, not 20% over. So a generous absolute ceiling catches every real instance and
    does not flake on a loaded CI box, which a tight one would.

    The 26,631 ms search that started all of this would fail this by a factor of 500.
  */
  const BUDGET_MS = 50;

  for (const ep of TEXT_ENTRY_POINTS) {
    test(ep.name, () => {
      for (const [label, value] of HOSTILE_CASES) {
        const t0 = Bun.nanoseconds();
        try {
          ep.run(value);
        } catch {
          // Throwing is the previous suite's business; this one only measures.
        }
        const ms = (Bun.nanoseconds() - t0) / 1e6;
        expect({ [`${ep.name}/${label}`]: ms < BUDGET_MS }).toEqual({
          [`${ep.name}/${label}`]: true,
        });
      }
    });
  }
});

describe("what must never survive a sanitize", () => {
  /*
    EVERY entry point that produces text, not just `sanitizeText`.

    Walking only the sanitizer would test the implementation this contract is ABOUT and
    nothing that depends on it -- which is how a suite ends up watching a bad guard pass.
    See the caution on `textOut` for the day that was proved. The forbidden set itself lives
    in `abuse-corpus.ts`, apart from the regex that satisfies it, so rewriting that regex
    cannot quietly narrow the rule.
  */
  for (const ep of TEXT_ENTRY_POINTS.filter((e) => e.textOut)) {
    for (const [label, value] of HOSTILE_CASES) {
      test(`${ep.name}(${label}) returns nothing forbidden`, () => {
        const out = ep.textOut?.(ep.run(value)) ?? null;
        if (out === null) return; // refused; there is no text to check
        for (const f of FORBIDDEN_PATTERNS) {
          expect({ [`${ep.name}/${f.name}`]: f.re.test(out) }).toEqual({
            [`${ep.name}/${f.name}`]: false,
          });
        }
      });
    }
  }

  test("and the guarded VALUE is what a caller gets, never the raw one", () => {
    // The failure this pins: a guard that validates and then returns its input. Every
    // caller uses `g.value`, so the cleaning has to be IN the value.
    const g = boundedText(HOSTILE.rlo, LIMITS.name);
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.value).not.toContain(RLO);
  });
});

describe("what must never survive normalize, which is what reaches FTS5", () => {
  test("no FTS5 operator can be smuggled into a MATCH expression", () => {
    /*
      `matchExpr` wraps each token in double quotes and appends `*`, so a token carrying a
      quote would end the phrase and the rest would be parsed as query syntax. The reason
      that is not exploitable is `normalize`, which keeps `[a-z0-9]` and spaces and nothing
      else -- an invariant asserted HERE rather than inferred from reading that regex,
      because the regex lives in another file and this is the property that depends on it.
    */
    for (const [label, value] of HOSTILE_CASES) {
      expect({ [label]: /^[a-z0-9 ]*$/.test(normalize(value)) }).toEqual({ [label]: true });
    }
  });

  test("a bounded query cannot normalize into more tokens than the char cap allows", () => {
    /*
      THE GAP BETWEEN THE TWO CAPS, pinned.

      `boundedQuery` counts tokens on WHITESPACE, deliberately, so it refuses before doing
      any normalizing work -- but `normalize` turns punctuation into spaces, so a query that
      passes the token cap can still normalize into MORE tokens than it was checked for.
      That is why the character cap is not redundant, and this asserts the bound it buys:
      whatever gets through, the FTS5 expression cannot be wider than the measured-safe size.
    */
    const worst = ".".repeat(LIMITS.queryChars);
    const g = boundedQuery(worst);
    const tokens = g.ok ? normalize(g.value).split(" ").filter(Boolean).length : 0;
    // 200 characters cannot become more than 100 tokens: every token needs a separator.
    expect(tokens).toBeLessThanOrEqual(Math.ceil(LIMITS.queryChars / 2));
  });
});
