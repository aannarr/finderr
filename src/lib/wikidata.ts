/**
 * A SPARQL client for the Wikidata Query Service, and nothing that knows what an award is.
 *
 * > [!CAUTION] NEVER ON A REQUEST PATH. Not once, not behind a cache, not "just for admins".
 * > Measured across eight calls on 2026-09-01: one returned 502, one timed out at 30
 * > seconds, and the successful ones took up to 90. This is a public endpoint with a
 * > published fair-use policy and no availability promise anybody signed. It belongs on the
 * > same footing as the `oscar_data` import -- a job, on a timer, writing rows that every
 * > render path then reads out of local SQLite.
 *
 * The whole module is one request and one unwrap. It takes the query as a string because the
 * queries are hand-written and eyeballed (see `award-registry.ts`), and it hands back plain
 * string columns because SPARQL's JSON envelope is three levels of `{type, value}` wrapping
 * around exactly that.
 */

/** The public endpoint. Injectable at the call site, so a test never reaches the network. */
export const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";

/**
 * An honest User-Agent, for the same reason the Servarr proxies and the GitHub read get one.
 *
 * Wikimedia's user-agent policy asks third parties to identify themselves and will refuse a
 * generic one outright. Saying who is asking is what makes this polite traffic rather than
 * anonymous traffic.
 */
export const WIKIDATA_USER_AGENT = "finderr/1.0 (+https://github.com/aannarr/finderr)";

/**
 * How long one query may take before we give up on it.
 *
 * Two minutes, which is generous by the standards of everything else in this product and
 * mean by the standards of this endpoint: the service's own hard limit is sixty seconds of
 * query time, and the rest is queueing. A job that runs once a day can afford to wait; it
 * cannot afford to hang forever holding an import open.
 */
const TIMEOUT_MS = 120_000;

/** One result row: the SELECT's variable names, with an unbound column simply absent. */
export type SparqlRow = Record<string, string | undefined>;

/** The envelope the service returns. Only the two fields we read are named. */
interface SparqlResponse {
  results?: { bindings?: Record<string, { value?: string }>[] };
}

export interface SparqlOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/**
 * Run a SELECT and hand back its rows.
 *
 * A GET with the query in the URL rather than a POST, because that is what the service's own
 * documentation and every cache in front of it expect. `Accept` is the JSON results format;
 * asking for it explicitly is what stops the endpoint answering with the HTML query editor.
 *
 * Throws on anything that is not a 2xx, including the 502 the service hands out under load.
 * The caller is an import job, and its contract is that a failed fetch leaves the previously
 * stored rows exactly where they were.
 */
export async function sparqlSelect(query: string, opts: SparqlOptions = {}): Promise<SparqlRow[]> {
  const { fetchImpl = fetch, endpoint = WIKIDATA_ENDPOINT } = opts;
  const url = `${endpoint}?query=${encodeURIComponent(query)}`;

  const res = await fetchImpl(url, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": WIKIDATA_USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`wikidata query failed: ${res.status} ${res.statusText}`);

  const body = (await res.json()) as SparqlResponse;
  return (body.results?.bindings ?? []).map(unwrapBinding);
}

/**
 * `{ imdb: { type: "literal", value: "tt1" } }` -> `{ imdb: "tt1" }`.
 *
 * The type and the language tag are dropped on purpose: every column these queries select is
 * a literal or a label, and carrying the envelope further would make every caller unwrap it
 * again. A column with no `value` becomes `undefined` rather than an empty string, so
 * "unbound" and "bound to nothing" stay different facts.
 */
function unwrapBinding(binding: Record<string, { value?: string }>): SparqlRow {
  return Object.fromEntries(Object.entries(binding).map(([column, cell]) => [column, cell.value]));
}
