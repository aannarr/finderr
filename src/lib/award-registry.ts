/**
 * Every award finderr holds, and the handful of facts that differ between them.
 *
 * The award TABLES were general from the first commit -- every row carries `award` and every
 * store method takes it. What was not general was everything around them: one module-level
 * `AWARD_SOURCE` naming `DLu/oscar_data`, one `TIMELINE_ANCHOR` reading `"BEST PICTURE"`, and
 * `oscars` spelled literally in two route tables. Each of those was ONE award's answer living
 * where the subsystem's answer belongs. They live here now, once per award.
 *
 * > [!IMPORTANT] This file is imported by the BROWSER as well as the server
 * > `src/lib/lists.ts` derives its curated rows from `AWARDS`, and `web` imports that
 * > catalogue directly. So nothing here may reach the network, open SQLite or import React:
 * > it is data and two lookups, exactly like the list catalogue it feeds.
 *
 * Adding a third award is this file plus nothing: a `AwardDef` with its query, and the routes,
 * the nav, `/lists`, the import job and the timeline all pick it up. That is the whole point
 * of the shape -- the second award is what proved it, and the third should cost a paragraph.
 */

/** Where an award's rows come from, and everything the importer needs to go and get them. */
export type AwardSourceDef =
  | {
      kind: "oscar-data";
      /** `owner/repo` on GitHub. The importer pins the read to the commit that last touched `path`. */
      repo: string;
      path: string;
      licence: string;
      attribution: string;
    }
  | {
      kind: "wikidata";
      /**
       * A hand-written SPARQL SELECT, EYEBALLED once against the live endpoint.
       *
       * Literal per award rather than generated from the award's QID, and that is deliberate:
       * the query direction genuinely differs between awards -- Best Picture answers
       * `wd:Q102427 wdt:P1346 ?film` while both awards here answer the reverse -- and the
       * query text IS the provenance this product prints. A generated query is one nobody
       * ever looked at, on a page claiming to say where its facts came from.
       *
       * The importer reads three columns and no others: `?year`, `?imdb` and `?label`.
       */
      query: string;
      licence: string;
      attribution: string;
    };

/**
 * What one edition of an award is called, and how it is identified.
 *
 * `key: "ordinal"` means the source numbers its editions and the number is the route key --
 * the 96th Academy Awards, whose `year` is the label `1927/28` for the first six and cannot
 * be a key at all. `key: "year"` means the edition IS the year, which is how Wikidata carries
 * both awards here: the `pq:P585` point in time is all there is, so the year is both the key
 * and the label and printing `1994th` would be nonsense.
 */
export interface AwardEdition {
  key: "ordinal" | "year";
  /** "ceremony" / "festival". Singular and plural, because English does not derive one. */
  one: string;
  many: string;
}

export interface AwardDef {
  /** The route segment and the `award` column's value. Kebab-case, stable forever. */
  id: string;
  /** What the page calls itself -- "The Academy Awards". */
  title: string;
  /** The line under it on `/lists`. */
  subtitle: string;
  edition: AwardEdition;
  /**
   * The category the timeline anchors each edition on, or `null` when there is nothing to
   * pick from.
   *
   * A constant rather than an inference, because "the top prize" is not derivable from the
   * table: the first Academy Awards gave `UNIQUE AND ARTISTIC PICTURE` alongside Best
   * Picture, and picking whichever category sorts first would make the anchor depend on the
   * file. **`null` is the interesting case and the reason this is a registry**: the Palme
   * d'Or is one prize per festival, so the edition's winner IS the anchor and filtering by
   * category would be filtering a set of one.
   */
  anchorCategory: string | null;
  /**
   * What the anchor prize is called on screen -- "Best Picture", "Palme d'Or".
   *
   * Separate from `anchorCategory` because a winner-only award has a prize name but no
   * category to filter on, and because the stored category is the source's own shouted key.
   * The completion sentence ("you own 61 of 98 Best Picture winners") is built from this.
   */
  anchorLabel: string;
  /**
   * The category every row of this award is filed under, for the awards that have exactly one.
   *
   * `null` for the Oscars, whose rows carry twenty-eight canonical categories of their own.
   * A single-prize award still has to write SOMETHING into the column the ceremony page
   * groups on, and this is that value -- shouted, like every other stored category, because
   * the grouping key is uppercase and `prettyCategory` is what makes it readable.
   */
  singleCategory: string | null;
  source: AwardSourceDef;
}

/** The Academy Awards. Kept as a named export because a dozen call sites spell it. */
export const OSCARS = "oscars";

/**
 * Every award, in the order `/lists` offers them.
 *
 * Two of the three are winner-only Wikidata lists, and that is not a shortfall to fix later:
 * Wikidata records who WON and, for these awards, essentially nothing about who was
 * nominated. A list that says "83 winners" is honest; one that implied a nomination set we do
 * not hold would not be.
 */
export const AWARDS: AwardDef[] = [
  {
    id: OSCARS,
    title: "The Academy Awards",
    subtitle: "98 ceremonies, every nomination since 1929",
    edition: { key: "ordinal", one: "ceremony", many: "ceremonies" },
    anchorCategory: "BEST PICTURE",
    anchorLabel: "Best Picture",
    singleCategory: null,
    source: {
      kind: "oscar-data",
      repo: "DLu/oscar_data",
      path: "oscars.csv",
      licence: "BSD-2-Clause",
      attribution: "oscar_data by DLu",
    },
  },
  {
    id: "palme-dor",
    title: "The Palme d'Or",
    subtitle: "every Cannes winner we can identify, 1951 onward",
    edition: { key: "year", one: "festival", many: "festivals" },
    anchorCategory: null,
    anchorLabel: "Palme d'Or",
    singleCategory: "PALME D'OR",
    source: {
      kind: "wikidata",
      licence: "CC0-1.0",
      attribution: "Wikidata",
      /*
        Measured 2026-09-03: 83 rows, 1951-2026, one per festival except the ties (1952,
        1961, 1966, 1972, 1979, 1980, 1982, 1993, 1997), and the years Cannes did not run.

        Three filters, each earning its line. `STRSTARTS(?imdb, "tt")` because P166 is also
        stated on the DIRECTORS who received the prize, and a person's P345 is an `nm` id --
        without it the list opens with Fellini and Buñuel. `NOT EXISTS ... wd:Q24862` drops
        the SHORT FILM Palme d'Or, which Wikidata files under the same award item and which
        would quietly make this two awards in one list. `pq:P585` is REQUIRED rather than
        optional: an award row with no edition cannot be placed on a timeline keyed by
        edition, and the two rows it drops (Neecha Nagar 1946, Scarecrow 1973) carry no point
        in time on Wikidata at all. Guessing their year from the film's publication date was
        tried and rejected -- it is a guess written into a table that claims to be sourced.
      */
      query: `SELECT DISTINCT ?year ?imdb ?label WHERE {
  ?work p:P166 ?statement .
  ?statement ps:P166 wd:Q179808 ;
             pq:P585 ?awarded .
  ?work wdt:P345 ?imdb .
  FILTER(STRSTARTS(?imdb, "tt"))
  FILTER NOT EXISTS { ?work wdt:P31 wd:Q24862 }
  BIND(YEAR(?awarded) AS ?year)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr,it,de,es,ja" . ?work rdfs:label ?label . }
}
ORDER BY ?year ?label`,
    },
  },
  {
    id: "emmy-drama-series",
    title: "The Primetime Emmy for Outstanding Drama Series",
    subtitle: "the winners Wikidata can date",
    edition: { key: "year", one: "ceremony", many: "ceremonies" },
    anchorCategory: null,
    anchorLabel: "Outstanding Drama Series",
    singleCategory: "OUTSTANDING DRAMA SERIES",
    source: {
      kind: "wikidata",
      licence: "CC0-1.0",
      attribution: "Wikidata",
      /*
        The same shape as the Palme d'Or query and a much thinner answer: 16 rows, measured
        2026-09-03, against roughly seventy-seven ceremonies. The subtitle says "the winners
        Wikidata can date" because that is exactly what this is.

        The gap is Wikidata's, not the query's, and all three ways round it were tried:
        `wd:Q989438 wdt:P1346 ?work` returns nothing, no ceremony item carries
        `pq:P166 wd:Q989438`, and of the ~90 statements on this award only 55 carry a
        `pq:P585` -- several works (Mad Men, The Handmaid's Tale) carry none, so their wins
        have no edition to sit in. Requiring the qualifier is what keeps every row on the
        timeline honest about which year it belongs to.

        No short-film filter here, because there is no short-form counterpart filed under this
        award item. This award is also why the subsystem is not secretly movie-shaped: every
        row is a SERIES, and `award_film` joins the library mirror on `imdb_id` either way.
      */
      query: `SELECT DISTINCT ?year ?imdb ?label WHERE {
  ?work p:P166 ?statement .
  ?statement ps:P166 wd:Q989438 ;
             pq:P585 ?awarded .
  ?work wdt:P345 ?imdb .
  FILTER(STRSTARTS(?imdb, "tt"))
  BIND(YEAR(?awarded) AS ?year)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr,it,de,es,ja" . ?work rdfs:label ?label . }
}
ORDER BY ?year ?label`,
    },
  },
];

/** The award behind a route segment, or `undefined` for one we do not serve. */
export function awardById(id: string): AwardDef | undefined {
  return AWARDS.find((a) => a.id === id);
}

/**
 * The Academy Awards, resolved rather than re-declared.
 *
 * Several callers want the Oscars specifically -- the title pane and the person page draw
 * one award's record and there is only one award with nominees behind it. Throwing on a
 * missing entry rather than returning `undefined` is right for a lookup into a literal array
 * in the same file: it cannot fail at runtime, and the alternative is a `!` at every call.
 */
export function oscarsDef(): AwardDef {
  const def = awardById(OSCARS);
  if (!def) throw new Error("the oscars award is missing from AWARDS");
  return def;
}

/**
 * What a completion count on an award page is counting -- "Best Picture winners".
 *
 * One owner, because the timeline header prints it and anything reporting on the same number
 * would otherwise phrase it its own way.
 */
export function anchorNoun(def: AwardDef): string {
  return `${def.anchorLabel} winners`;
}
