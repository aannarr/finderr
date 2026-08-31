import { describe, expect, test } from "bun:test";
import {
  coverage,
  despace,
  jaccard,
  levenshtein,
  normalize,
  normalizeStripped,
  similarity,
  trigrams,
} from "./normalize";

describe("normalize", () => {
  test("lowercases and collapses punctuation", () => {
    expect(normalize("The Matrix: Reloaded!")).toBe("the matrix reloaded");
  });

  test("strips diacritics so a keyboard without them still works", () => {
    expect(normalize("Låt den rätte komma in")).toBe("lat den ratte komma in");
    expect(normalize("Fucking Åmål")).toBe("fucking amal");
    expect(normalize("Jägarna")).toBe("jagarna");
  });

  /**
   * The regression that mattered: Alien³ sat in the index with 355k votes and was
   * completely unreachable, because FTS5's unicode61 tokenizer does no compatibility
   * decomposition. NFKD does.
   */
  test("decomposes superscripts -- Alien3 must be findable", () => {
    expect(normalize("Alien³")).toBe("alien3");
    expect(normalize("№9")).toBe("no9");
  });

  test("maps ligatures and strokes that NFKD leaves alone", () => {
    expect(normalize("Æon Flux")).toBe("aeon flux");
    expect(normalize("Ødipus")).toBe("odipus");
    expect(normalize("Straße")).toBe("strasse");
  });

  test("treats the interpunct in WALL-E as a separator", () => {
    expect(normalize("WALL·E")).toBe("wall e");
  });

  test("handles null and empty input", () => {
    expect(normalize(null)).toBe("");
    expect(normalize(undefined)).toBe("");
    expect(normalize("   ")).toBe("");
  });
});

describe("normalizeStripped", () => {
  test("removes a leading article", () => {
    expect(normalizeStripped("The Matrix")).toBe("matrix");
    expect(normalizeStripped("A Man Called Ove")).toBe("man called ove");
    expect(normalizeStripped("En man som heter Ove")).toBe("man som heter ove");
  });

  test("only strips a LEADING article, never an interior word", () => {
    expect(normalizeStripped("Lord of the Rings")).toBe("lord of the rings");
  });
});

describe("despace", () => {
  test("joins words so a split query still matches", () => {
    // "buda pest" -> "budapest" is how The Grand Budapest Hotel gets found.
    expect(despace("buda pest")).toBe("budapest");
    // "Nile City" -> "nilecity" matches NileCity 105.6
    expect(despace("Nile City")).toBe("nilecity");
  });
});

describe("trigrams", () => {
  test("pads so word boundaries participate", () => {
    const g = trigrams("ab");
    expect(g.has(" ab")).toBe(true);
    expect(g.has("ab ")).toBe(true);
  });

  test("empty string yields an empty set", () => {
    // Padding an empty string gives "  " -- two characters, so no trigram exists.
    expect(trigrams("").size).toBe(0);
  });
});

describe("similarity", () => {
  test("identical strings score 1", () => {
    const a = trigrams("interstellar");
    expect(jaccard(a, a)).toBe(1);
    expect(coverage(a, a)).toBe(1);
    expect(similarity(a, a)).toBeCloseTo(1, 5);
  });

  test("a one-character typo still scores high", () => {
    const s = similarity(trigrams("interstelar"), trigrams("interstellar"));
    expect(s).toBeGreaterThan(0.7);
  });

  test("unrelated strings score low", () => {
    const s = similarity(trigrams("bridgerton"), trigrams("the godfather"));
    expect(s).toBeLessThan(0.2);
  });

  /**
   * Coverage exists precisely for this: Jaccard punishes a short query against a
   * long title, but "shashank" clearly means "The Shawshank Redemption".
   */
  test("coverage rescues a short query against a long title", () => {
    const q = trigrams("shawshank");
    const t = trigrams("shawshank redemption");
    expect(jaccard(q, t)).toBeLessThan(0.6);
    expect(coverage(q, t)).toBeGreaterThan(0.9);
    expect(similarity(q, t)).toBeGreaterThan(jaccard(q, t));
  });

  test("empty sets never divide by zero", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(coverage(new Set(), trigrams("x"))).toBe(0);
  });
});

describe("levenshtein", () => {
  test("counts single edits", () => {
    expect(levenshtein("silo", "sielo")).toBe(1);
    expect(levenshtein("silo", "silo")).toBe(0);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  test("bails out past the cap instead of computing the true distance", () => {
    // Length difference alone exceeds the cap.
    expect(levenshtein("a", "abcdefghij", 2)).toBeGreaterThan(2);
    expect(levenshtein("bridgerton", "the godfather", 2)).toBeGreaterThan(2);
  });

  test("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });

  test("is symmetric", () => {
    expect(levenshtein("silo", "sielo")).toBe(levenshtein("sielo", "silo"));
  });
});
