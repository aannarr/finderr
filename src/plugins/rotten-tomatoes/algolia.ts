/**
 * `content_rt` -- Rotten Tomatoes' own search index, hosted on Algolia.
 *
 * RT's website is an Algolia client, and the credentials below are the ones it ships in
 * its own page for anybody's browser to use: a public application id and a search-only
 * key. Nothing here is a stolen private key and nothing here is authenticated as anyone.
 *
 * It is still UNOFFICIAL AND UNCONTRACTED. RT can change the index, the key or the shape
 * tomorrow with no warning and owes us nothing, so every failure mode in this plugin ends
 * with "no RT entries" rather than with an error on a page.
 *
 * This file is NOT a plugin. The loader globs `*.ts` in `src/plugins/` and `Bun.Glob`'s
 * `*` does not cross a `/`, so a module in this subdirectory is never load-attempted.
 */

import type { EntityKind, FacetEntity } from "../../lib/facets";
import type { PluginFetch } from "../../lib/plugin-fetch";

export const RT_ALGOLIA_HOST = "79frdp12pn-dsn.algolia.net";

/** RT's public browser-side client, verbatim. See the note at the top of this file. */
const APPLICATION_ID = "79FRDP12PN";
const SEARCH_ONLY_KEY = "175588f6e5f8319b27702e4cc4013561";
const ALGOLIA_AGENT = "Algolia for JavaScript (4.14.3); Browser (lite)";

/**
 * Algolia wants a stable per-client token for its own rate accounting. One finderr
 * install is one client, and a constant is more honest than a random id that would make
 * every restart look like a new user.
 */
const USER_TOKEN = "finderr";

/** Enough hits for the matcher to have a real choice, few enough to stay a small answer. */
const HITS_PER_PAGE = 20;

/** RT's scores for one title. Every field is optional -- plenty of entries have neither. */
export interface RtScores {
  criticsScore?: number | null;
  audienceScore?: number | null;
  certifiedFresh?: boolean | null;
  scoreSentiment?: string | null;
}

/**
 * One hit, narrowed to what this plugin reads.
 *
 * `emsId` is the index's own primary key and is what identifies a title again on a later
 * refresh; `vanity` is the slug its page lives at. `titles` are the index's display
 * variants (`"Break-Bad"`, `"Last Pict."`) rather than real alternate titles, which is
 * why the matcher discounts them the same way it discounts `aka`.
 */
export interface RtHit {
  emsId: string;
  vanity: string;
  type: string;
  title: string;
  titles?: string[] | null;
  aka?: string[] | null;
  releaseYear?: number | null;
  rottenTomatoes?: RtScores | null;
}

/**
 * The fields we ask Algolia for, which are exactly the fields `RtHit` declares.
 *
 * `satisfies` binds the two: dropping a field from `RtHit` without dropping it here (or
 * misspelling one) is a compile error rather than a field that silently arrives empty.
 * Asking for nine fields instead of the whole document turns a 30 KB answer into a 2 KB
 * one -- courtesy to a third party we are an uninvited guest on.
 */
const HIT_ATTRIBUTES = [
  "emsId",
  "vanity",
  "type",
  "title",
  "titles",
  "aka",
  "releaseYear",
  "rottenTomatoes",
] as const satisfies readonly (keyof RtHit)[];

interface AlgoliaResponse {
  results: { hits: RtHit[] }[];
}

/**
 * Search RT for one title.
 *
 * An empty array means RT has nothing for it, which is a real answer and caches as an
 * empty facet. A transport failure THROWS instead, because the resolver caches a throw
 * for ten minutes and an empty answer for weeks -- the same distinction `servarr/upstream`
 * draws, and for the same reason.
 */
export async function searchTitles(fetch: PluginFetch, entity: FacetEntity): Promise<RtHit[]> {
  const res = await fetch(`https://${RT_ALGOLIA_HOST}/1/indexes/*/queries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-algolia-application-id": APPLICATION_ID,
      "x-algolia-api-key": SEARCH_ONLY_KEY,
      "x-algolia-agent": ALGOLIA_AGENT,
      "x-algolia-usertoken": USER_TOKEN,
    },
    body: JSON.stringify({
      requests: [{ indexName: "content_rt", query: queryFor(entity), params: searchParams(entity.kind) }],
    }),
  });
  // An index that has been taken away has nothing in it. This endpoint is uncontracted,
  // so "RT moved it" must read as an absent chip rather than as a failure retried every
  // ten minutes forever.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`rotten tomatoes search answered ${res.status}`);

  const body = (await res.json()) as AlgoliaResponse;
  return body.results[0]?.hits ?? [];
}

/**
 * What we type into RT's search box.
 *
 * A leading article makes this index rank worse -- Seerr strips one and so do we. The
 * query is otherwise the title as IMDb spells it, accents and all: Algolia does its own
 * folding, and folding it ourselves first would only lose information.
 */
function queryFor(entity: FacetEntity): string {
  return entity.title.replace(/^the\s+/i, "").trim() || entity.title;
}

/**
 * Type the query, so a series can never win a film's search.
 *
 * `isEmsSearchable=1` is the index's own "this entry is a real, listable title" flag; RT's
 * site sends it on every query and without it the results include fragments.
 */
function searchParams(kind: EntityKind): string {
  return new URLSearchParams({
    filters: `isEmsSearchable=1 AND type:"${kind === "series" ? "tv" : "movie"}"`,
    hitsPerPage: String(HITS_PER_PAGE),
    attributesToRetrieve: JSON.stringify(HIT_ATTRIBUTES),
  }).toString();
}
