/**
 * The cast build stage, exercised through the REAL builder against real gzipped dumps.
 *
 * Written against `buildIndex` rather than against `buildCast` directly, because most of
 * what this stage can get wrong lives in the seams: the eligible-title set is read back
 * out of the table the previous stage wrote, the header guard runs inside `streamTsv`,
 * and the person rowids are assigned during one pass and consumed by the next. A unit
 * test of the filtering logic alone would pass while any of those was broken.
 *
 * The fixtures are tiny but they are genuinely gzipped TSVs with genuine headers, so a
 * column reorder upstream fails here the same way it would in production.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { EXPECTED_HEADERS } from "./dumps";
import { buildIndex } from "./index-builder";

const root = mkdtempSync(join(tmpdir(), "finderr-cast-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Config with only the fields the builder reads. */
function configWith(over: Partial<Config["index"]> = {}): Config {
  return {
    index: {
      fuzzyMinVotes: 100,
      titleTypes: ["movie", "tvSeries"],
      includeAdult: false,
      castMinVotes: 1000,
      castCategories: ["actor", "actress", "director", "writer"],
      refreshCron: "",
      refreshOnBoot: false,
      ...over,
    },
  } as Config;
}

/**
 * One dump directory. Rows are given WITHOUT the header -- the header comes from
 * EXPECTED_HEADERS, so a fixture cannot drift from what the guard demands.
 */
function dumpDir(dumps: {
  ratings: string[][];
  basics: string[][];
  principals?: string[][];
  names?: string[][];
}): string {
  const dir = join(root, crypto.randomUUID());
  mkdirSync(dir, { recursive: true });

  const write = (name: keyof typeof EXPECTED_HEADERS, rows: string[][]) => {
    const text = [EXPECTED_HEADERS[name], ...rows.map((r) => r.join("\t"))].join("\n");
    Bun.write(join(dir, `${name}.tsv.gz`), Bun.gzipSync(Buffer.from(`${text}\n`)));
  };

  write("title.ratings", dumps.ratings);
  write("title.basics", dumps.basics);
  if (dumps.principals) write("title.principals", dumps.principals);
  if (dumps.names) write("name.basics", dumps.names);
  return dir;
}

/** basics row: tconst, type, primary, original, isAdult, start, end, runtime, genres */
const basics = (tconst: string, title: string, year: string) => [
  tconst,
  "movie",
  title,
  title,
  "0",
  year,
  "\\N",
  "120",
  "Drama",
];

/** principals row: tconst, ordering, nconst, category, job, characters */
const principal = (
  tconst: string,
  ordering: string,
  nconst: string,
  category: string,
  characters = "\\N",
) => [tconst, ordering, nconst, category, "\\N", characters];

/** names row: nconst, primaryName, birthYear, deathYear, professions, knownFor */
const name = (nconst: string, primary: string, birth = "\\N") => [
  nconst,
  primary,
  birth,
  "\\N",
  "actor",
  "\\N",
];

const POPULAR = "tt0001";
const OBSCURE = "tt0002";

/** One popular title above the floor, one obscure title below it. */
const BASE = {
  ratings: [
    [POPULAR, "8.8", "2000000"],
    [OBSCURE, "6.1", "40"],
  ],
  basics: [basics(POPULAR, "Inception", "2010"), basics(OBSCURE, "Some Short", "1901")],
};

async function build(over: Partial<Config["index"]> = {}, dumps = {}): Promise<Database> {
  const dir = dumpDir({ ...BASE, ...dumps } as Parameters<typeof dumpDir>[0]);
  const dest = join(root, `${crypto.randomUUID()}.db`);
  await buildIndex(configWith(over), dir, dest, () => {});
  return new Database(dest, { readonly: true });
}

const CREDITS = {
  principals: [
    principal(POPULAR, "1", "nm0001", "actor", '["Dom Cobb"]'),
    principal(POPULAR, "2", "nm0002", "director"),
    // Below the floor: this person exists only on the obscure title.
    principal(OBSCURE, "1", "nm0003", "actor"),
    // A category we do not keep, on a title we DO keep.
    principal(POPULAR, "3", "nm0004", "composer"),
  ],
  names: [
    name("nm0001", "Leonardo DiCaprio", "1974"),
    name("nm0002", "Christopher Nolan"),
    name("nm0003", "Nobody"),
    name("nm0004", "Hans Zimmer"),
  ],
};

describe("the cast stage is optional", () => {
  test("no principals dump means a complete title index with no people", async () => {
    const db = await build();
    expect((db.query("select count(*) c from title").get() as { c: number }).c).toBe(2);
    expect((db.query("select count(*) c from title_principal").get() as { c: number }).c).toBe(0);
    expect((db.query("select count(*) c from person").get() as { c: number }).c).toBe(0);
  });

  test("no configured categories skips the stage even with the dumps present", async () => {
    const db = await build({ castCategories: [] }, CREDITS);
    expect((db.query("select count(*) c from title_principal").get() as { c: number }).c).toBe(0);
  });
});

describe("the vote floor", () => {
  test("credits are kept for titles above it and dropped below it", async () => {
    const db = await build({}, CREDITS);
    const rows = db
      .query(
        "select p.nconst, tp.category from title_principal tp join person p on p.rowid_ = tp.person_rowid",
      )
      .all() as { nconst: string; category: string }[];

    // nm0003 is only on the obscure title; nm0004 is a composer.
    expect(rows.map((r) => r.nconst).sort()).toEqual(["nm0001", "nm0002"]);
  });

  test("dropping the floor to 0 picks up the obscure title's cast", async () => {
    const db = await build({ castMinVotes: 0 }, CREDITS);
    const people = (
      db
        .query("select p.nconst from title_principal tp join person p on p.rowid_ = tp.person_rowid")
        .all() as {
        nconst: string;
      }[]
    ).map((r) => r.nconst);
    expect(people).toContain("nm0003");
  });

  test("a person named only by an excluded credit is not stored at all", async () => {
    // Hans Zimmer is in name.basics and on a title we keep, but `composer` is not a
    // kept category -- so he must not become a person page with an empty filmography.
    const db = await build({}, CREDITS);
    expect(db.query("select 1 from person where nconst = 'nm0004'").get()).toBeNull();
  });
});

describe("what a credit row carries", () => {
  test("characters are unwrapped from IMDb's JSON array", async () => {
    const db = await build({}, CREDITS);
    const row = db
      .query(
        "select tp.characters, tp.ordering from title_principal tp join person p on p.rowid_ = tp.person_rowid where p.nconst = 'nm0001'",
      )
      .get() as { characters: string | null; ordering: number };
    expect(row.characters).toBe("Dom Cobb");
    expect(row.ordering).toBe(1);
  });

  test("a missing character list is null, not the literal \\N", async () => {
    const db = await build({}, CREDITS);
    const row = db
      .query(
        "select tp.characters from title_principal tp join person p on p.rowid_ = tp.person_rowid where p.nconst = 'nm0002'",
      )
      .get() as { characters: string | null };
    expect(row.characters).toBeNull();
  });

  test("malformed characters are dropped rather than stored raw", async () => {
    // A literal ["Dom Cobb"] rendered on screen is worse than no character name, and
    // this parse runs 1.4M times so it must never throw.
    const db = await build(
      {},
      {
        principals: [principal(POPULAR, "1", "nm0001", "actor", "not json at all")],
        names: [name("nm0001", "Leonardo DiCaprio")],
      },
    );
    const row = db.query("select characters from title_principal").get() as { characters: string | null };
    expect(row.characters).toBeNull();
  });

  test("multiple characters join into one readable string", async () => {
    const db = await build(
      {},
      {
        principals: [principal(POPULAR, "1", "nm0001", "actor", '["Jekyll","Hyde"]')],
        names: [name("nm0001", "Someone")],
      },
    );
    const row = db.query("select characters from title_principal").get() as { characters: string };
    expect(row.characters).toBe("Jekyll, Hyde");
  });
});

describe("people", () => {
  test("names and birth years land, and the join reaches the title", async () => {
    const db = await build({}, CREDITS);
    const row = db
      .query(
        "select p.name, p.birth_year, t.tconst from title_principal tp " +
          "join person p on p.rowid_ = tp.person_rowid join title t on t.rowid_ = tp.title_rowid " +
          "where p.nconst = 'nm0001'",
      )
      .get() as { name: string; birth_year: number | null; tconst: string };
    expect(row).toEqual({ name: "Leonardo DiCaprio", birth_year: 1974, tconst: POPULAR });
  });

  test("a credit whose person has no name row still exists -- the dumps can disagree", async () => {
    // The two dumps are published minutes apart, so a brand-new nconst can appear in
    // principals before name.basics knows it. Losing the credit would be worse than
    // carrying one with no name attached.
    const db = await build(
      {},
      { principals: [principal(POPULAR, "1", "nm9999", "actor")], names: [name("nm0001", "Someone Else")] },
    );
    expect((db.query("select count(*) c from title_principal").get() as { c: number }).c).toBe(1);
    expect((db.query("select count(*) c from person").get() as { c: number }).c).toBe(0);
  });
});

describe("the reverse index", () => {
  test("person -> filmography is the query the whole table exists for", async () => {
    const db = await build(
      {},
      {
        principals: [principal(POPULAR, "1", "nm0001", "actor"), principal(OBSCURE, "1", "nm0001", "actor")],
        names: [name("nm0001", "Leonardo DiCaprio")],
      },
    );
    // Only the popular title clears the floor, so the filmography is one entry.
    const films = db
      .query(
        "select t.tconst from title_principal tp join person p on p.rowid_ = tp.person_rowid " +
          "join title t on t.rowid_ = tp.title_rowid where p.nconst = ?",
      )
      .all("nm0001") as { tconst: string }[];
    expect(films.map((f) => f.tconst)).toEqual([POPULAR]);
  });

  test("both directions are indexed", async () => {
    // Asserts the index EXISTS, deliberately not that the planner picks it. On a
    // fixture this size SQLite correctly prefers a scan, so an `explain query plan`
    // assertion here would be measuring its row-count heuristic rather than our
    // schema -- it fails on two rows and passes on 1.4M for reasons unrelated to
    // whether anybody remembered to create the index.
    const db = await build({}, CREDITS);
    const indexes = (
      db
        .query("select name from sqlite_master where type = 'index' and tbl_name = 'title_principal'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("ix_tp_person");
    expect(indexes).toContain("ix_tp_title");
  });
});

describe("the cast cadence", () => {
  /**
   * Builds into a REAL data dir so the live-index path (`paths(cfg).db`) exists, which is
   * what `castStage` reads to decide between rescanning and carrying forward.
   */
  async function buildInto(dataDir: string, over: Partial<Config["index"]>, dumps: object) {
    const dir = dumpDir({ ...BASE, ...dumps } as Parameters<typeof dumpDir>[0]);
    const cfg = { ...configWith(over), dataDir } as Config;
    mkdirSync(dataDir, { recursive: true });
    await buildIndex(cfg, dir, join(dataDir, "titles.new.db"), () => {});
    // Promote by hand: the real promote() reads paths(cfg) off a loaded config.
    rmSync(join(dataDir, "titles.db"), { force: true });
    renameSync(join(dataDir, "titles.new.db"), join(dataDir, "titles.db"));
    return new Database(join(dataDir, "titles.db"), { readonly: true });
  }

  test("a second build inside the window carries the cast forward without rescanning", async () => {
    const dataDir = join(root, crypto.randomUUID());
    await buildInto(dataDir, {}, CREDITS);

    // Second build with the principals dump ABSENT. A rescan would find nothing and
    // produce an index with no people; carrying forward keeps them.
    const db = await buildInto(dataDir, {}, { principals: undefined, names: undefined });
    const people = db.query("select nconst from person order by nconst").all() as { nconst: string }[];
    expect(people.map((p) => p.nconst)).toEqual(["nm0001", "nm0002"]);
  });

  /**
   * The age check alone is not enough, and this is the failure it hid: the carried tables
   * are only equivalent to a rescan while the RECIPE that produced them still holds.
   * Widen `castCategories` and the age says "fresh, carry it", so the new categories do
   * not appear until the refresh window happens to expire -- a config change that looks
   * applied, is not, and comes back on its own days later.
   */
  test("widening castCategories forces a rescan instead of carrying the old set", async () => {
    const dataDir = join(root, crypto.randomUUID());
    const narrow = { castCategories: ["actor", "actress", "director", "writer"] };
    await buildInto(dataDir, narrow, CREDITS);

    const db = await buildInto(dataDir, { castCategories: [...narrow.castCategories, "composer"] }, CREDITS);
    const nconsts = (db.query("select nconst from person order by nconst").all() as { nconst: string }[]).map(
      (r) => r.nconst,
    );
    // nm0004 is the composer -- present only if the wider recipe was actually applied.
    expect(nconsts).toContain("nm0004");
  });

  test("changing castMinVotes forces a rescan too", async () => {
    const dataDir = join(root, crypto.randomUUID());
    await buildInto(dataDir, {}, CREDITS);

    const db = await buildInto(dataDir, { castMinVotes: 0 }, CREDITS);
    const nconsts = (db.query("select nconst from person order by nconst").all() as { nconst: string }[]).map(
      (r) => r.nconst,
    );
    // nm0003 sits on the below-floor title, so it only lands once the floor really moved.
    expect(nconsts).toContain("nm0003");
  });

  test("an unchanged recipe still carries forward -- the check is equality, not paranoia", async () => {
    const dataDir = join(root, crypto.randomUUID());
    // Categories given in a different ORDER must still count as the same recipe, or
    // every build rescans and the whole carry-forward saving evaporates.
    await buildInto(dataDir, { castCategories: ["director", "actor"] }, CREDITS);
    const db = await buildInto(
      dataDir,
      { castCategories: ["actor", "director"] },
      { principals: undefined, names: undefined },
    );
    const people = db.query("select nconst from person order by nconst").all() as { nconst: string }[];
    expect(people.map((p) => p.nconst)).toEqual(["nm0001", "nm0002"]);
  });

  test("castRefreshDays 0 always rescans", async () => {
    const dataDir = join(root, crypto.randomUUID());
    await buildInto(dataDir, { castRefreshDays: 0 }, CREDITS);
    // Dump gone and no carry allowed -> no people at all.
    const db = await buildInto(dataDir, { castRefreshDays: 0 }, { principals: undefined, names: undefined });
    expect((db.query("select count(*) c from person").get() as { c: number }).c).toBe(0);
  });

  /**
   * The corruption this guards, and the reason rowids are remapped through tconst:
   * rowids are assigned by insertion order while streaming title.basics, so ONE new
   * title appearing earlier in the file shifts every rowid after it. Carrying the
   * integers straight across would reattribute credits to whatever title now sits at
   * that rowid -- wrong data that looks entirely plausible.
   */
  test("a title inserted ahead of the others does not steal their credits", async () => {
    const dataDir = join(root, crypto.randomUUID());
    await buildInto(dataDir, {}, CREDITS);

    // Rebuild with a NEW popular title sorted before the others in the dump, shifting
    // every subsequent rowid by one.
    const NEWCOMER = "tt0000";
    const shifted = {
      ratings: [[NEWCOMER, "9.0", "3000000"], ...BASE.ratings],
      basics: [basics(NEWCOMER, "Newcomer", "2024"), ...BASE.basics],
      principals: undefined,
      names: undefined,
    };
    const dir = dumpDir(shifted as Parameters<typeof dumpDir>[0]);
    const cfg = { ...configWith({}), dataDir } as Config;
    await buildIndex(cfg, dir, join(dataDir, "titles.new.db"), () => {});
    rmSync(join(dataDir, "titles.db"), { force: true });
    renameSync(join(dataDir, "titles.new.db"), join(dataDir, "titles.db"));
    const db = new Database(join(dataDir, "titles.db"), { readonly: true });

    const rows = db
      .query(
        "select t.tconst, p.nconst from title_principal tp " +
          "join title t on t.rowid_ = tp.title_rowid join person p on p.rowid_ = tp.person_rowid " +
          "order by p.nconst",
      )
      .all() as { tconst: string; nconst: string }[];

    // Both credits still point at the POPULAR title, not at the newcomer that now
    // occupies rowid 1.
    expect(rows).toEqual([
      { tconst: POPULAR, nconst: "nm0001" },
      { tconst: POPULAR, nconst: "nm0002" },
    ]);
    expect(rows.some((r) => r.tconst === NEWCOMER)).toBe(false);
  });

  test("a title that left the index takes its credits with it", async () => {
    const dataDir = join(root, crypto.randomUUID());
    await buildInto(dataDir, { castMinVotes: 0 }, CREDITS);
    // OBSCURE drops out by title type: rebuild keeping only the popular one.
    const dir = dumpDir({
      ratings: BASE.ratings,
      basics: [basics(POPULAR, "Inception", "2010")],
    } as Parameters<typeof dumpDir>[0]);
    const cfg = { ...configWith({ castMinVotes: 0 }), dataDir } as Config;
    await buildIndex(cfg, dir, join(dataDir, "titles.new.db"), () => {});
    const db = new Database(join(dataDir, "titles.new.db"), { readonly: true });
    // nm0003 was only on the obscure title, so its credit is gone -- there is no page
    // for it to appear on.
    const nconsts = (
      db
        .query("select distinct p.nconst from title_principal tp join person p on p.rowid_ = tp.person_rowid")
        .all() as { nconst: string }[]
    ).map((r) => r.nconst);
    expect(nconsts).not.toContain("nm0003");
  });
});

describe("schema drift", () => {
  test("a reordered principals column is refused rather than ingested", async () => {
    const dir = dumpDir({ ...BASE, ...CREDITS });
    // Rewrite the header with two columns swapped -- exactly the failure the guard is
    // for, and the one no row count would ever catch.
    const bad = ["tconst\tordering\tcategory\tnconst\tjob\tcharacters", "tt0001\t1\tactor\tnm0001\t\\N\t\\N"];
    await Bun.write(join(dir, "title.principals.tsv.gz"), Bun.gzipSync(Buffer.from(`${bad.join("\n")}\n`)));

    await expect(
      buildIndex(configWith(), dir, join(root, `${crypto.randomUUID()}.db`), () => {}),
    ).rejects.toThrow(/schema drift in title\.principals/);
  });
});
