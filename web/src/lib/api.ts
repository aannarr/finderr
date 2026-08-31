/**
 * API client with an aggressive in-memory cache.
 *
 * The constraint: cache EVERYTHING so the client feels instant. A repeated query,
 * a back navigation, retyping a character you just deleted -- none of these should
 * produce a network request.
 */

// The server declares this shape and `/api/browse` serves it verbatim, so it is
// imported rather than re-typed -- the same deal `./facets` documents at length.
// `import type` is erased under `verbatimModuleSyntax`: no server module reaches the
// bundle and the browser pays nothing for it.
import type { ArrLink } from "../../../src/lib/arr-links";
import type { CollectionSummary } from "../../../src/lib/collections";
import type { EpisodeState } from "../../../src/lib/episodes";
// TYPE-ONLY, like `CollectionSummary` and `HiddenByFloor` above. Erased at build, so no
// server module reaches the bundle -- the `decadeOf` note in `web/src/lib/search-params.ts`
// is about a VALUE import, which is a different and genuinely costly thing.
import type { PaneBlock, RenderedPane } from "../../../src/lib/panes";
import type { HiddenByFloor } from "../../../src/lib/search";
import { isCacheableFacetSet } from "./facet-panes";
import type { FacetName, FacetProblem, ResolvedFacets } from "./facets";

export type { ArrLink, CollectionSummary, EpisodeState, HiddenByFloor, PaneBlock, RenderedPane };

/**
 * What the upcoming mirror knows about a title, present only on the four upcoming shelves.
 *
 * Absent everywhere else, so a card that never asked about dates draws exactly as before.
 */
export interface UpcomingInfo {
  /** Plain `YYYY-MM-DD`. Rendered by `shelfDateLabel`, never parsed in local time. */
  date: string;
  /** `cinemas` | `digital` | `physical` | `airDate` -- WHICH date this is. */
  dateKind: string;
  /** `S2E9`, or null for a film. */
  detail: string | null;
  /** The episode's own name, or null for a film. */
  episodeTitle: string | null;
  /** Do we hold THIS episode? null when the source cannot say (films, TMDB). */
  hasFile: boolean | null;
}

export interface Title {
  tconst: string;
  title: string;
  orig: string | null;
  year: number | null;
  kind: string;
  votes: number;
  rating: number;
  genres: string;
  runtime: number | null;
  score?: number;
  inLibrary: boolean;
  hasFile: boolean;
  progress: number | null;
  requestStatus: string | null;
  /** Set only on the upcoming shelves. See `UpcomingInfo`. */
  upcoming?: UpcomingInfo;
  service: "radarr" | "sonarr";
  /** Path on OUR proxy, or null when the title is known to have no artwork. */
  posterUrl: string | null;
  /** Studio (film) or network (series), as the arrs report it. May be null. */
  studio: string | null;
  /**
   * Ready-to-use path to a bundled logo, or null when we have no mark for this
   * studio. Resolved on the SERVER, so the client never slugifies a name or probes
   * for a file that does not exist.
   */
  studioLogo: string | null;
  /**
   * Where to PLAY this, when Plex holds it -- built on the server, or null.
   *
   * Two addresses because they fail in opposite directions: `web` opens `app.plex.tv` and
   * works anywhere, `app` is a `plex://` handler that opens the real client and silently
   * does nothing when none is installed. Both need the server's `machineIdentifier`, which
   * the server holds and the client is never handed a copy of.
   *
   * NOT implied by `hasFile`: the arr can have imported a file Plex has not scanned yet,
   * and only the Plex mirror knows the difference.
   */
  plex: { web: string; app: string } | null;
}

export interface Facets {
  genre: { value: string; count: number }[];
  decade: { value: number; count: number }[];
  year: { value: number; count: number }[];
  kind: { value: string; count: number }[];
}

export interface SearchResponse {
  hits: Title[];
  facets: Facets;
  tier: string;
  ms: number;
  candidates: number;
  parsed: {
    text: string;
    year?: number;
    decade?: number;
    kind?: string;
    season?: number;
    stripped: string[];
  };
}

export interface MediaRequest {
  id: number;
  tconst: string;
  title: string;
  year: number | null;
  kind: string;
  service: string;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  /** Comma-joined season numbers, or null for "all". Series only. */
  seasons: string | null;
  /**
   * The arr settings an admin chose for this request, ABSENT for everybody else.
   *
   * Optional in the type because the server strips them for a non-admin -- see
   * `visibleRequest` in `src/lib/auth.ts`. A component reading these must therefore treat
   * `undefined` as "not my business to know" rather than as "the default was used".
   */
  quality_profile_id?: number | null;
  root_folder_path?: string | null;
  search_on_add?: number | null;
}

/** One selectable quality profile, as an arr reports it. */
export interface ArrQualityProfile {
  id: number;
  name: string;
}

/** One selectable root folder, as an arr reports it. */
export interface ArrRootFolder {
  path: string;
  freeSpace?: number;
}

/** What one arr offers. `null` for a service that is not configured at all. */
export interface ArrOptions {
  qualityProfiles: ArrQualityProfile[];
  rootFolders: ArrRootFolder[];
}

/**
 * The three arr settings an admin may attach to one request.
 *
 * Every field optional and every field meaning "use the service default" when absent, so
 * an empty object is a valid and common value -- it is what `RequestOptions` starts at.
 */
export interface RequestOverrides {
  qualityProfileId?: number | null;
  rootFolderPath?: string | null;
  searchOnAdd?: boolean | null;
}

export interface Filters {
  genre?: string;
  decade?: number;
  year?: number;
  kind?: string;
}

// ---------------------------------------------------------------------------

/**
 * LRU-ish cache. Entries never expire during a session -- the index only changes
 * once a day, and library state is patched in separately rather than invalidating
 * the whole search cache.
 */
class Cache<T> {
  private map = new Map<string, T>();
  constructor(private max = 500) {}

  get(key: string): T | undefined {
    const v = this.map.get(key);
    // Re-insert so the most recently used entry is last, making eviction correct.
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

const searchCache = new Cache<SearchResponse>(600);
const titleCache = new Cache<Title>(1000);
/** Only ever holds facet sets with nothing still pending -- see `getTitleDetail`. */
const facetsCache = new Cache<ResolvedFacets>(500);
const browseCache = new Cache<BrowseResponse>(200);
/** One value, not a keyed set: `/api/discover` takes no arguments. */
let discoverCache: { shelves: DiscoverShelf[] } | undefined;

/**
 * Requests already in flight, so two identical keystrokes share one fetch.
 *
 * NOT a cache, and the distinction is the whole reason `browse()` and `getDiscover()`
 * used to refetch on every Back: the entry is dropped in `.finally()`, so it collapses
 * CONCURRENT callers and nothing else. Two sequential calls paid twice. Anything that
 * should survive a route unmount needs a real cache beside this.
 */
const inFlight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function filterKey(q: string, f: Filters): string {
  return `${q}|${f.genre ?? ""}|${f.decade ?? ""}|${f.year ?? ""}|${f.kind ?? ""}`;
}

export function cachedSearch(q: string, f: Filters): SearchResponse | undefined {
  return searchCache.get(filterKey(q, f));
}

export async function search(q: string, f: Filters = {}, signal?: AbortSignal): Promise<SearchResponse> {
  const key = filterKey(q, f);
  const hit = searchCache.get(key);
  if (hit) return hit;

  return dedupe(`search:${key}`, async () => {
    const u = new URLSearchParams({ q });
    if (f.genre) u.set("genre", f.genre);
    if (f.decade !== undefined) u.set("decade", String(f.decade));
    if (f.year !== undefined) u.set("year", String(f.year));
    if (f.kind) u.set("kind", f.kind);

    const res = await fetch(`/api/search?${u}`, { signal });
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    const data = (await res.json()) as SearchResponse;
    searchCache.set(key, data);
    for (const h of data.hits) titleCache.set(h.tconst, h);
    return data;
  });
}

/** The local row, plus whatever facets the server already had cached for it. */
/**
 * Is anyone still working on this title, and what has already gone wrong.
 *
 * **`working` is what the page polls on**, and it is a separate number rather than
 * something derived from the facet statuses because those cannot answer the question: a
 * facet is `pending` whenever a provider owes it an answer, so a facet whose provider was
 * REFUSED by the server's outbound gate is `pending` with nobody working on it. Inferring
 * from statuses alone holds a skeleton up for work that is not happening.
 */
export interface FacetWork {
  /** Providers still owed an answer for this title. Zero means the server is finished. */
  working: number;
  /** The facets those providers belong to -- what may still legitimately show a skeleton. */
  facets: FacetName[];
  /** Which plugin failed, on what, and why. A CODE; the message is in the server's log. */
  problems: FacetProblem[];
}

/**
 * What `work` is for a title served entirely from the client cache.
 *
 * Frozen and shared: it is the same answer every time, and a fresh object per call would
 * change identity on every render for no reason.
 */
export const SETTLED_WORK: FacetWork = Object.freeze({ working: 0, facets: [], problems: [] });

export interface TitleDetail extends Title {
  facets: ResolvedFacets;
  work: FacetWork;
  /**
   * Our own person ids for the names credited on this title, keyed by folded name.
   *
   * Separate from `facets` on purpose: the cast facet is a provider's payload and
   * identifies people by TMDB id, while this is our index answering a different question.
   * Empty on an index built before the cast tables existed, in which case names render as
   * plain text rather than as links to nowhere.
   */
  people?: Record<string, string>;
  /**
   * The other films in this title's collection, as OUR rows, in release order.
   *
   * Decorated server-side like any search hit, because a card needs a poster, library
   * state and a request button and none of those come from a provider. Members we do not
   * hold are already dropped, so this is exactly what is renderable.
   */
  collectionTitles?: Title[];
  /** "More like this", as our rows. Already filtered to what we hold and can link. */
  relatedTitles?: Title[];
  /**
   * Panes a plugin drew, already rendered to blocks by the server.
   *
   * DATA, never code. A plugin's `render` runs server-side over the facets it had already
   * resolved, so the browser receives the same shape it receives for everything else and no
   * addon is welded to our React version. Absent or empty is the ordinary case.
   */
  panes?: RenderedPane[];
  /**
   * Where an ADMIN manages this title in Radarr or Sonarr. Null for everybody else.
   *
   * The null is the SERVER'S answer, not a rendering choice -- an arr's address describes
   * the private network finderr fronts, so a non-admin is never sent the string at all.
   * The component still checks `isAdmin` as well, the way `RequestOptions` does: two cheap
   * guards, one of which is the actual rule.
   */
  arrLink?: ArrLink | null;
  /**
   * Our own Sonarr's per-episode state, one entry per episode it lists for this series.
   *
   * Absent for a film and EMPTY for a series Sonarr does not hold, which mean the same
   * thing here -- there is nothing to say about any episode, so nothing is drawn.
   */
  episodeState?: EpisodeState[];
}

export interface Person {
  nconst: string;
  name: string;
  birthYear: number | null;
  deathYear: number | null;
}

/**
 * One TITLE in a filmography, and every way the person is credited on it.
 *
 * `categories` is a list because a person is often several things on one film. It was a
 * single value, and that rendered "Titans" twice and "Dark Web: Cicada 3301" three times
 * on a real page -- a filmography is a grid of titles, not of credit rows.
 */
export interface Credit extends Title {
  categories: string[];
  characters: string | null;
  ordering: number;
}

export interface PersonPage {
  person: Person;
  credits: Credit[];
  total: number;
  /** Counts over ALL their credits, not this page -- so the number does not shrink. */
  categories: { category: string; count: number }[];
}

export interface PersonQuery {
  /**
   * Credit categories to filter on, COMMA-SEPARATED, e.g. `"actor,actress"`.
   *
   * A list rather than one value because IMDb's vocabulary is not the reader's: "Acting"
   * is both `actor` and `actress`, and sending one of them would drop half a filmography
   * while the page still filled with plausible rows.
   */
  category?: string;
  limit?: number;
  offset?: number;
}

const personCache = new Cache<PersonPage>(200);

function personKey(nconst: string, opts: PersonQuery): string {
  return `${nconst}|${opts.category ?? ""}|${opts.limit ?? 60}|${opts.offset ?? 0}`;
}

/** A person page we already hold. Synchronous, for the same reason `cachedDiscover` is. */
export function cachedPerson(nconst: string, opts: PersonQuery = {}): PersonPage | undefined {
  return personCache.get(personKey(nconst, opts));
}

export async function getPerson(nconst: string, opts: PersonQuery = {}): Promise<PersonPage> {
  const key = personKey(nconst, opts);
  const hit = personCache.get(key);
  if (hit) return hit;

  return dedupe(`person:${key}`, async () => {
    const u = new URLSearchParams();
    if (opts.category) u.set("category", opts.category);
    if (opts.limit !== undefined) u.set("limit", String(opts.limit));
    if (opts.offset) u.set("offset", String(opts.offset));
    const qs = u.toString();

    const res = await fetch(`/api/person/${nconst}${qs ? `?${qs}` : ""}`);
    if (!res.ok) throw new Error(res.status === 404 ? "unknown person" : `person failed: ${res.status}`);
    const data = (await res.json()) as PersonPage;
    personCache.set(key, data);
    // Same as search and browse: holding the rows means opening one from a filmography
    // paints its local half with no request.
    for (const c of data.credits) titleCache.set(c.tconst, c);
    return data;
  });
}

/**
 * One collection and the members we hold.
 *
 * `titles` is already decorated and already filtered to what is renderable, exactly like
 * `TitleDetail.collectionTitles` -- `missing` is what the server could not draw, so the
 * page can say "3 of 4" instead of leaving an unexplained gap.
 */
export interface CollectionPage {
  collection: CollectionSummary;
  titles: Title[];
  missing: number;
}

const collectionCache = new Cache<CollectionPage>(100);

/** A collection page we already hold. Synchronous, for the same reason `cachedPerson` is. */
export function cachedCollection(id: string): CollectionPage | undefined {
  return collectionCache.get(id);
}

/**
 * Fetch a collection page, ALWAYS -- the cache is for painting, not for answering.
 *
 * `cachedCollection` is what makes the page appear at once; this is what keeps it true. A
 * collection's membership widens as its films are viewed, so a cached entry returned
 * unconditionally would pin a "3 of 4" for the whole session even after the fourth arrived.
 * `dedupe` still collapses concurrent callers, and the server's own `max-age=60` bounds
 * how often this actually reaches it.
 */
export async function getCollection(id: string): Promise<CollectionPage> {
  return dedupe(`collection:${id}`, async () => {
    // Encoded because the id carries its namespace (`tmdb:2344`) -- the colon is what
    // keeps the route open to a second provider's id space.
    const res = await fetch(`/api/collection/${encodeURIComponent(id)}`);
    if (!res.ok)
      throw new Error(res.status === 404 ? "unknown collection" : `collection failed: ${res.status}`);
    const data = (await res.json()) as CollectionPage;
    collectionCache.set(id, data);
    // Same as search and browse: holding the rows means opening one from the collection
    // paints its local half with no request.
    for (const t of data.titles) titleCache.set(t.tconst, t);
    return data;
  });
}

/**
 * Collections whose name matches what somebody typed.
 *
 * Not cached: this is the one-shot behind a `collection:` token, and the answer widens as
 * more films are viewed -- a cached miss would outlive the reason for it.
 */
export async function findCollections(name: string): Promise<CollectionSummary[]> {
  const res = await fetch(`/api/collections?q=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`collections failed: ${res.status}`);
  return ((await res.json()) as { matches: CollectionSummary[] }).matches;
}

/**
 * The row we already hold for a title, if any.
 *
 * Arriving from search or a shelf means the row is already here, so the detail page can
 * paint its whole local half before a single byte moves. Synchronous on purpose -- an
 * `await` for data we are holding is a frame the user did not need to wait for.
 */
export function cachedTitle(tconst: string): Title | undefined {
  return titleCache.get(tconst);
}

/**
 * A title's local row and its facets.
 *
 * Always goes to the network unless we hold a FULLY RESOLVED facet set: this request is
 * also what kicks the server's resolver, and a cached `pending` would freeze a skeleton
 * for the life of the session while the answer sat in the server's cache unread.
 */
export async function getTitleDetail(tconst: string): Promise<TitleDetail> {
  const row = titleCache.get(tconst);
  const facets = facetsCache.get(tconst);
  // A cache hit only happens for a FULLY RESOLVED set, so by construction nobody is still
  // working on it and there is nothing to poll for. Synthesised rather than cached: `work`
  // describes a moment on the server, and a stored copy would be a claim about right now
  // built from whenever the row was written.
  if (row && facets) return { ...row, facets, work: SETTLED_WORK };

  return dedupe(`title:${tconst}`, async () => {
    const res = await fetch(`/api/title/${tconst}`);
    if (!res.ok) throw new Error(`title failed: ${res.status}`);
    const data = (await res.json()) as TitleDetail;
    const { facets: resolved, ...title } = data;
    // Row and facets are cached apart, because the row is patched in place when a
    // request goes out and a second copy of it would go stale the moment that happened.
    titleCache.set(tconst, title);
    // Every facet FINAL, not merely "nothing pending" -- a `failed` facet is retried by
    // the server after a short TTL, so caching it here would freeze a transient error
    // for the session and hide every pane behind it.
    if (isCacheableFacetSet(resolved)) facetsCache.set(tconst, resolved);
    return data;
  });
}

/**
 * Warm a title ahead of a click, and do nothing at all if there is no point.
 *
 * Two jobs at once: the click paints from cache with no request, and the SERVER's facet
 * resolver is kicked, so a provider that would have started answering on arrival has
 * already had a head start. That second half is why this is worth doing on hover rather
 * than only on click.
 *
 * **Deliberately fire-and-forget and deliberately silent.** A prefetch that surfaces an
 * error would turn moving the mouse across a grid into a source of error toasts, and a
 * prefetch nobody asked for must never be the reason something looks broken.
 *
 * Skips when the facets are already fully resolved, because `getTitleDetail` would go to
 * the network anyway to re-kick the resolver -- correct on a real navigation, pure waste
 * on a hover.
 */
export function prefetchTitle(tconst: string): void {
  if (titleCache.get(tconst) && facetsCache.get(tconst)) return;
  if (inFlight.has(`title:${tconst}`)) return;
  void getTitleDetail(tconst).catch(() => {});
}

export interface DiscoverShelf {
  id: string;
  title: string;
  subtitle?: string;
  /** Search params for the "browse all" link, when the shelf has a full view. */
  browse?: Record<string, string>;
  titles: Title[];
}

/**
 * Shelves arrive as an ORDERED array, not named keys, so the server decides both
 * which shelves exist and what order they appear in. Adding one needs no client change.
 */
/**
 * The shelves, if we have already fetched them this session.
 *
 * Synchronous, because `SearchRoute` unmounts every time you open a title and its
 * `shelves` state resets to `null` on the way back. Without a synchronous read the route
 * paints an empty page and then repaints when the refetch lands -- which is exactly what
 * "clicking Back reloads the page" felt like.
 */
export function cachedDiscover(): { shelves: DiscoverShelf[] } | undefined {
  return discoverCache;
}

export async function getDiscover(): Promise<{ shelves: DiscoverShelf[] }> {
  if (discoverCache) return discoverCache;
  return dedupe("discover", async () => {
    const res = await fetch("/api/discover");
    if (!res.ok) throw new Error(`discover failed: ${res.status}`);
    const data = (await res.json()) as { shelves: DiscoverShelf[] };
    // Only a SUCCESSFUL response is cached: caching the throw would make one flaky
    // request poison the front page for the life of the session.
    discoverCache = data;
    for (const shelf of data.shelves) {
      for (const t of shelf.titles) titleCache.set(t.tconst, t);
    }
    return data;
  });
}

export interface BrowseResponse {
  rows: Title[];
  /** Total matching the filter, not the page -- drives "showing N of M". */
  total: number;
  /** Set only when the vote floor is why `rows` is empty -- see `HiddenByFloor`. */
  hiddenByFloor?: HiddenByFloor;
}

/**
 * Paginated browse over the local index.
 *
 * Deduped and cached by the exact filter+offset, so paging back and forth costs
 * nothing and returning to a browse view is instant.
 */
export type BrowseSort = "votes" | "rank";

export type BrowseOpts = { limit?: number; offset?: number; minVotes?: number; sort?: BrowseSort };

/**
 * The canonical query string for a browse, and therefore its cache key.
 *
 * SORTED, so the key is the request rather than the order somebody happened to build the
 * filter object in. The routes assemble filters from URL params and property order is not
 * something a caller should have to think about; unsorted, `{genre,decade}` and
 * `{decade,genre}` were two entries for one page.
 */
function browseQuery(filters: Filters, opts: BrowseOpts): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  // A request option, never a URL param: the floor is a ranking knob, and putting it in
  // the address bar would make it shareable state we then have to keep meaningful. It IS
  // part of the cache key though -- the "show all" escape hatch re-runs the same filter
  // with the floor lifted, and must not be handed back the floored rows.
  if (opts.minVotes !== undefined) params.set("minVotes", String(opts.minVotes));
  // Unlike `minVotes`, the sort IS in the address bar -- `?sort=rank` is which LIST you are
  // looking at rather than a threshold somebody has to keep meaningful, and a list is a
  // destination worth sending to someone. It rides here too because it changes the rows.
  if (opts.sort !== undefined) params.set("sort", opts.sort);
  params.sort();
  return params.toString();
}

/** A browse page we already hold. Synchronous, for the same reason `cachedDiscover` is. */
export function cachedBrowse(filters: Filters, opts: BrowseOpts = {}): BrowseResponse | undefined {
  return browseCache.get(browseQuery(filters, opts));
}

/**
 * Every consecutive page we hold for a filter, concatenated -- the state a paged grid
 * was in when the user left it.
 *
 * Seeding only page 0 would be worse than not seeding at all: somebody who had paged to
 * 240 rows and clicked into a title would come Back to 60 rows, and `scrollRestoration`
 * would then restore a scroll offset that no longer exists in the document. Walking
 * while each page is a hit rebuilds exactly what they were looking at.
 *
 * Stops at the first miss rather than skipping it -- a gap in the middle would render
 * rows in the wrong order under a "load more" button that fetches the wrong offset.
 */
export function cachedBrowseRun(
  filters: Filters,
  opts: Omit<BrowseOpts, "offset"> & { limit: number },
): { rows: Title[]; total: number; hiddenByFloor?: HiddenByFloor } | undefined {
  const first = cachedBrowse(filters, { ...opts, offset: 0 });
  if (!first) return undefined;

  const rows = [...first.rows];
  for (let offset = opts.limit; ; offset += opts.limit) {
    const page = cachedBrowse(filters, { ...opts, offset });
    if (!page) break;
    rows.push(...page.rows);
  }
  return { rows, total: first.total, hiddenByFloor: first.hiddenByFloor };
}

export async function browse(filters: Filters, opts: BrowseOpts = {}): Promise<BrowseResponse> {
  const qs = browseQuery(filters, opts);
  const hit = browseCache.get(qs);
  if (hit) return hit;

  return dedupe(`browse:${qs}`, async () => {
    const res = await fetch(`/api/browse?${qs}`);
    if (!res.ok) throw new Error(`browse failed: ${res.status}`);
    const data = (await res.json()) as BrowseResponse;
    browseCache.set(qs, data);
    // Same deal as `search()`: the rows are titles, and holding them means opening one
    // from the grid paints its local half with no request.
    for (const t of data.rows) titleCache.set(t.tconst, t);
    return data;
  });
}

export async function getRequests(): Promise<{
  requests: MediaRequest[];
  queue: { pending: number };
}> {
  const res = await fetch("/api/requests");
  if (!res.ok) throw new Error(`requests failed: ${res.status}`);
  return res.json();
}

/**
 * `seasons` is omitted from the body entirely when absent, never sent as null -- the
 * server reads "the key is not there" as "the reader never chose" and applies Sonarr's
 * own policy, which is what a film and an unopened selector both want.
 *
 * `overrides` follows the same rule and for a stronger reason: the server REFUSES a
 * non-admin who sends any of the three, so a key that is present but null would turn every
 * ordinary user's request into a 403. `requestBody` is what guarantees an untouched control
 * sends nothing at all.
 */
export async function postRequest(
  tconst: string,
  seasons?: readonly number[] | null,
  overrides?: RequestOverrides,
): Promise<{ request: MediaRequest }> {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(tconst, seasons, overrides)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `request failed: ${res.status}`);
  return body as { request: MediaRequest };
}

/**
 * Ask Sonarr for ONE episode of a series it already holds.
 *
 * A separate call from `postRequest` rather than another shape of it, because it is a
 * different operation on a different subject: `postRequest` ADDS a title Sonarr does not
 * have, and refuses one it does (409, "already in your library"). This is the case that
 * begins where that one ends, and it writes no request row -- the server's answer carries
 * no `MediaRequest` because the episode mirror is the record.
 */
export async function postEpisodeRequest(tconst: string, season: number, episode: number): Promise<void> {
  const res = await fetch("/api/requests/episode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tconst, season, episode }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `episode request failed: ${res.status}`);
  }
}

/**
 * The POST body, with every unchosen field ABSENT rather than null.
 *
 * Exported for its tests: the rule it encodes is invisible from the outside and expensive
 * to get wrong, because sending `qualityProfileId: null` reads to the server as "this
 * caller tried to choose" and earns an ordinary user a 403 on a request they made by
 * clicking one button.
 */
export function requestBody(
  tconst: string,
  seasons?: readonly number[] | null,
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const body: Record<string, unknown> = { tconst };
  if (seasons && seasons.length > 0) body.seasons = seasons;
  // `!= null` on purpose -- it is the one place a loose comparison says exactly the right
  // thing, catching both null and undefined while letting `false` and `0` through.
  if (overrides?.qualityProfileId != null) body.qualityProfileId = overrides.qualityProfileId;
  if (overrides?.rootFolderPath != null) body.rootFolderPath = overrides.rootFolderPath;
  if (overrides?.searchOnAdd != null) body.searchOnAdd = overrides.searchOnAdd;
  return body;
}

/**
 * The quality profiles and root folders each arr offers. ADMIN ONLY -- an ordinary user
 * gets 404, which is the same shape `/api/admin/*` uses and is not an error worth showing.
 *
 * One call rather than four: the panel needs every list at once or none of them.
 */
export async function getArrOptions(): Promise<{
  radarr: ArrOptions | null;
  sonarr: ArrOptions | null;
}> {
  const res = await fetch("/api/arr/options");
  if (!res.ok) throw new Error(`arr options failed: ${res.status}`);
  return res.json();
}

export async function retryRequest(tconst: string): Promise<void> {
  const res = await fetch(`/api/requests/${tconst}/retry`, { method: "POST" });
  if (!res.ok) throw new Error(`retry failed: ${res.status}`);
}

/**
 * Patch cached results in place when a title's state changes, instead of throwing
 * the whole search cache away. A request going out should not cost the user their
 * instant back-navigation.
 */
export function patchTitleState(tconst: string, patch: Partial<Title>): void {
  const t = titleCache.get(tconst);
  if (t) titleCache.set(tconst, { ...t, ...patch });
  // Every cached response holds its OWN copies of the rows, so each one has to be
  // walked. Miss one and the badge appears on the grid you requested from and is gone
  // the moment you navigate to a different view of the same title -- which is worse
  // than never showing it, because it reads as the request having been lost.
  for (const rows of cachedRowSets()) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].tconst === tconst) rows[i] = { ...rows[i], ...patch };
    }
  }
  bumpTitleState();
}

// ---------------------------------------------------------------------------
// Title-state subscription
//
// The patch above rewrites rows INSIDE the cached response objects, which React
// cannot see -- the response reference never changes, so nothing re-renders and an
// optimistic "queued" badge would never appear. Views subscribe to this counter
// instead of each keeping their own copy of the row to patch.
// ---------------------------------------------------------------------------

let titleVersion = 0;
const titleListeners = new Set<() => void>();

function bumpTitleState(): void {
  titleVersion++;
  for (const fn of titleListeners) fn();
}

export function subscribeTitleState(fn: () => void): () => void {
  titleListeners.add(fn);
  return () => titleListeners.delete(fn);
}

/** Snapshot for `useSyncExternalStore`. */
export function titleStateVersion(): number {
  return titleVersion;
}

// Small escape hatch so patchTitleState can walk a cache without exposing it.
function entriesOf<T>(cache: Cache<T>): IterableIterator<T> {
  // biome-ignore lint/complexity/useLiteralKeys: reaching into the private field deliberately
  const map = (cache as unknown as { map: Map<string, T> })["map"];
  return map.values();
}

/**
 * Every mutable `Title[]` we are holding, as arrays to be patched in place.
 *
 * One generator rather than three loops in `patchTitleState`, so adding a fourth cache
 * of rows is an entry here instead of a silent gap in the optimistic badge.
 */
function* cachedRowSets(): Generator<Title[]> {
  for (const r of entriesOf(searchCache)) yield r.hits;
  for (const r of entriesOf(browseCache)) yield r.rows;
  for (const r of entriesOf(personCache)) yield r.credits;
  for (const r of entriesOf(collectionCache)) yield r.titles;
  for (const shelf of discoverCache?.shelves ?? []) yield shelf.titles;
}

export function cacheStats(): { searches: number; titles: number } {
  return { searches: searchCache.size, titles: titleCache.size };
}

/**
 * Drop everything. Tests only -- the app has no reason to, since the index changes once
 * a day and library state is patched in rather than invalidated.
 */
export function resetCaches(): void {
  searchCache.clear();
  titleCache.clear();
  facetsCache.clear();
  browseCache.clear();
  personCache.clear();
  collectionCache.clear();
  discoverCache = undefined;
  inFlight.clear();
}

/**
 * Posters always come from OUR proxy. finderr will be internet-facing while
 * Radarr/Sonarr stay on the LAN, so the browser is never handed an upstream URL.
 *
 * `null` means we already looked and there genuinely is no artwork -- render the
 * fallback tile immediately rather than firing a request that will 404.
 */
export function posterUrl(t: Title, size = "w342"): string | null {
  if (t.posterUrl === null) return null;
  return `${t.posterUrl ?? `/img/t/${t.tconst}`}?size=${size}`;
}

// How an IMDb id becomes an IMDb page used to live here as `imdbUrl`. It is one entry in
// `LINK_SITES` (`./facet-panes`) now, beside every other address this product builds --
// and it could not stay: this module value-imports `isCacheableFacetSet` from there, so
// reaching back for `imdbUrl` would have made the two modules mutually recursive.
