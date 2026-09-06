/**
 * How an award's rows are FETCHED, one loader per kind of source.
 *
 * The two sources have nothing in common except their output. `oscar_data` is a 2.2 MB
 * tab-separated file in somebody's git repo, pinned to a commit, carrying twelve thousand
 * nominations with people attached. Wikidata is a SPARQL endpoint with no revision to pin,
 * answering in eighty rows of winners and no nominees at all. Fusing them into one "generic
 * importer" would mean a shape that describes neither.
 *
 * So each kind gets a LOADER, and `loadAward` picks one from a table. Adding a third kind is
 * one function and one entry -- nothing already here is reopened, which is the difference
 * between this and the `if (opts.file)` branch it replaced.
 *
 * Both loaders return the same pair: the rows to store, and the provenance to print. Neither
 * writes anything; the job owns the transaction, so a failed fetch leaves the stored rows
 * exactly where they were.
 */

import type { AwardDef, AwardSourceDef } from "./award-registry";
import { type AwardSourceMeta, type Nomination, parseAwards } from "./awards";
import { type SparqlOptions, type SparqlRow, sparqlSelect } from "./wikidata";

/**
 * An honest User-Agent, for the same reason the Servarr proxies get one.
 *
 * We are a third party reading somebody else's raw files. Saying who is asking is what makes
 * that polite rather than anonymous traffic. Wikidata gets its own, declared beside its
 * client, because Wikimedia's policy is stricter than GitHub's courtesy.
 */
const USER_AGENT = "finderr/1.0 (+https://github.com/aannarr/finderr)";

/** What a loader is handed: everything it reaches the outside world with, injected. */
export interface LoadDeps {
  fetchImpl?: typeof fetch;
  /** Reads the source from disk instead of the network. `--file` on the import job. */
  file?: string;
  /** Injected so provenance is testable without freezing the clock globally. */
  now?: () => Date;
}

/** The rows to store and the line the page will print about where they came from. */
export interface LoadedAward {
  rows: Nomination[];
  /** Everything but `rows`, which only the store can count once it has written them. */
  meta: Omit<AwardSourceMeta, "rows">;
}

/**
 * Fetch and parse one award's rows.
 *
 * A `switch` over the source's discriminant rather than a lookup table, because this is the
 * one place the union is narrowed: each loader is then handed a source it does not have to
 * re-check, and a new member of `AwardSourceDef` with no case here fails to typecheck rather
 * than throwing at 09:00 on somebody's NAS.
 */
export async function loadAward(def: AwardDef, deps: LoadDeps = {}): Promise<LoadedAward> {
  const source = def.source;
  switch (source.kind) {
    case "oscar-data":
      return loadOscarData(def, source, deps);
    case "wikidata":
      return loadWikidata(def, source, deps);
  }
}

// --- oscar_data -------------------------------------------------------------

/**
 * The whole nomination history, from a file in a public repo, pinned to a commit.
 *
 * Two calls: ask the commits API which sha last touched the file, then read the file AT that
 * sha. Recording a sha we did not actually read from would be a provenance line that lies,
 * which is worse than none -- so when the API cannot be reached we fall back to `main` and
 * record `sha: null`, and the page says "revision unknown" instead of naming a commit.
 * `oscar_data` is a living repo; a date alone cannot identify what we read.
 */
async function loadOscarData(
  def: AwardDef,
  source: Extract<AwardSourceDef, { kind: "oscar-data" }>,
  deps: LoadDeps,
): Promise<LoadedAward> {
  const { fetchImpl = fetch, now = () => new Date() } = deps;

  let sha: string | null = null;
  let sourceDate: string | null = null;
  let text: string;
  let url: string;

  if (deps.file) {
    // The local path exists so a test, or a machine with no route to GitHub, can still
    // exercise the whole import. It records no sha, because there is nothing to record -- a
    // file on disk cannot say which commit it came from, and inventing one would be the
    // provenance line lying.
    text = await Bun.file(deps.file).text();
    url = `file:${deps.file}`;
  } else {
    const { repo, path } = source;
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

    url = `https://raw.githubusercontent.com/${repo}/${sha ?? "main"}/${path}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`oscar_data fetch failed: ${res.status} ${res.statusText}`);
    text = await res.text();
  }

  // Throws `AwardsSchemaDriftError` on a changed header, BEFORE anything is written.
  return {
    rows: parseAwards(text, def.id),
    meta: {
      sha,
      url,
      licence: source.licence,
      attribution: source.attribution,
      importedAt: now().toISOString(),
      sourceDate,
      query: null,
    },
  };
}

// --- wikidata ---------------------------------------------------------------

/**
 * A winner list, from one hand-written SPARQL query.
 *
 * The provenance carries the QUERY and no sha, because Wikidata has neither a commit nor a
 * version -- it is a database that changed while the query was running. So what is honest to
 * print is the question we asked and the moment we asked it, and `sourceDate` stays null
 * rather than repeating the import date as if it were a property of the source.
 */
async function loadWikidata(
  def: AwardDef,
  source: Extract<AwardSourceDef, { kind: "wikidata" }>,
  deps: LoadDeps,
): Promise<LoadedAward> {
  const { now = () => new Date() } = deps;

  const opts: SparqlOptions = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const bindings = await sparqlSelect(source.query, opts);

  return {
    rows: wikidataNominations(bindings, def),
    meta: {
      sha: null,
      url: WIKIDATA_SOURCE_URL,
      licence: source.licence,
      attribution: source.attribution,
      importedAt: now().toISOString(),
      sourceDate: null,
      query: source.query,
    },
  };
}

/** Where a reader can go and check the claim for themselves. */
const WIKIDATA_SOURCE_URL = "https://query.wikidata.org/";

/**
 * Turn SPARQL rows into nominations, dropping anything that cannot be placed.
 *
 * The three columns are fixed by contract with the queries in `award-registry.ts`: `?year`,
 * `?imdb` and `?label`. A row missing a usable year or a `tt` id is SKIPPED rather than
 * defaulted -- the year is the edition key a timeline is built on, and a row with a bad one
 * would sit under a heading that is simply wrong. The queries already require both, so this
 * is the second line of the same defence rather than an expected path.
 *
 * Every row is a WIN, because `P166` means "award received" and there is no nominee list
 * behind it. `nominees` is therefore empty and stays empty: inventing the director as a
 * nominee would put a Palme d'Or on a person page that Wikidata never said won one.
 */
export function wikidataNominations(rows: SparqlRow[], def: AwardDef): Nomination[] {
  // The stored KEY, never the label -- this is the value the ceremony page groups on and the
  // one a reader's `prettyCategory` turns back into a heading.
  const category = def.singleCategory?.key;
  if (category === undefined) throw new Error(`${def.id} has no singleCategory to file wikidata rows under`);

  // Per edition, so `seq` is the row's position in ITS year rather than in the answer. That
  // keeps the key stable when an earlier year gains a co-winner, and it is what makes a tie
  // -- nine of them at Cannes -- two rows in one edition instead of a collision.
  const seqOf = new Map<number, number>();
  const out: Nomination[] = [];

  for (const row of rows) {
    const year = Number.parseInt(row.year ?? "", 10);
    const tconst = row.imdb ?? "";
    if (!Number.isFinite(year) || !/^tt\d+$/.test(tconst)) continue;

    const seq = seqOf.get(year) ?? 0;
    seqOf.set(year, seq + 1);

    out.push({
      award: def.id,
      // The edition IS the year for these awards -- see `AwardEdition.key`. Wikidata records
      // a point in time and no ordinal, so the year is both the key and the label.
      ceremony: year,
      year: String(year),
      // No `Class` vocabulary outside `oscar_data`, and an empty one reads as film-led, which
      // is what every row of a work-level award is.
      className: "",
      category,
      rawCategory: category,
      films: [row.label ?? tconst],
      filmIds: [tconst],
      nominees: [],
      nconsts: [],
      won: true,
      detail: null,
      note: null,
      seq,
    });
  }

  return out;
}
