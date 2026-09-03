/**
 * Award nominations: the `oscar_data` parse, and the shapes every award page reads.
 *
 * The subsystem exists because the sources join on ids we already speak. `FilmId` is a
 * `tconst` and lands on the title index; `NomineeIds` is an `nconst` and lands on the person
 * tables the cast build shipped. **There is no title matching anywhere in this file and there
 * must never be one** -- a row whose id we do not hold renders as plain text, never as a
 * guess, which is the same rule `nconstsByNameForTitle` follows when two people share a name
 * on one title.
 *
 * Nothing here reaches the network: fetching belongs to `./award-import`, and the pages read
 * rows the job already wrote, like every other mirror in this product.
 *
 * WHICH awards exist, where each one's rows come from and what each one anchors its timeline
 * on all live in `./award-registry`. This file knows the SHAPE of a nomination and nothing
 * about the Academy -- which is what let a second and a third award arrive without it
 * changing.
 */

import type { AwardDef } from "./award-registry";

export interface AwardSourceMeta {
  /** Repo commit the rows were parsed from, or `null` when there is no commit to name. */
  sha: string | null;
  /** The exact URL fetched -- pinned to `sha` when we have one, `main` when we do not. */
  url: string;
  licence: string;
  attribution: string;
  /** When WE imported, which is not when the source last changed. */
  importedAt: string;
  /** Committer date of `sha`, when known -- the honest "data as of". */
  sourceDate: string | null;
  rows: number;
  /**
   * The exact query the rows came from, for a source that has no revision to pin.
   *
   * Wikidata has no commit and no version: it is a database that changed while you read this
   * sentence. So the honest provenance is the QUERY and the moment it ran, and a page that
   * shows one shows both. `null` for a source that can name a commit instead.
   */
  query: string | null;
}

/**
 * The header the file MUST present, verbatim.
 *
 * Same rule and same reason as `EXPECTED_HEADERS` in `./dumps.ts`: a reordered column
 * would poison every row in a way no count could catch -- `Film` and `Name` are both
 * free text, so a swap between them parses cleanly and reads as nonsense. Refuse loudly
 * instead, and leave whatever is already stored alone.
 */
export const AWARDS_HEADER =
  "Ceremony\tYear\tClass\tCanonicalCategory\tCategory\tFilm\tFilmId\tName\tNominees\tNomineeIds\tWinner\tDetail\tNote\tCitation";

export class AwardsSchemaDriftError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      "schema drift in oscars.csv\n" +
        `  expected: ${expected.replace(/\t/g, " | ")}\n` +
        `  actual:   ${actual.replace(/\t/g, " | ")}\n` +
        "Refusing to ingest -- columns may have shifted. The stored nominations are untouched.",
    );
    this.name = "AwardsSchemaDriftError";
  }
}

/**
 * One nomination, as parsed and as stored.
 *
 * `films`/`filmIds` and `nominees`/`nconsts` are PARALLEL arrays rather than a list of
 * pairs, because that is how the source carries them (`|`-joined, and their lengths were
 * measured equal across all 12,137 rows) and because the render side wants the printed
 * name whether or not there is an id behind it. An entry with `null` at its id position
 * is the ordinary case, not a defect: about 1,281 rows carry no `FilmId` at all.
 */
export interface Nomination {
  award: string;
  ceremony: number;
  /**
   * The source's own year string, and it is NOT a number: the first six ceremonies read
   * `1927/28`. Displayed, never parsed, never routed on -- the ceremony number is the
   * stable key and this is the label beside it.
   */
  year: string;
  /** `Acting`, `Directing`, `Music`, ... The source's own coarse grouping. */
  className: string;
  /**
   * `CanonicalCategory` -- THE grouping key, and never `Category`.
   *
   * The raw name changes across eras ("ACTOR" became "ACTOR IN A LEADING ROLE"), so
   * grouping on it splits one award into several and makes a person's win count wrong.
   */
  category: string;
  /** `Category` -- the name as it was actually awarded that year. Shown, never grouped on. */
  rawCategory: string;
  /** Film titles as printed, in source order. Empty when the nomination names no film. */
  films: string[];
  /** `tconst` per entry in `films`, `null` where the source has none. */
  filmIds: (string | null)[];
  /** Nominee names as printed. May include studios -- see `nconsts`. */
  nominees: string[];
  /**
   * `nconst` per entry in `nominees`, `null` where there is none OR where the id is a
   * COMPANY.
   *
   * The source mixes `nm...` and `co...` in one column: "Metro-Goldwyn-Mayer|Douglas
   * Shearer" carries `co0007143|nm0790428`. A `co` id is not a person, so linking one
   * would send a reader to a person page that cannot exist. It is dropped to `null` and
   * the studio's name survives as plain text, which is the correct answer.
   */
  nconsts: (string | null)[];
  won: boolean;
  /** The source's own free-text qualifier, e.g. a song title. Null when empty. */
  detail: string | null;
  /** The source's editorial note about the row, usually about an odd early ceremony. */
  note: string | null;
  /**
   * Position of this row within its ceremony, in SOURCE order.
   *
   * Part of the key, and it has to be: `(award, ceremony, category, tconst|nconst)` is
   * not unique -- a Special Award with neither a film nor a nominee occurs several times
   * in one ceremony (528 rows carry neither id). An ordinal makes the key total and keeps
   * the category listing in the order the Academy announced it.
   */
  seq: number;
}

/** A person id in this source, as opposed to the company ids it mixes in. */
export function isPersonId(id: string): boolean {
  return /^nm\d+$/.test(id);
}

/** A title id in this source. */
export function isTitleId(id: string): boolean {
  return /^tt\d+$/.test(id);
}

/**
 * Split a `|`-joined field, preserving position.
 *
 * Position matters because the name list and the id list are read together: dropping an
 * empty entry would slide every id after it onto the wrong name.
 */
function splitField(raw: string): string[] {
  return raw === "" ? [] : raw.split("|");
}

/**
 * Parse the whole TSV.
 *
 * > [!IMPORTANT] Lines are RAGGED and that is not corruption
 * > Trailing empty columns are omitted rather than written as bare tabs, so a line has
 * > anywhere from 8 to 14 fields (measured: 6,266 of them have exactly 10). Splitting and
 * > indexing without padding reads `undefined` for `Winner` on most rows, which silently
 * > loses every win. Every field is defaulted to `""` here for exactly that reason.
 *
 * Despite the `.csv` name it is tab-separated and carries no quoting at all -- verified
 * by parsing it: zero embedded tabs, zero embedded newlines, so a full CSV reader would
 * be machinery for a problem this file does not have.
 */
export function parseAwards(text: string, award: string): Nomination[] {
  const lines = text.split("\n").filter((l) => l !== "");
  const header = lines[0];
  if (header === undefined) throw new AwardsSchemaDriftError(AWARDS_HEADER, "(empty file)");
  if (header.trimEnd() !== AWARDS_HEADER) throw new AwardsSchemaDriftError(AWARDS_HEADER, header);

  const columns = AWARDS_HEADER.split("\t");
  // Per-ceremony, so `seq` is the row's position in ITS ceremony rather than in the file.
  // That makes the key readable and stable when an earlier ceremony gains a corrected row.
  const seqOf = new Map<number, number>();
  const out: Nomination[] = [];

  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const f = (name: string) => cells[columns.indexOf(name)] ?? "";

    const ceremony = Number.parseInt(f("Ceremony"), 10);
    if (!Number.isFinite(ceremony)) continue;

    const seq = seqOf.get(ceremony) ?? 0;
    seqOf.set(ceremony, seq + 1);

    const films = splitField(f("Film"));
    const filmIds = splitField(f("FilmId"));
    const nominees = splitField(f("Nominees"));
    const nomineeIds = splitField(f("NomineeIds"));

    out.push({
      award,
      ceremony,
      year: f("Year"),
      className: f("Class"),
      category: f("CanonicalCategory"),
      rawCategory: f("Category"),
      films,
      // Read POSITIONALLY against `films`, so a shorter id list leaves trailing nulls
      // rather than shifting. Anything that is not a `tt` is dropped to null.
      filmIds: films.map((_, i) => {
        const id = filmIds[i];
        return id && isTitleId(id) ? id : null;
      }),
      nominees,
      nconsts: nominees.map((_, i) => {
        const id = nomineeIds[i];
        return id && isPersonId(id) ? id : null;
      }),
      // The column is `True` or empty. Compared exactly rather than truthily, so a future
      // `False` cannot read as a win.
      won: f("Winner") === "True",
      detail: f("Detail") || null,
      note: f("Note") || null,
      seq,
    });
  }

  return out;
}

// --- the shapes the pages read ---------------------------------------------

/**
 * One edition as the timeline draws it.
 *
 * The ANCHOR is the edition's headline win -- Best Picture at the Oscars, the single prize at
 * Cannes. It is a `tconst` and nothing more: the timeline resolves it against the live index
 * itself, because a card needs a poster and library state that this table does not hold and
 * must not copy.
 *
 * The fields were called `bestPicture*` while the Oscars were the only award. They are named
 * for the ROLE now, because "the Best Picture of the 2019 Cannes festival" is a sentence with
 * no meaning and a payload should not contain one.
 */
export interface CeremonySummary {
  award: string;
  ceremony: number;
  year: string;
  nominations: number;
  wins: number;
  categories: number;
  /**
   * The anchor winner's tconst, or `null`.
   *
   * Null happens for real: the first Academy Awards gave `UNIQUE AND ARTISTIC PICTURE`
   * alongside what is now Best Picture, and a nomination without a `FilmId` cannot anchor
   * anything. A row with no anchor draws its year and its counts, which is honest.
   */
  anchorTconst: string | null;
  anchorTitle: string | null;
  /** Wins in other categories for the same title, for the "also won" line. Canonical names. */
  anchorAlsoWon: string[];
  /** Nominations the anchor winner took that year, across every category. */
  anchorNominations: number;
  anchorWins: number;
  /** Distinct titles with a tconst in this edition, and how many of them we hold. */
  films: number;
  filmsOwned: number;
}

/** Every nomination in one category of one ceremony, winner first. */
export interface CategoryGroup {
  category: string;
  nominations: Nomination[];
}

/**
 * A person's award record, as the person page prints it.
 *
 * Counted over CANONICAL categories, which is what makes "won 2" the number a reader
 * would agree with -- grouping on the raw name would count one award twice for anybody
 * whose category was renamed mid-career.
 */
export interface PersonAwards {
  award: string;
  nominations: number;
  wins: number;
  /** Every nomination, newest ceremony first. Small enough to send whole: the record holder has 59. */
  entries: PersonAwardEntry[];
}

export interface PersonAwardEntry {
  ceremony: number;
  year: string;
  category: string;
  won: boolean;
  /** What it was for. Films as printed, with our id where we have one. */
  films: { title: string; tconst: string | null }[];
  detail: string | null;
}

/** A title's award record, as the title pane prints it. */
export interface TitleAwards {
  award: string;
  nominations: number;
  wins: number;
  /** Newest ceremony first -- a film is usually nominated at exactly one. */
  entries: TitleAwardEntry[];
}

export interface TitleAwardEntry {
  ceremony: number;
  year: string;
  category: string;
  won: boolean;
  /** Who it was for. Names as printed, with our id only where the source gave a person. */
  nominees: { name: string; nconst: string | null }[];
  detail: string | null;
}

/**
 * Order the categories of an edition the way the edition reads.
 *
 * The anchor category first because it is what the timeline already leads with, then the
 * source's own `Class` grouping, then the canonical name. Deliberately NOT the source's row
 * order: that is the file's order, which drifts between eras and would reshuffle the page
 * between ceremonies for no reason a reader could see.
 *
 * `CLASS_ORDER` is `oscar_data`'s own `Class` vocabulary and stays here beside the parse that
 * reads it. It is a FALLBACK ordering rather than a rule about the Academy: a source that
 * carries no class leaves every group unranked and falls through to the name, which is the
 * right answer for a single-category award where there is nothing to order.
 */
const CLASS_ORDER = ["Production", "Directing", "Acting", "Writing", "Music", "Title", "Special", "SciTech"];

export function orderCategories(groups: CategoryGroup[], anchorCategory: string | null): CategoryGroup[] {
  const rank = (g: CategoryGroup) => {
    if (anchorCategory !== null && g.category === anchorCategory) return -1;
    const cls = g.nominations[0]?.className ?? "";
    const i = CLASS_ORDER.indexOf(cls);
    return i === -1 ? CLASS_ORDER.length : i;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b) || a.category.localeCompare(b.category));
}

/**
 * Group an edition's rows by canonical category, winner first inside each.
 *
 * Winner first rather than source order: a category is read to find out who won, and the
 * winner sitting fourth is the answer buried in the middle. Ties keep source order, which
 * is the announcement order and the only meaningful one the file carries.
 */
export function groupByCategory(rows: Nomination[], anchorCategory: string | null): CategoryGroup[] {
  const by = new Map<string, Nomination[]>();
  for (const r of rows) {
    const list = by.get(r.category);
    if (list) list.push(r);
    else by.set(r.category, [r]);
  }
  return orderCategories(
    [...by].map(([category, nominations]) => ({
      category,
      nominations: [...nominations].sort((a, b) => Number(b.won) - Number(a.won) || a.seq - b.seq),
    })),
    anchorCategory,
  );
}

// --- page assembly ---------------------------------------------------------
//
// Module-level functions over a narrow PORT rather than methods on `Store`, deliberately
// mirroring `browseIndex` and `personPage`: the policy is then testable against a handful
// of rows in a temp database instead of against a real import, and a test that needs a
// 2.2 MB download is a test nobody runs.

/** Exactly what the assembly below reads. `Store` satisfies it; a test fake can too. */
export interface AwardReader {
  awardCeremonyCounts(award: string): {
    ceremony: number;
    year: string;
    nominations: number;
    wins: number;
    categories: number;
    films: number;
    filmsOwned: number;
  }[];
  /**
   * The winning rows of an award, newest edition first, optionally within one category.
   *
   * `null` for the category means EVERY win, which is the shape a winner-only award needs:
   * the Palme d'Or has one prize per festival, so filtering by category would be filtering a
   * set of one and would need a category name that only exists because we invented it.
   */
  awardWinners(award: string, category: string | null): Nomination[];
  awardRowsForFilmAtCeremony(award: string, ceremony: number, tconst: string): Nomination[];
  awardRowsForTitle(award: string, tconst: string): Nomination[];
  awardRowsForPerson(award: string, nconst: string): Nomination[];
}

/**
 * Every edition, newest first, each with its anchor title and the counts around it.
 *
 * Costs four queries total regardless of how many editions there are -- the counts, the
 * winners, and one pass for the anchor titles' own records. It deliberately does NOT
 * resolve a poster or library state for the anchor: those come from the live index and
 * the decorate path, which is the caller's job and the reason this returns a `tconst`.
 *
 * The award arrives as a DEFINITION rather than an id, because the anchor is the one thing
 * the tables cannot answer for themselves and the registry is where that answer lives.
 */
export function ceremonyTimeline(reader: AwardReader, def: AwardDef): CeremonySummary[] {
  const winners = new Map<number, Nomination>();
  for (const w of reader.awardWinners(def.id, def.anchorCategory)) {
    // First writer wins: the query is ordered by seq within an edition, and an edition with
    // two rows flagged as winning is either a source oddity (the Oscars) or a genuine tie
    // (Cannes, nine times). Both render as the first row rather than being arbitrated here.
    if (!winners.has(w.ceremony)) winners.set(w.ceremony, w);
  }

  return reader.awardCeremonyCounts(def.id).map((c) => {
    const win = winners.get(c.ceremony);
    const tconst = win?.filmIds.find((id) => id !== null) ?? null;
    // Everything the anchor title itself did that year, which is where "13 nominations,
    // 7 wins" and the "also won" line come from. Only asked when there is an id to ask
    // about -- a winner with no tconst still prints its title and its year.
    const own = tconst ? reader.awardRowsForFilmAtCeremony(def.id, c.ceremony, tconst) : [];
    return {
      award: def.id,
      ceremony: c.ceremony,
      year: c.year,
      nominations: c.nominations,
      wins: c.wins,
      categories: c.categories,
      anchorTconst: tconst,
      anchorTitle: win?.films[0] ?? null,
      // The anchor's own category is dropped from its "also won" line -- it is the headline
      // directly above, and repeating it there is the same fact twice. A winner-only award
      // has no other category to list, so the line is empty and the page draws nothing.
      anchorAlsoWon: own.filter((n) => n.won && n.category !== win?.category).map((n) => n.category),
      anchorNominations: own.length,
      anchorWins: own.filter((n) => n.won).length,
      films: c.films,
      filmsOwned: c.filmsOwned,
    };
  });
}

/**
 * One title's award record.
 *
 * `null` rather than an empty record when the title has none, so the pane disappears down
 * the ordinary empty path instead of drawing a heading over "0 nominations". A film with
 * no Oscar history is the overwhelming majority of the index and is not a gap.
 */
export function titleAwards(reader: AwardReader, tconst: string, award: string): TitleAwards | null {
  const rows = reader.awardRowsForTitle(award, tconst);
  if (rows.length === 0) return null;
  return {
    award,
    nominations: rows.length,
    wins: rows.filter((r) => r.won).length,
    entries: rows.map((r) => ({
      ceremony: r.ceremony,
      year: r.year,
      category: r.category,
      won: r.won,
      nominees: r.nominees.map((name, i) => ({ name, nconst: r.nconsts[i] ?? null })),
      detail: r.detail,
    })),
  };
}

/** One person's award record. `null` when they have none, for the same reason. */
export function personAwards(reader: AwardReader, nconst: string, award: string): PersonAwards | null {
  const rows = reader.awardRowsForPerson(award, nconst);
  if (rows.length === 0) return null;
  return {
    award,
    nominations: rows.length,
    wins: rows.filter((r) => r.won).length,
    entries: rows.map((r) => ({
      ceremony: r.ceremony,
      year: r.year,
      category: r.category,
      won: r.won,
      films: r.films.map((title, i) => ({ title, tconst: r.filmIds[i] ?? null })),
      detail: r.detail,
    })),
  };
}
