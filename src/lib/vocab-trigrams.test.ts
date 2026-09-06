/**
 * The trigram shortlist, without the extension.
 *
 * FTS5 and its `trigram` tokenizer are built into every SQLite this repo runs on, so the
 * shortlist half of the fuzzy tier is testable on a fixture with nothing loaded. The distance
 * half is spellfix1's and is measured by the canary against the real index, not here.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  buildVocabTrigrams,
  rarestTrigrams,
  TRIGRAM_DF_TABLE,
  TRIGRAM_KEEP,
  TRIGRAM_TABLE,
  trigramMatchExpr,
  trigramShortlistSql,
  trigramsOf,
} from "./vocab-trigrams";

describe("trigramsOf", () => {
  test("distinct, in order of first appearance, spaces included", () => {
    expect(trigramsOf("abcab")).toEqual(["abc", "bca", "cab"]);
    expect(trigramsOf("the the")).toEqual(["the", "he ", "e t", " th"]);
  });

  test("shorter than three characters has no trigram", () => {
    expect(trigramsOf("")).toEqual([]);
    expect(trigramsOf("ab")).toEqual([]);
  });
});

describe("rarestTrigrams", () => {
  const df = (g: string) => ({ the: 26168, ing: 15654, ren: 900, dre: 400, och: 80, xqz: 0 })[g] ?? 1;

  test("keeps the rarest, drops what the vocabulary never contains", () => {
    expect(rarestTrigrams(["the", "xqz", "och", "ing", "dre"], df, 2)).toEqual(["och", "dre"]);
  });

  test("ties keep first appearance, so one query always chooses one set", () => {
    expect(rarestTrigrams(["bbb", "aaa", "ccc"], df, 2)).toEqual(["bbb", "aaa"]);
  });

  test("the default keep is the measured eight", () => {
    const grams = Array.from({ length: 12 }, (_, i) => `g${String(i).padStart(2, "0")}`);
    expect(rarestTrigrams(grams, df)).toHaveLength(TRIGRAM_KEEP);
    expect(TRIGRAM_KEEP).toBe(8);
  });
});

describe("trigramMatchExpr", () => {
  test("every trigram is a quoted string, so a space or digit is a token and not syntax", () => {
    expect(trigramMatchExpr(["he ", "2 f", "abc"])).toBe('"he " OR "2 f" OR "abc"');
  });

  test("a double quote is doubled rather than trusted not to occur", () => {
    expect(trigramMatchExpr(['a"b'])).toBe('"a""b"');
  });
});

describe("buildVocabTrigrams + shortlist", () => {
  /** A vocabulary-shaped fixture: a plain table whose rowid/word the builder reads. */
  function fixture(words: string[]): Database {
    const db = new Database(":memory:");
    db.run("create table vocab (id integer primary key, word text not null)");
    const ins = db.prepare("insert into vocab (id, word) values (?, ?)");
    for (const [i, w] of words.entries()) ins.run(i + 1, w);
    buildVocabTrigrams(db, () => {});
    return db;
  }

  const WORDS = ["adrenochrome", "andrei rublev", "enders game", "antichrist", "the matrix", "interstellar"];

  test("builds the table and a frequency row per distinct trigram", () => {
    const db = fixture(WORDS);
    const n = (db.query(`select count(*) c from ${TRIGRAM_DF_TABLE}`).get() as { c: number }).c;
    const all = new Set(WORDS.flatMap(trigramsOf));
    expect(n).toBe(all.size);
    // A DOCUMENT count: `chr` is in adrenochrome and antichrist, `ome` in one word only.
    expect(db.query(`select n from ${TRIGRAM_DF_TABLE} where tri = 'chr'`).get()).toEqual({ n: 2 });
    expect(db.query(`select n from ${TRIGRAM_DF_TABLE} where tri = 'ome'`).get()).toEqual({ n: 1 });
    expect(db.query(`select n from ${TRIGRAM_DF_TABLE} where tri = 'zzz'`).get()).toBeNull();
    expect(db.query(`select count(*) c from ${TRIGRAM_TABLE}`).get()).toEqual({ c: WORDS.length });
  });

  test("a front-of-word typo shortlists the word the phonetic bucket loses", () => {
    // The reported case: one inserted letter, and spellfix1 at its default scope had it in
    // none of 300 candidates. Trigrams do not care where the edit is.
    const db = fixture(WORDS);
    const df = db.prepare(`select n from ${TRIGRAM_DF_TABLE} where tri = ?`);
    const grams = rarestTrigrams(
      trigramsOf("andrenochrome"),
      (g) => (df.get(g) as { n: number } | null)?.n ?? 0,
    );
    const ids = (db.query(trigramShortlistSql()).all(trigramMatchExpr(grams), 300) as { id: number }[]).map(
      (r) => r.id,
    );
    expect(ids[0]).toBe(WORDS.indexOf("adrenochrome") + 1);
  });

  test("a query sharing no trigram with the vocabulary shortlists nothing", () => {
    const db = fixture(WORDS);
    const df = db.prepare(`select n from ${TRIGRAM_DF_TABLE} where tri = ?`);
    const grams = rarestTrigrams(
      trigramsOf("xyzzyplughfoo"),
      (g) => (df.get(g) as { n: number } | null)?.n ?? 0,
    );
    expect(grams).toEqual([]);
  });

  test("rebuilding is idempotent, because the vocab job re-runs it in place", () => {
    const db = fixture(WORDS);
    buildVocabTrigrams(db, () => {});
    expect(db.query(`select count(*) c from ${TRIGRAM_TABLE}`).get()).toEqual({ c: WORDS.length });
  });
});
