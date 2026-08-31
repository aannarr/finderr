import { describe, expect, test } from "bun:test";
import {
  AWARDS_HEADER,
  AwardsSchemaDriftError,
  ceremonyTimeline,
  groupByCategory,
  isPersonId,
  isTitleId,
  type Nomination,
  parseAwards,
  personAwards,
  titleAwards,
} from "./awards";

/**
 * A row in the source's own shape, with trailing columns OMITTED the way the real file
 * omits them. That raggedness is the point of building fixtures this way: a fixture that
 * pads every line to 14 fields would pass a parser that silently loses every `Winner`.
 */
function line(cells: (string | number)[]): string {
  return cells.map(String).join("\t");
}

const HEADER = AWARDS_HEADER;

describe("parseAwards", () => {
  test("refuses a changed header rather than ingesting shifted columns", () => {
    const wrong = HEADER.replace("Film\tFilmId", "FilmId\tFilm");
    expect(() => parseAwards(`${wrong}\n`)).toThrow(AwardsSchemaDriftError);
  });

  test("refuses an empty file", () => {
    expect(() => parseAwards("")).toThrow(AwardsSchemaDriftError);
  });

  test("reads a row whose trailing columns are omitted", () => {
    // Ten fields, which is the commonest shape in the real file: everything from `Winner`
    // onward is simply absent. A parser that indexes without defaulting reads `undefined`
    // for `Winner` here and loses the win.
    const text = [
      HEADER,
      line([98, "2025", "Production", "BEST PICTURE", "BEST PICTURE", "Anora", "tt28607951", "", "", ""]),
    ].join("\n");
    const rows = parseAwards(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.won).toBe(false);
    expect(rows[0]?.detail).toBeNull();
    expect(rows[0]?.note).toBeNull();
  });

  test("Winner is compared exactly, so only 'True' is a win", () => {
    const text = [
      HEADER,
      line([1, "1927/28", "Production", "BEST PICTURE", "BEST PICTURE", "A", "tt1", "", "", "", "True"]),
      line([1, "1927/28", "Production", "BEST PICTURE", "BEST PICTURE", "B", "tt2", "", "", "", "False"]),
      line([1, "1927/28", "Production", "BEST PICTURE", "BEST PICTURE", "C", "tt3", "", "", "", ""]),
    ].join("\n");
    expect(parseAwards(text).map((r) => r.won)).toEqual([true, false, false]);
  });

  test("keeps the year string verbatim, slash and all", () => {
    const text = [
      HEADER,
      line([1, "1927/28", "Acting", "ACTOR IN A LEADING ROLE", "ACTOR", "The Noose", "tt0019217"]),
    ].join("\n");
    // Routing on this would be the bug. It is a label beside the ceremony number.
    expect(parseAwards(text)[0]?.year).toBe("1927/28");
  });

  test("a company id in NomineeIds never becomes a person id", () => {
    // The real trap: "Metro-Goldwyn-Mayer|Douglas Shearer" carries "co0007143|nm0790428".
    // Linking the company would send a reader to a person page that cannot exist.
    const text = [
      HEADER,
      line([
        9,
        "1936",
        "Special",
        "SOUND RECORDING",
        "SOUND RECORDING",
        "Naughty Marietta",
        "tt0026596",
        "",
        "Metro-Goldwyn-Mayer|Douglas Shearer",
        "co0007143|nm0790428",
        "True",
      ]),
    ].join("\n");
    const row = parseAwards(text)[0];
    expect(row?.nominees).toEqual(["Metro-Goldwyn-Mayer", "Douglas Shearer"]);
    // Position is preserved: the studio keeps its slot as plain text and only the person
    // carries an id. Filtering the company out instead would put `nm0790428` on the studio.
    expect(row?.nconsts).toEqual([null, "nm0790428"]);
  });

  test("a nomination naming several films keeps titles and ids aligned", () => {
    const text = [
      HEADER,
      line([
        1,
        "1927/28",
        "Acting",
        "ACTRESS IN A LEADING ROLE",
        "ACTRESS",
        "7th Heaven|Street Angel|Sunrise",
        "tt0018379|tt0019429|tt0018455",
        "Janet Gaynor",
        "Janet Gaynor",
        "nm0000000",
        "True",
      ]),
    ].join("\n");
    const row = parseAwards(text)[0];
    expect(row?.films).toEqual(["7th Heaven", "Street Angel", "Sunrise"]);
    expect(row?.filmIds).toEqual(["tt0018379", "tt0019429", "tt0018455"]);
  });

  test("a missing FilmId is null, not a guess", () => {
    const text = [
      HEADER,
      line([1, "1927/28", "Special", "SPECIAL AWARD", "SPECIAL AWARD", "", "", "Charles Chaplin"]),
    ].join("\n");
    const row = parseAwards(text)[0];
    expect(row?.films).toEqual([]);
    expect(row?.filmIds).toEqual([]);
  });

  test("seq counts within a ceremony, not across the file", () => {
    const text = [
      HEADER,
      line([1, "1927/28", "Production", "BEST PICTURE", "BEST PICTURE", "A", "tt1"]),
      line([1, "1927/28", "Directing", "DIRECTING", "DIRECTING", "B", "tt2"]),
      line([2, "1928/29", "Production", "BEST PICTURE", "BEST PICTURE", "C", "tt3"]),
    ].join("\n");
    expect(parseAwards(text).map((r) => [r.ceremony, r.seq])).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
  });
});

describe("id shapes", () => {
  test("only nm and tt ids are ours to link", () => {
    expect(isPersonId("nm0000138")).toBe(true);
    expect(isPersonId("co0007143")).toBe(false);
    expect(isPersonId("nm")).toBe(false);
    expect(isTitleId("tt0068646")).toBe(true);
    expect(isTitleId("nm0000138")).toBe(false);
  });
});

/** A nomination with only the fields a given test cares about. */
function nom(over: Partial<Nomination>): Nomination {
  return {
    award: "oscars",
    ceremony: 98,
    seq: 0,
    year: "2025",
    className: "Title",
    category: "BEST PICTURE",
    rawCategory: "BEST PICTURE",
    films: [],
    filmIds: [],
    nominees: [],
    nconsts: [],
    won: false,
    detail: null,
    note: null,
    ...over,
  };
}

describe("groupByCategory", () => {
  test("winner first inside a category, announcement order behind it", () => {
    const groups = groupByCategory([
      nom({ seq: 0, films: ["Loser A"] }),
      nom({ seq: 1, films: ["Loser B"] }),
      nom({ seq: 2, films: ["Winner"], won: true }),
    ]);
    expect(groups[0]?.nominations.map((n) => n.films[0])).toEqual(["Winner", "Loser A", "Loser B"]);
  });

  test("Best Picture leads, then the source's own class order", () => {
    const groups = groupByCategory([
      nom({ seq: 0, category: "MUSIC (Original Score)", className: "Music" }),
      nom({ seq: 1, category: "DIRECTING", className: "Directing" }),
      nom({ seq: 2, category: "BEST PICTURE", className: "Title" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["BEST PICTURE", "DIRECTING", "MUSIC (Original Score)"]);
  });

  test("groups on the canonical name, so a renamed category is one award", () => {
    // "ACTOR" became "ACTOR IN A LEADING ROLE". Grouping on the raw name splits one award
    // into two and makes every count that spans the rename wrong.
    const groups = groupByCategory([
      nom({ seq: 0, category: "ACTOR IN A LEADING ROLE", rawCategory: "ACTOR", className: "Acting" }),
      nom({
        seq: 1,
        category: "ACTOR IN A LEADING ROLE",
        rawCategory: "ACTOR IN A LEADING ROLE",
        className: "Acting",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.nominations).toHaveLength(2);
  });
});

/** An `AwardReader` over an in-memory list, which is all the assembly layer needs. */
function reader(rows: Nomination[]) {
  const byCeremony = (c: number) => rows.filter((r) => r.ceremony === c);
  return {
    awardCeremonyCounts: () => {
      const out = new Map<number, ReturnType<typeof summary>>();
      const summary = (c: number) => {
        const rs = byCeremony(c);
        const films = new Set(rs.flatMap((r) => r.filmIds.filter((i): i is string => i !== null)));
        return {
          ceremony: c,
          year: rs[0]?.year ?? "",
          nominations: rs.length,
          wins: rs.filter((r) => r.won).length,
          categories: new Set(rs.map((r) => r.category)).size,
          films: films.size,
          filmsOwned: 0,
        };
      };
      for (const r of rows) if (!out.has(r.ceremony)) out.set(r.ceremony, summary(r.ceremony));
      return [...out.values()].sort((a, b) => b.ceremony - a.ceremony);
    },
    awardCategoryWinners: (_a: string, category: string) =>
      rows.filter((r) => r.won && r.category === category).sort((a, b) => b.ceremony - a.ceremony),
    awardRowsForFilmAtCeremony: (_a: string, ceremony: number, tconst: string) =>
      byCeremony(ceremony).filter((r) => r.filmIds.includes(tconst)),
    awardRowsForTitle: (_a: string, tconst: string) => rows.filter((r) => r.filmIds.includes(tconst)),
    awardRowsForPerson: (_a: string, nconst: string) => rows.filter((r) => r.nconsts.includes(nconst)),
  };
}

describe("ceremonyTimeline", () => {
  const rows = [
    nom({ ceremony: 98, seq: 0, category: "BEST PICTURE", films: ["Anora"], filmIds: ["tt1"], won: true }),
    nom({
      ceremony: 98,
      seq: 1,
      category: "DIRECTING",
      className: "Directing",
      films: ["Anora"],
      filmIds: ["tt1"],
      won: true,
    }),
    nom({ ceremony: 98, seq: 2, category: "ACTOR IN A LEADING ROLE", films: ["Anora"], filmIds: ["tt1"] }),
    nom({ ceremony: 97, seq: 0, category: "BEST PICTURE", films: ["Other"], filmIds: ["tt2"], won: true }),
  ];

  test("newest ceremony first, anchored on the Best Picture winner", () => {
    const t = ceremonyTimeline(reader(rows));
    expect(t.map((c) => c.ceremony)).toEqual([98, 97]);
    expect(t[0]?.bestPictureTconst).toBe("tt1");
    expect(t[0]?.bestPictureTitle).toBe("Anora");
  });

  test("the anchor's own record counts every category it was in", () => {
    const t = ceremonyTimeline(reader(rows));
    expect(t[0]?.bestPictureNominations).toBe(3);
    expect(t[0]?.bestPictureWins).toBe(2);
  });

  test("'also won' never repeats the headline category", () => {
    // BEST PICTURE is printed directly above the line, so listing it again is one fact
    // twice.
    expect(ceremonyTimeline(reader(rows))[0]?.bestPictureAlsoWon).toEqual(["DIRECTING"]);
  });

  test("a ceremony whose anchor has no id still renders its counts", () => {
    const t = ceremonyTimeline(
      reader([nom({ ceremony: 1, category: "BEST PICTURE", films: ["Wings"], filmIds: [], won: true })]),
    );
    expect(t[0]?.bestPictureTconst).toBeNull();
    expect(t[0]?.bestPictureTitle).toBe("Wings");
    expect(t[0]?.nominations).toBe(1);
  });
});

describe("titleAwards and personAwards", () => {
  const rows = [
    nom({
      ceremony: 98,
      seq: 0,
      category: "BEST PICTURE",
      films: ["Anora"],
      filmIds: ["tt1"],
      nominees: ["Sean Baker"],
      nconsts: ["nm1"],
      won: true,
    }),
    nom({
      ceremony: 98,
      seq: 1,
      category: "DIRECTING",
      films: ["Anora"],
      filmIds: ["tt1"],
      nominees: ["Sean Baker"],
      nconsts: ["nm1"],
    }),
  ];

  test("a title with no nominations is null, so the pane disappears entirely", () => {
    expect(titleAwards(reader(rows), "tt9999")).toBeNull();
    expect(personAwards(reader(rows), "nm9999")).toBeNull();
  });

  test("counts wins apart from nominations", () => {
    expect(titleAwards(reader(rows), "tt1")).toMatchObject({ nominations: 2, wins: 1 });
    expect(personAwards(reader(rows), "nm1")).toMatchObject({ nominations: 2, wins: 1 });
  });

  test("a person entry names the film with our id where we have one", () => {
    const p = personAwards(reader(rows), "nm1");
    expect(p?.entries[0]?.films).toEqual([{ title: "Anora", tconst: "tt1" }]);
  });
});
