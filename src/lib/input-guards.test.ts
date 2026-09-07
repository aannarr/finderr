import { describe, expect, test } from "bun:test";
import { ACUTE, HOSTILE, RLO, SHY } from "./abuse-corpus";
import {
  boundedHeader,
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

/*
  The fixtures come from `abuse-corpus.ts` and are NOT redeclared here.

  They lived in this file first, which made them importable only by other test files and
  meant the corpus was available to whoever already knew to look. They are a source module
  now, and this suite is one of its readers rather than its owner -- see that file's header.
*/

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
    expect(sanitizeText(`e${ACUTE}`)).toBe(sanitizeText(String.fromCodePoint(0xe9)));
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

describe("boundedHeader", () => {
  test("keeps a real user agent whole", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    expect(boundedHeader(ua, LIMITS.userAgent)).toBe(ua);
  });

  test("drops a header past the cap rather than failing the request", () => {
    // A header is not a field the caller can be told to fix, so no sign-in fails over one.
    expect(boundedHeader("x".repeat(LIMITS.userAgent + 1), LIMITS.userAgent)).toBeNull();
  });

  test("sanitizes, so a spoofing character cannot reach the device list", () => {
    expect(boundedHeader(HOSTILE.rlo, LIMITS.userAgent)).not.toContain(RLO);
  });

  test("a missing header is null, not an empty device name", () => {
    expect(boundedHeader(null, LIMITS.userAgent)).toBeNull();
    expect(boundedHeader(undefined, LIMITS.userAgent)).toBeNull();
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
