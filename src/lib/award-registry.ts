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
 * Adding an award is this file plus nothing: an `AwardDef` with its query, and the routes,
 * the nav, `/lists`, the import job and the timeline all pick it up. That is the whole point
 * of the shape -- the second award is what proved it, and the five festival and guild prizes
 * added on 2026-09-06 cost a paragraph each and no edit anywhere else.
 *
 * > [!IMPORTANT] REGISTRY ORDER IS LOAD-BEARING. Append; do not insert.
 * > A title card draws ONE award chip, and `buildAwardMarks` in `./award-marks` gives it to
 * > the FIRST award in this array that the title won. Oppenheimer took Best Picture, the
 * > BAFTA for Best Film and the Golden Globe for Drama; it draws an Oscar chip because the
 * > Oscars sit first. Inserting an entry above an existing one silently re-labels every card
 * > in that overlap, so a new award goes on the END unless the entry says why it did not.
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
       * A SPARQL SELECT, EYEBALLED against the live endpoint before it was written down.
       *
       * A plain string rather than a QID, because the query direction genuinely differs
       * between awards -- Best Picture answers `wd:Q102427 wdt:P1346 ?film` while every award
       * here answers the reverse -- and because the query text IS the provenance this product
       * prints on the page. An award whose facts sit the other way round writes its own.
       *
       * Seven of them do NOT, and `winnerQuery` below is why: they ask one question of seven
       * award items, and seven copies of one SPARQL text is seven places to fix the day the
       * label service's language list or the `tt` filter needs a word changed. This file used
       * to argue the opposite -- that a generated query is one nobody ever looked at -- and
       * that concern is real but it is answered by MEASURING each award, which every entry's
       * comment records, rather than by retyping the same ten lines.
       *
       * The reverse direction was measured rather than assumed, on 2026-09-06: only the
       * Golden Lion and the Sundance prize carry `P1346` on the award item at all, the Golden
       * Lion's carry no `pq:P585` and so cannot be placed, and unioning Sundance's into its
       * query moves the answer from 44 rows to 44. They are the same facts written the other
       * way round, so one direction is the whole answer.
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
 * every award it sources here: the `pq:P585` point in time is all there is, so the year is
 * both the key and the label and printing `1994th` would be nonsense.
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
 * The one question every Wikidata award here asks: which FILMS won this prize, and when.
 *
 * Three filters, each of which cost a debugging session and each of which generalises. They
 * are the reason this is a function rather than seven strings that drift apart:
 *
 * - `STRSTARTS(?imdb, "tt")` because `P166` is also stated on the PEOPLE who received a
 *   prize, and a person's `P345` is an `nm` id. It is not a corner case -- measured on
 *   2026-09-06 the person rows outnumber the film rows on the BAFTA (36 to 30) and very
 *   nearly match them at Venice (61 to 66), where the Golden Lion for Lifetime Achievement
 *   has gone to a person every year since 1971. Without it a film list opens with directors.
 * - `pq:P585` REQUIRED, never optional. An award row with no edition cannot be placed on a
 *   timeline keyed by edition, and guessing the year from the film's publication date was
 *   tried and rejected: that is a guess written into a table claiming to be sourced.
 * - `excludeShorts` where the award item covers the feature and the short prize both. It is
 *   OFF by default because it is not free -- a `FILTER NOT EXISTS` on every candidate row --
 *   and each caller says whether its award needs it, having checked.
 *
 * `ORDER BY` is for the human reading the query on the provenance line, not for the importer,
 * which files each row under its own year regardless of the order they arrive in.
 */
export function winnerQuery(awardItem: string, opts: { excludeShorts?: boolean } = {}): string {
  const shorts = opts.excludeShorts ? "\n  FILTER NOT EXISTS { ?work wdt:P31 wd:Q24862 }" : "";
  return `SELECT DISTINCT ?year ?imdb ?label WHERE {
  ?work p:P166 ?statement .
  ?statement ps:P166 wd:${awardItem} ;
             pq:P585 ?awarded .
  ?work wdt:P345 ?imdb .
  FILTER(STRSTARTS(?imdb, "tt"))${shorts}
  BIND(YEAR(?awarded) AS ?year)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr,it,de,es,ja" . ?work rdfs:label ?label . }
}
ORDER BY ?year ?label`;
}

/**
 * Every award, in the order `/lists` offers them, and the order a card's chip is chosen in.
 *
 * All but the Oscars are winner-only Wikidata lists, and that is not a shortfall to fix
 * later: Wikidata records who WON and, for these awards, essentially nothing about who was
 * nominated. A list that says "83 winners" is honest; one that implied a nomination set we do
 * not hold would not be.
 *
 * THE SUBTITLE IS A COVERAGE CLAIM AND EVERY ONE OF THEM WAS MEASURED. "every winner we can
 * identify" is only written where the query returns an edition for nearly every year in its
 * span; where it does not, the subtitle says so in the Emmy's words instead, and each entry's
 * comment records the row count, the date it was counted and which years are missing. A thin
 * honest list is fine. A subtitle implying completeness the rows do not have is not.
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
        Q179808 is the Palme d'Or. Measured 2026-09-03: 83 rows, 1951-2026, one per festival
        except the ties (1952, 1961, 1966, 1972, 1979, 1980, 1982, 1993, 1997), and the years
        Cannes did not run.

        `excludeShorts` drops the SHORT FILM Palme d'Or, which Wikidata files under the same
        award item and which would quietly make this two awards in one list. The two rows the
        required `pq:P585` drops -- Neecha Nagar 1946, Scarecrow 1973 -- carry no point in
        time on Wikidata at all; see `winnerQuery` for why that is the right trade.
      */
      query: winnerQuery("Q179808", { excludeShorts: true }),
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
        Q989438 is the Primetime Emmy for Outstanding Drama Series. The same question as the
        Palme d'Or and a much thinner answer: 16 rows, measured 2026-09-03, against roughly
        seventy-seven ceremonies. The subtitle says "the winners Wikidata can date" because
        that is exactly what this is.

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
      query: winnerQuery("Q989438"),
    },
  },
  {
    id: "golden-lion",
    title: "The Golden Lion",
    subtitle: "the Venice winners Wikidata can date, 1949 onward",
    edition: { key: "year", one: "festival", many: "festivals" },
    anchorCategory: null,
    anchorLabel: "Golden Lion",
    singleCategory: "GOLDEN LION",
    source: {
      kind: "wikidata",
      licence: "CC0-1.0",
      attribution: "Wikidata",
      /*
        Q209459 is the Golden Lion. Measured 2026-09-06: 66 rows across 60 festivals,
        1949-2025, with six ties (1959, 1962, 1965, 1980, 1993, 1994).

        Seventeen years in that span carry no winner and ELEVEN OF THEM ARE VENICE'S GAP
        RATHER THAN WIKIDATA'S: from 1969 to 1979 the festival ran non-competitively and
        awarded no prizes at all, and the Golden Lion did not return until 1980. The other six
        are 1953, 1956, 1966, 1992, 2016 and 2019. So the honest reading of 60 editions is
        "nearly all of them", and the subtitle still says "can date" rather than "every
        winner" because those six are real holes a reader would otherwise not expect.

        No short-film filter: Venice's short prize is a separate item, and every one of the 66
        rows is `P31 = film`. The 61 PERSON rows this query drops are mostly the Golden Lion
        for Lifetime Achievement, which has been given to a person since 1971 under this same
        award item -- the single clearest case for `winnerQuery`'s `tt` filter.
      */
      query: winnerQuery("Q209459"),
    },
  },
  {
    id: "golden-bear",
    title: "The Golden Bear",
    subtitle: "every Berlinale winner we can identify, 1951 onward",
    edition: { key: "year", one: "festival", many: "festivals" },
    anchorCategory: null,
    anchorLabel: "Golden Bear",
    singleCategory: "GOLDEN BEAR",
    source: {
      kind: "wikidata",
      licence: "CC0-1.0",
      attribution: "Wikidata",
      /*
        Q154590 is the Golden Bear. Measured 2026-09-06: 82 rows across 71 festivals,
        1951-2025, missing only 1960, 1970, 2017 and 2024 -- the best-covered award in this
        registry after the Oscars, which is why its subtitle makes the stronger claim.

        The ties are real rather than duplicates. 1951 carries FOUR because the first Berlinale
        awarded a Golden Bear per genre, and eight later years share one between two films.

        `excludeShorts` earns its line on exactly one row, and that row is the argument for
        the filter rather than against it: Ascensor (1978, tt0425756) won the Golden Bear for
        Best Short Film and Wikidata files it under the feature award item. One short film in
        a list of features is the kind of wrong nobody notices and nobody can explain later.
      */
      query: winnerQuery("Q154590", { excludeShorts: true }),
    },
  },
  {
    id: "sundance-grand-jury",
    title: "The Sundance Grand Jury Prize, U.S. Dramatic",
    subtitle: "every U.S. Dramatic jury winner we can identify, 1985 onward",
    edition: { key: "year", one: "festival", many: "festivals" },
    anchorCategory: null,
    anchorLabel: "U.S. Dramatic Grand Jury Prize",
    singleCategory: "GRAND JURY PRIZE (U.S. DRAMATIC)",
    source: {
      kind: "wikidata",
      licence: "CC0-1.0",
      attribution: "Wikidata",
      /*
        Q3774974 is the U.S. Dramatic strand SPECIFICALLY, and the title says so on purpose:
        Sundance's documentary and world-cinema juries give their own Grand Jury Prizes under
        their own Wikidata items, so a page headed "The Sundance Grand Jury Prize" would be
        claiming three lists and holding one.

        Measured 2026-09-06: 44 rows across 40 festivals, 1985-2024, with NO missing year
        inside that span and four ties (1987, 1993, 1995, 2000). The only absent edition is
        2025, which Wikidata had not dated when this was counted.

        There is a second, near-empty item for the same prize -- Q15974895, "Grand Jury Prize
        of the Sundance Festival" -- carrying three statements, one of them usable. It is not
        unioned in here: one row is not worth a second QID in the provenance a reader has to
        understand, and the fix belongs on Wikidata rather than in this file.
      */
      query: winnerQuery("Q3774974"),
    },
  },
  {
    id: "bafta-best-film",
    title: "The BAFTA Award for Best Film",
    subtitle: "the Best Film winners Wikidata can date, fewer than half the ceremonies",
    edition: { key: "year", one: "ceremony", many: "ceremonies" },
    anchorCategory: null,
    anchorLabel: "Best Film",
    singleCategory: "BEST FILM",
    source: {
      kind: "wikidata",
      licence: "CC0-1.0",
      attribution: "Wikidata",
      /*
        Q139184 is the BAFTA Award for Best Film, and this is the Emmy's situation rather than
        the Berlinale's: 30 rows across 27 ceremonies, measured 2026-09-06, 1949-2024, against
        76 years of span -- 49 of them empty, scattered rather than clustered. The subtitle
        says "fewer than half the ceremonies" because that is the shape of what is here, and
        a reader who lands on a timeline with 1973 through 1976 missing deserves to have been
        told before they clicked.

        The gap is Wikidata's rather than the query's, and it is a MISSING-QUALIFIER gap, not
        a missing-statement one: of the 70 statements on this award item, 66 carry `pq:P585`
        and 36 of those are on PEOPLE, which leaves 30 films. Every filter here is pulling its
        weight and the answer is still thin.
      */
      query: winnerQuery("Q139184"),
    },
  },
  {
    id: "golden-globe-drama",
    title: "The Golden Globe for Best Motion Picture, Drama",
    subtitle: "the Drama winners Wikidata can date, fewer than half the ceremonies",
    edition: { key: "year", one: "ceremony", many: "ceremonies" },
    anchorCategory: null,
    anchorLabel: "Best Motion Picture, Drama",
    singleCategory: "BEST MOTION PICTURE, DRAMA",
    source: {
      kind: "wikidata",
      licence: "CC0-1.0",
      attribution: "Wikidata",
      /*
        Q1011509 is the Drama category specifically -- Musical or Comedy (Q670282) is a
        separate item and a separate prize, and the undivided Best Motion Picture that ran to
        1951 is a third (Q3110063). This entry holds one of the three and its title says which.

        Measured 2026-09-06: 26 rows, 1954-2025, one per ceremony with no ties at all, against
        46 empty years in the span. It is the thinnest list in this registry after the Emmy,
        and it earns the same subtitle. There is no filter to relax: the award item carries
        only 32 `P166` statements in total, so what is missing was never written down here.
      */
      query: winnerQuery("Q1011509"),
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
