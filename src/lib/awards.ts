/**
 * Academy Award nominations: the source, the parse, and the shapes the pages read.
 *
 * The whole subsystem exists because one 2.2 MB download joins on ids we already speak.
 * `FilmId` is a `tconst` and lands on the title index; `NomineeIds` is an `nconst` and
 * lands on the person tables the cast build shipped. **There is no title matching
 * anywhere in this file and there must never be one** -- a row whose id we do not hold
 * renders as plain text, never as a guess, which is the same rule `nconstsByNameForTitle`
 * follows when two people share a name on one title.
 *
 * The IMPORT reaches the network. Nothing else here does, and no render path calls it:
 * the pages read rows the job already wrote, like every other mirror in this product.
 *
 * Source: https://github.com/DLu/oscar_data -- BSD-2-Clause, and `AWARD_SOURCE.licence`
 * is what lets a page say so out loud.
 */

/** The only award we hold. A column rather than a table name, so a second one is rows. */
export const OSCARS = "oscars";

export interface AwardSourceMeta {
  /** Repo commit the rows were parsed from, or `null` when the API could not be asked. */
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
}

export const AWARD_SOURCE = {
  repo: "DLu/oscar_data",
  path: "oscars.csv",
  licence: "BSD-2-Clause",
  attribution: "oscar_data by DLu",
} as const;

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
export function parseAwards(text: string, award = OSCARS): Nomination[] {
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

/**
 * Fetch the file, pinned to a commit whenever GitHub will tell us which one.
 *
 * Two calls: ask the commits API which sha last touched `oscars.csv`, then read the file
 * AT that sha. Recording a sha we did not actually read from would be a provenance line
 * that lies, which is worse than none -- so when the API cannot be reached we fall back
 * to `main` and record `sha: null`, and the page says "as of <import date>" instead of
 * naming a commit. `oscar_data` is a living repo; a date alone cannot identify what we read.
 */
export async function fetchAwards(
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; sha: string | null; sourceDate: string | null; url: string }> {
  const { repo, path } = AWARD_SOURCE;
  let sha: string | null = null;
  let sourceDate: string | null = null;

  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT } },
    );
    if (res.ok) {
      const body = (await res.json()) as { sha?: string; commit?: { committer?: { date?: string } } }[];
      sha = body[0]?.sha ?? null;
      sourceDate = body[0]?.commit?.committer?.date ?? null;
    }
  } catch {
    // Unauthenticated and rate-limited to 60/hour, so a refusal here is ordinary rather
    // than exceptional. It costs the sha and nothing else; the import still runs.
  }

  const url = `https://raw.githubusercontent.com/${repo}/${sha ?? "main"}/${path}`;
  const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`oscar_data fetch failed: ${res.status} ${res.statusText}`);
  return { text: await res.text(), sha, sourceDate, url };
}

/**
 * An honest User-Agent, for the same reason the Servarr proxies get one.
 *
 * We are a third party reading somebody else's raw files. Saying who is asking is what
 * makes that polite rather than anonymous traffic.
 */
const USER_AGENT = "finderr/1.0 (+https://github.com/aannarr/finderr)";

// --- the shapes the pages read ---------------------------------------------

/**
 * One ceremony as the timeline draws it.
 *
 * `bestPicture` is a `tconst` and nothing more: the timeline resolves it against the
 * live index itself, because a card needs a poster and library state that this table
 * does not hold and must not copy.
 */
export interface CeremonySummary {
  award: string;
  ceremony: number;
  year: string;
  nominations: number;
  wins: number;
  categories: number;
  /**
   * The Best Picture winner's tconst, or `null`.
   *
   * Null happens for real: the first ceremony awarded `UNIQUE AND ARTISTIC PICTURE`
   * alongside what is now Best Picture, and a nomination without a `FilmId` cannot anchor
   * anything. A row with no anchor draws its year and its counts, which is honest.
   */
  bestPictureTconst: string | null;
  bestPictureTitle: string | null;
  /** Wins in other categories for the same film, for the "also won" line. Canonical names. */
  bestPictureAlsoWon: string[];
  /** Nominations the Best Picture winner took that year, across every category. */
  bestPictureNominations: number;
  bestPictureWins: number;
  /** Distinct films with a tconst in this ceremony, and how many of them we hold. */
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
 * Order the categories of a ceremony the way the ceremony reads.
 *
 * Best Picture first because it is the anchor the timeline already uses, then the source's
 * own `Class` grouping, then the canonical name. Deliberately NOT the source's row order:
 * that is the file's order, which drifts between eras and would reshuffle the page between
 * ceremonies for no reason a reader could see.
 */
const CLASS_ORDER = ["Production", "Directing", "Acting", "Writing", "Music", "Title", "Special", "SciTech"];

export function orderCategories(groups: CategoryGroup[]): CategoryGroup[] {
  const rank = (g: CategoryGroup) => {
    if (g.category === "BEST PICTURE") return -1;
    const cls = g.nominations[0]?.className ?? "";
    const i = CLASS_ORDER.indexOf(cls);
    return i === -1 ? CLASS_ORDER.length : i;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b) || a.category.localeCompare(b.category));
}

/**
 * Group a ceremony's rows by canonical category, winner first inside each.
 *
 * Winner first rather than source order: a category is read to find out who won, and the
 * winner sitting fourth is the answer buried in the middle. Ties keep source order, which
 * is the announcement order and the only meaningful one the file carries.
 */
export function groupByCategory(rows: Nomination[]): CategoryGroup[] {
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
  awardCategoryWinners(award: string, category: string): Nomination[];
  awardRowsForFilmAtCeremony(award: string, ceremony: number, tconst: string): Nomination[];
  awardRowsForTitle(award: string, tconst: string): Nomination[];
  awardRowsForPerson(award: string, nconst: string): Nomination[];
}

/**
 * The category the timeline anchors each ceremony on.
 *
 * A constant rather than an inference, because "the top prize" is not derivable from the
 * table: the first ceremony gave `UNIQUE AND ARTISTIC PICTURE` alongside it, and picking
 * whichever category happens to sort first would make the anchor depend on the file.
 * aannarr's Q2 is open on whether the anchor should be per-category; changing it is this
 * one string, which is the point of naming it.
 */
export const TIMELINE_ANCHOR = "BEST PICTURE";

/**
 * Every ceremony, newest first, each with its anchor film and the counts around it.
 *
 * Costs four queries total regardless of how many ceremonies there are -- the counts, the
 * winners, and one pass for the anchor films' own records. It deliberately does NOT
 * resolve a poster or library state for the anchor: those come from the live index and
 * the decorate path, which is the caller's job and the reason this returns a `tconst`.
 */
export function ceremonyTimeline(reader: AwardReader, award = OSCARS): CeremonySummary[] {
  const winners = new Map<number, Nomination>();
  for (const w of reader.awardCategoryWinners(award, TIMELINE_ANCHOR)) {
    // First writer wins: the query is ordered by seq within a ceremony, and a ceremony
    // with two rows flagged as winning one category is a source oddity we render rather
    // than arbitrate.
    if (!winners.has(w.ceremony)) winners.set(w.ceremony, w);
  }

  return reader.awardCeremonyCounts(award).map((c) => {
    const win = winners.get(c.ceremony);
    const tconst = win?.filmIds.find((id) => id !== null) ?? null;
    // Everything the anchor film itself did that year, which is where "13 nominations,
    // 7 wins" and the "also won" line come from. Only asked when there is an id to ask
    // about -- a winner with no tconst still prints its title and its year.
    const own = tconst ? reader.awardRowsForFilmAtCeremony(award, c.ceremony, tconst) : [];
    return {
      award,
      ceremony: c.ceremony,
      year: c.year,
      nominations: c.nominations,
      wins: c.wins,
      categories: c.categories,
      bestPictureTconst: tconst,
      bestPictureTitle: win?.films[0] ?? null,
      // The anchor category is dropped from its own "also won" line -- it is the headline
      // directly above, and repeating it there is the same fact twice.
      bestPictureAlsoWon: own.filter((n) => n.won && n.category !== TIMELINE_ANCHOR).map((n) => n.category),
      bestPictureNominations: own.length,
      bestPictureWins: own.filter((n) => n.won).length,
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
export function titleAwards(reader: AwardReader, tconst: string, award = OSCARS): TitleAwards | null {
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
export function personAwards(reader: AwardReader, nconst: string, award = OSCARS): PersonAwards | null {
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
