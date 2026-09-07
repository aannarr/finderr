import { describe, expect, test } from "bun:test";
import {
  boundedList,
  boundedQuery,
  boundedText,
  clampInt,
  hasMarkStack,
  LIMITS,
  refusalMessage,
  sanitizeText,
  urlWithinBounds,
} from "./input-guards";

/**
 * Every interesting character in this file is INVISIBLE, so none of them is written as
 * itself.
 *
 * A fixture containing a literal U+202E is a line no reviewer can read and no diff can
 * show -- and this suite exists precisely to prove those characters are handled, so a
 * fixture that silently lost one would go on passing while testing nothing. Naming each
 * code point is the documentation.
 */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const NUL = cp(0x00);
const ESC = cp(0x1b);
/** RIGHT-TO-LEFT OVERRIDE. The classic display spoof. */
const RLO = cp(0x202e);
/** ZERO WIDTH SPACE. */
const ZWSP = cp(0x200b);
/** COMBINING ACUTE ACCENT. */
const ACUTE = cp(0x0301);
/** SOFT HYPHEN -- ordinary in text pasted out of a word processor, and deliberately kept. */
const SHY = cp(0xad);

/** The hostile strings, in one place, so every abuse suite shares one vocabulary. */
export const HOSTILE = {
  /** The 22 KB, 3,200-token query that measured 26,631 ms against the real index. */
  longQuery: Array.from({ length: 3200 }, () => '"a* OR').join(" "),
  /** A NUL: stored by SQLite, truncated at by anything that speaks C. */
  nul: `good${NUL}name`,
  /** An ANSI escape: executed by whatever terminal reads the log line it lands in. */
  ansiEscape: `name${ESC}[2Jcleared`,
  /** Renders to an admin reading the user list as "adminexe.jpg". */
  rlo: `admin${RLO}gpj.exe`,
  /** Renders as "admin" and is a different database row from "admin". */
  zeroWidth: `a${ZWSP}d${ZWSP}m${ZWSP}i${ZWSP}n`,
  /** A name with no visible content at all. */
  invisibleOnly: ZWSP.repeat(3),
  /** Zalgo: 60 combining acutes on one base, which overflows its line box. */
  zalgo: `e${ACUTE.repeat(60)}`,
  /** Three code points, six UTF-16 units -- the case a naive length check charges double for. */
  astral: "\u{1f3ac}\u{1f3ac}\u{1f3ac}",
} as const;

describe("sanitizeText", () => {
  test("strips a NUL, which SQLite stores and C truncates at", () => {
    expect(sanitizeText(HOSTILE.nul)).toBe("goodname");
  });

  test("strips an ANSI escape, which a terminal reading the log would execute", () => {
    expect(sanitizeText(HOSTILE.ansiEscape)).toBe("name[2Jcleared");
  });

  test("strips RIGHT-TO-LEFT OVERRIDE, the display spoof", () => {
    expect(sanitizeText(HOSTILE.rlo)).toBe("admingpj.exe");
    expect(sanitizeText(HOSTILE.rlo)).not.toContain(RLO);
  });

  test("strips zero-width joins, so two names cannot look identical and differ", () => {
    expect(sanitizeText(HOSTILE.zeroWidth)).toBe("admin");
  });

  test("composes to NFC, so one name has exactly one stored form", () => {
    // "e" + combining acute and the precomposed character must not be two different users.
    expect(sanitizeText(`e${ACUTE}`)).toBe(sanitizeText(cp(0xe9)));
  });

  test("keeps ordinary text in any script untouched", () => {
    for (const s of ["Ana de Armas", "宮崎 駿", "Ólafur Arnalds", "Nguyễn Thị Minh", "🎬 movie night"]) {
      expect(sanitizeText(s)).toBe(s.normalize("NFC"));
    }
  });

  test("does NOT strip a soft hyphen -- ordinary in pasted text and harmless", () => {
    expect(sanitizeText(`co${SHY}operate`)).toContain(SHY);
  });
});

describe("hasMarkStack", () => {
  test("catches a Zalgo string", () => {
    expect(hasMarkStack(HOSTILE.zalgo)).toBe(true);
  });

  test("leaves real diacritics alone, including stacked Vietnamese", () => {
    // Decomposed on purpose: this is what the check actually sees for a legitimate name.
    expect(hasMarkStack("Nguyễn Thị Minh".normalize("NFD"))).toBe(false);
    expect(hasMarkStack("Ólafur".normalize("NFD"))).toBe(false);
  });

  test("counts a RUN, not a total -- a long accented sentence is fine", () => {
    expect(hasMarkStack(`e${ACUTE} `.repeat(40))).toBe(false);
  });
});

describe("boundedText", () => {
  test("refuses past the limit rather than truncating", () => {
    const g = boundedText("x".repeat(LIMITS.name + 1), LIMITS.name);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("too-long");
  });

  test("accepts exactly the limit", () => {
    expect(boundedText("x".repeat(LIMITS.name), LIMITS.name).ok).toBe(true);
  });

  test("measures CODE POINTS, so an astral name is not refused for its encoding", () => {
    // Three emoji are 6 UTF-16 units and 3 code points. A `.length` check would charge
    // double for every emoji and for every name written in an astral script.
    expect(HOSTILE.astral.length).toBe(6);
    expect(boundedText(HOSTILE.astral, 3).ok).toBe(true);
  });

  test("a value that is ONLY invisible characters is empty, not a name", () => {
    const g = boundedText(HOSTILE.invisibleOnly, LIMITS.name);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("empty");
  });

  test("refuses a non-string rather than coercing it", () => {
    for (const v of [42, null, undefined, {}, [], true]) {
      const g = boundedText(v, LIMITS.name);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toBe("wrong-type");
    }
  });

  test("refuses a mark stack even when it is short enough to fit", () => {
    expect(boundedText(HOSTILE.zalgo, LIMITS.name).ok).toBe(false);
  });
});

describe("boundedQuery", () => {
  test("refuses the 22 KB payload that measured 26,631 ms", () => {
    expect(boundedQuery(HOSTILE.longQuery).ok).toBe(false);
  });

  test("refuses on TOKENS even when the characters fit", () => {
    const q = Array.from({ length: LIMITS.queryTokens + 1 }, () => "ab").join(" ");
    expect([...q].length).toBeLessThanOrEqual(LIMITS.queryChars);
    const g = boundedQuery(q);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("too-many");
  });

  test("admits the longest title that actually exists in the corpus", () => {
    // Measured 2026-09-07 across every title at votes >= 1000: this is the longest, at 20
    // tokens / 104 characters. If a future cap refuses it, the cap is wrong.
    const longest =
      "DanMachi: Is It Wrong to Try to Pick Up Girls in a Dungeon? On the Side - Sword Oratoria";
    expect(boundedQuery(longest).ok).toBe(true);
  });

  test("an empty query is a legal question, not a refusal", () => {
    const g = boundedQuery("   ");
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.value).toBe("");
  });
});

describe("clampInt", () => {
  test("clamps rather than refusing -- a broken client is not an attack", () => {
    expect(clampInt("999999", { min: 1, max: 100 })).toBe(100);
    expect(clampInt("-5", { min: 1, max: 100 })).toBe(1);
  });

  test("falls back on anything unparseable", () => {
    for (const v of ["abc", "", null, undefined, {}, Number.NaN, "Infinity"]) {
      expect(clampInt(v, { min: 1, max: 100, fallback: 25 })).toBe(25);
    }
  });

  test("refuses to let a float reach a LIMIT clause", () => {
    expect(clampInt(3.9, { min: 1, max: 100 })).toBe(3);
  });
});

describe("boundedList", () => {
  const item = (x: unknown) => boundedText(x, 10);

  test("refuses a list past the cap", () => {
    const g = boundedList(
      Array.from({ length: 5 }, () => "ok"),
      item,
      4,
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("too-many");
  });

  test("refuses the WHOLE list when one item is bad, never a partial", () => {
    expect(boundedList(["fine", "x".repeat(50), "fine"], item).ok).toBe(false);
  });
});

describe("urlWithinBounds", () => {
  test("admits every URL finderr generates", () => {
    expect(urlWithinBounds("/api/browse?genre=Drama&decade=1990&sort=rank&page=3&kind=movie")).toBe(true);
  });

  test("refuses a URL past the cap", () => {
    expect(urlWithinBounds(`/api/search?q=${"x".repeat(LIMITS.url)}`)).toBe(false);
  });
});

describe("refusalMessage", () => {
  test("names the limit and never the value", () => {
    const msg = refusalMessage("q", { reason: "too-long", limit: 200 });
    expect(msg).toContain("200");
    expect(msg).not.toContain("x".repeat(20));
  });
});
