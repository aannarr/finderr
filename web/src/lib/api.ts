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
import type { PersonLinks } from "../../../src/lib/people";
import type { RequestStateView } from "../../../src/lib/request-diagnostics";
import type { HiddenByFloor } from "../../../src/lib/search";
import type { CompletionPayload, ListCompletion } from "../../../src/server/lists";
import { Cache } from "./cache";
import {
  CachePersistence,
  indexedDbSnapshotStore,
  type PersistedCacheSpec,
  withDeadline,
} from "./cache-persistence";
import { isCacheableFacetSet } from "./facet-panes";
import type { FacetName, FacetProblem, ResolvedFacets } from "./facets";

export type { ArrLink, CollectionSummary, EpisodeState, HiddenByFloor, PaneBlock, PersonLinks, RenderedPane };

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

/**
 * Why a request is taking as long as it is, as the server sends it.
 *
 * RE-EXPORTED, never re-declared: `requestStateOf` on the server builds exactly this shape
 * and a hand-kept copy here would drift the first time a field was added. The WORDS are not
 * in it -- `requestVerdict` is a code, and `VERDICT_COPY` in the same module is the single
 * owner of what each one says.
 */
export type { RequestStateView as RequestState } from "../../../src/lib/request-diagnostics";

export interface Title extends RequestStateView {
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
  /**
   * The raw request-log status.
   *
   * Kept as the RECORD of what the state machine says; `requestVerdict` is what a reader is
   * shown. Nothing should render this string -- it is an internal enum ("no_release") and
   * putting it in front of a human is the bug `VERDICT_COPY` exists to fix.
   */
  requestStatus: string | null;
  /**
   * Why a failed request failed, already sanitised on the server, or null.
   *
   * Named differently from `MediaRequest.error` because it arrives by a different route --
   * decorated onto a title rather than serialised off the row -- and `RequestVerdictPanel`
   * takes it as a prop for exactly that reason: one panel, two callers, two field names.
   */
  requestError: string | null;
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

export interface MediaRequest extends RequestStateView {
  id: number;
  tconst: string;
  title: string;
  year: number | null;
  kind: string;
  service: string;
  /** The state machine's own word. Render `requestVerdict` instead -- see `Title`. */
  status: string;
  /**
   * A SANITISED reason a request could not be sent, or null.
   *
   * Already passed through `safeArrMessage` on the server, so it is safe to show and is
   * more specific than `VERDICT_COPY.failed.sentence` -- the panel prefers it when present.
   */
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
  /**
   * This arrived and YOU have not been shown it yet.
   *
   * Derived by the server per reader, never the stored `available_seen_at` column: the
   * stamp is a fact about the row, this is a fact about the person holding the session.
   * False on somebody else's request and false on your own once you have opened the list.
   */
  isNew?: boolean;
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

const searchCache = new Cache<SearchResponse>(600);
const titleCache = new Cache<Title>(1000);
/** Only ever holds facet sets with nothing still pending -- see `getTitleDetail`. */
const facetsCache = new Cache<ResolvedFacets>(500);
const browseCache = new Cache<BrowseResponse>(200);
/**
 * One value, not a keyed set: `/api/discover` takes no arguments.
 *
 * Still a `Cache` of capacity one rather than a bare `let`, so it restores from disk
 * through the same path as every other cache -- and the front page is the entry that
 * matters most for that, because it is where a reload lands. A second, hand-written
 * persistence path for one variable is the shape this avoids.
 */
const discoverCache = new Cache<{ shelves: DiscoverShelf[] }>(1);
const DISCOVER_KEY = "discover";

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
  const hit = searchCache.fresh(key);
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

/**
 * Say which result was opened, so the server can find out where it was ranked.
 *
 * A search that returns the right film at rank 4 reports itself as a success, and nothing
 * except this can tell anyone otherwise. It is the half of the search log that makes the
 * other half worth keeping -- see `src/lib/search-log.ts`.
 *
 * `keepalive` is what makes it work at all: this fires on a click that is NAVIGATING away,
 * and a browser cancels ordinary in-flight requests when the page goes. It is also why the
 * body stays tiny -- the keepalive budget is 64 KB across all such requests.
 *
 * Fire-and-forget, and failure is SILENT on purpose. Nothing on screen depends on it, so a
 * 401 mid-session or an offline device must not put an error where somebody is trying to
 * open a film. It carries no identity: the server stores the query, the title, the rank and
 * the tier, and nothing about who.
 */
export function reportSearchClick(query: string, tconst: string, rank: number, tier: string): void {
  void fetch("/api/search/click", {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, tconst, rank, tier }),
  }).catch(() => {});
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
   * Our own person ids for the credits on this title, under both keys a credit can carry.
   *
   * Separate from `facets` on purpose: the cast facet is a provider's payload and
   * identifies people by TMDB id, while this is our index answering a different question.
   * Either half is empty on an index built before the stage that fills it, in which case
   * names render as plain text rather than as links to nowhere.
   *
   * Read it with `nconstForCredit`, never by hand -- it owns the id-first, name-second rule.
   */
  people?: PersonLinks;
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
  /**
   * What the Academy gave this film, from our own imported tables.
   *
   * NOT a facet, and it must not be routed through `paneView`: there is no provider owing
   * it an answer, so it is complete the moment the response arrives and has no `pending`
   * state to reserve space for. `null` for the overwhelming majority of titles, which the
   * pane renders as nothing at all.
   */
  awards?: TitleAwards | null;
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

/**
 * Somebody this person keeps turning up beside, and how often.
 *
 * `shared` counts TITLES, so it matches the cards a reader would find on either
 * filmography rather than the credit rows behind them.
 */
export interface Collaborator {
  nconst: string;
  name: string;
  shared: number;
  /** The categories THEY held on the shared titles -- their job, not this person's. */
  categories: string[];
}

export interface PersonPage {
  person: Person;
  credits: Credit[];
  total: number;
  /** Counts over ALL their credits, not this page -- so the number does not shrink. */
  categories: { category: string; count: number }[];
  /**
   * Who they work with most, over all their credits.
   *
   * Absent from an index built before the cast tables, and empty for anybody with no
   * repeat collaborator -- both of which the pane draws as nothing at all rather than as
   * a heading over an empty row.
   */
  collaborators?: Collaborator[];
  /**
   * Their award record, joined on the nconst. `null` for nearly everybody.
   *
   * Beside the credits rather than inside them: a credit is our index saying they worked
   * on a film, and this is a mirrored dataset saying the Academy nominated them.
   */
  awards?: PersonAwards | null;
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
  /** `"year"` reads the filmography newest-first; anything else is the votes default. */
  sort?: string;
}

const personCache = new Cache<PersonPage>(200);

/**
 * `sort` is PART OF THE KEY, like every other option here.
 *
 * Leaving it out would serve the votes-ordered page under the year-ordered request: the
 * two are the same rows in a different order, so the grid would simply not change and
 * the chip would look broken rather than slow.
 */
function personKey(nconst: string, opts: PersonQuery): string {
  return `${nconst}|${opts.category ?? ""}|${opts.sort ?? ""}|${opts.limit ?? 60}|${opts.offset ?? 0}`;
}

/** A person page we already hold. Synchronous, for the same reason `cachedDiscover` is. */
export function cachedPerson(nconst: string, opts: PersonQuery = {}): PersonPage | undefined {
  return personCache.get(personKey(nconst, opts));
}

export async function getPerson(nconst: string, opts: PersonQuery = {}): Promise<PersonPage> {
  const key = personKey(nconst, opts);
  const hit = personCache.fresh(key);
  if (hit) return hit;

  return dedupe(`person:${key}`, async () => {
    const u = new URLSearchParams();
    if (opts.category) u.set("category", opts.category);
    if (opts.sort) u.set("sort", opts.sort);
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

// --- awards ----------------------------------------------------------------
//
// The whole award surface is served from local SQLite, so none of this polls, none of it
// has a `pending` state and none of it goes through `paneView`. It is either there or the
// server does not hold it -- the same footing `LinksRow` is on.

/** Provenance, so a page can say where its data came from and under what licence. */
export interface AwardSource {
  sha: string | null;
  url: string;
  licence: string;
  attribution: string;
  importedAt: string;
  sourceDate: string | null;
  rows: number;
}

export interface CeremonySummary {
  award: string;
  ceremony: number;
  /** `1927/28` for the first six. Displayed, never parsed -- the ceremony number is the key. */
  year: string;
  nominations: number;
  wins: number;
  categories: number;
  bestPictureTconst: string | null;
  bestPictureTitle: string | null;
  bestPictureAlsoWon: string[];
  bestPictureNominations: number;
  bestPictureWins: number;
  films: number;
  filmsOwned: number;
}

export interface AwardsTimeline {
  award: string;
  source: AwardSource | null;
  totals: { ceremonies: number; nominations: number; wins: number };
  anchor: { category: string; owned: number; total: number };
  ceremonies: CeremonySummary[];
  /**
   * Decorated rows for the anchor films, keyed by tconst.
   *
   * ABSENT is meaningful: a film we do not index has no entry, so the row prints its title
   * as plain text and draws no poster and no request button. That is the dead-end rule as a
   * data shape -- the client never has to decide whether a link would work.
   */
  titles: Record<string, Title>;
}

export interface NominationView {
  seq: number;
  category: string;
  /** The name as it was awarded that year. Shown as a footnote when it differs. */
  rawCategory: string;
  /**
   * The source's coarse grouping -- `Acting`, `Production`, `Directing`, ...
   *
   * Read by `isPersonLed` to decide whether a category's rows lead with the person or the
   * film. One answer per CATEGORY: deriving it from a row's own nominee count is the bug
   * that put `Mark Johnson · The Holdovers` in the middle of a film-first Best Picture.
   */
  className: string;
  won: boolean;
  films: { title: string; tconst: string | null }[];
  nominees: { name: string; nconst: string | null }[];
  detail: string | null;
  note: string | null;
}

export interface CeremonyPage {
  award: string;
  ceremony: number;
  year: string;
  nominations: number;
  wins: number;
  categories: number;
  films: number;
  filmsOwned: number;
  bestPicture: { title: string; tconst: string | null } | null;
  groups: { category: string; nominations: NominationView[] }[];
  titles: Record<string, Title>;
  prev: number | null;
  next: number | null;
}

/** A title's award record, sent on `/api/title/:tconst`. Null for nearly every title. */
export interface TitleAwards {
  award: string;
  nominations: number;
  wins: number;
  entries: {
    ceremony: number;
    year: string;
    category: string;
    won: boolean;
    nominees: { name: string; nconst: string | null }[];
    detail: string | null;
  }[];
}

/** A person's award record, sent on `/api/person/:nconst`. Null for nearly everybody. */
export interface PersonAwards {
  award: string;
  nominations: number;
  wins: number;
  entries: {
    ceremony: number;
    year: string;
    category: string;
    won: boolean;
    films: { title: string; tconst: string | null }[];
    detail: string | null;
  }[];
}

const timelineCache = new Cache<AwardsTimeline>(1);
const ceremonyCache = new Cache<CeremonyPage>(20);

/** The timeline we already hold. Synchronous, for the same reason `cachedDiscover` is. */
export function cachedAwards(): AwardsTimeline | undefined {
  return timelineCache.get("oscars");
}

export async function getAwards(): Promise<AwardsTimeline> {
  const hit = timelineCache.fresh("oscars");
  if (hit) return hit;
  return dedupe("awards", async () => {
    const res = await fetch("/api/awards/oscars");
    if (!res.ok) throw new Error(`awards failed: ${res.status}`);
    const data = (await res.json()) as AwardsTimeline;
    timelineCache.set("oscars", data);
    // Same as search and browse: holding the anchor rows means opening one from the
    // timeline paints its local half with no request.
    for (const t of Object.values(data.titles)) titleCache.set(t.tconst, t);
    return data;
  });
}

export function cachedCeremony(ceremony: number): CeremonyPage | undefined {
  return ceremonyCache.get(String(ceremony));
}

export async function getCeremony(ceremony: number): Promise<CeremonyPage> {
  const key = String(ceremony);
  const hit = ceremonyCache.fresh(key);
  if (hit) return hit;
  return dedupe(`ceremony:${key}`, async () => {
    const res = await fetch(`/api/awards/oscars/${ceremony}`);
    if (!res.ok) throw new Error(res.status === 404 ? "unknown ceremony" : `ceremony failed: ${res.status}`);
    const data = (await res.json()) as CeremonyPage;
    ceremonyCache.set(key, data);
    for (const t of Object.values(data.titles)) titleCache.set(t.tconst, t);
    return data;
  });
}

/**
 * How much of each computed list this library holds, keyed by the catalogue's list id.
 *
 * ONE entry for the whole catalogue, cached under one key, because both surfaces that draw
 * a completion want a different slice of the same answer: `/lists` prints twenty-six of
 * them at once and a ranked `/browse` prints exactly one. Fetching per list would make the
 * index page twenty-six requests, and fetching per page would make the two disagree.
 *
 * A list id ABSENT from `completions` has no count to draw -- an index with no rank column,
 * or a decade the server's clock does not agree exists. Callers render nothing for it.
 */
const listCompletionCache = new Cache<ListCompletions>(1);

export type ListCompletions = Record<string, ListCompletion>;

/** Completions we already hold. Synchronous, for the same reason `cachedAwards` is. */
export function cachedListCompletions(): ListCompletions | undefined {
  return listCompletionCache.get("all");
}

export async function getListCompletions(): Promise<ListCompletions> {
  const hit = listCompletionCache.fresh("all");
  if (hit) return hit;
  return dedupe("list-completions", async () => {
    const res = await fetch("/api/lists/completion");
    if (!res.ok) throw new Error(`list completion failed: ${res.status}`);
    const data = (await res.json()) as CompletionPayload;
    // Keyed on the way IN rather than at every read: both callers look a list up by id, and
    // the server sends an array because that is the shape it builds.
    const byId = Object.fromEntries(data.completions.map((c) => [c.id, c]));
    listCompletionCache.set("all", byId);
    return byId;
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
  // `fresh`, not `get`: a row restored from a previous session paints the header (see
  // `useTitleDetail`, which reads `cachedTitle`) but must never be the reason this request
  // is skipped. Its library state, request status and download progress all moved while
  // the app was closed.
  const row = titleCache.fresh(tconst);
  const facets = facetsCache.fresh(tconst);
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
  if (titleCache.fresh(tconst) && facetsCache.fresh(tconst)) return;
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
 *
 * It is also what makes a RESTORED front page visible: `SearchRoute` reads this in a
 * `useState` initialiser, which runs exactly once, so a snapshot that arrives after the
 * first render is a snapshot nobody ever sees. That is why `main.tsx` waits for hydration
 * before rendering at all.
 */
export function cachedDiscover(): { shelves: DiscoverShelf[] } | undefined {
  return discoverCache.get(DISCOVER_KEY);
}

export async function getDiscover(): Promise<{ shelves: DiscoverShelf[] }> {
  // `fresh`: a restored front page is drawn immediately by `cachedDiscover` and is still
  // refetched here, because a shelf is a claim about what the library holds NOW.
  const hit = discoverCache.fresh(DISCOVER_KEY);
  if (hit) return hit;
  return dedupe("discover", async () => {
    const res = await fetch("/api/discover");
    if (!res.ok) throw new Error(`discover failed: ${res.status}`);
    const data = (await res.json()) as { shelves: DiscoverShelf[] };
    // Only a SUCCESSFUL response is cached: caching the throw would make one flaky
    // request poison the front page for the life of the session.
    discoverCache.set(DISCOVER_KEY, data);
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
  const hit = browseCache.fresh(qs);
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

export interface RequestsResponse {
  requests: MediaRequest[];
  queue: { pending: number };
  /**
   * How many of the CALLER's requests have arrived without them being shown.
   *
   * On this response rather than on one of its own, because `RootLayout` already polls
   * this route every few seconds for the queue badge. One poll, both badges, and no way
   * for the two numbers to describe different moments.
   */
  unseen: number;
}

/**
 * The request log. `mine` narrows it to the caller's own, which is a SERVER-side filter --
 * `requested_by` is stripped from the response for anybody who is not an admin, so there is
 * nothing here to filter on.
 */
export async function getRequests(opts: { mine?: boolean } = {}): Promise<RequestsResponse> {
  const res = await fetch(opts.mine ? "/api/requests?mine=1" : "/api/requests");
  if (!res.ok) throw new Error(`requests failed: ${res.status}`);
  return res.json();
}

/**
 * Clear the caller's unread arrivals, and say how many there were.
 *
 * Called by the requests page on arrival: the reader is looking at the list, so the list
 * has been seen. There is nothing to name -- the server marks everything of theirs that was
 * unread, because a client claiming which rows were on screen is a claim it cannot check.
 */
export async function markRequestsSeen(): Promise<number> {
  const res = await fetch("/api/requests/seen", { method: "POST" });
  if (!res.ok) throw new Error(`marking requests seen failed: ${res.status}`);
  return ((await res.json()) as { seen: number }).seen;
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

/**
 * Every mutable `Title[]` we are holding, as arrays to be patched in place.
 *
 * One generator rather than three loops in `patchTitleState`, so adding a fourth cache
 * of rows is an entry here instead of a silent gap in the optimistic badge.
 *
 * It used to reach into each cache's private `Map` through a cast and a lint suppression.
 * `Cache.values()` is that escape hatch made ordinary -- the same access, named, with the
 * compiler still able to see what it returns.
 */
function* cachedRowSets(): Generator<Title[]> {
  for (const r of searchCache.values()) yield r.hits;
  for (const r of browseCache.values()) yield r.rows;
  for (const r of personCache.values()) yield r.credits;
  for (const r of collectionCache.values()) yield r.titles;
  for (const d of discoverCache.values()) for (const shelf of d.shelves) yield shelf.titles;
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
  discoverCache.clear();
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Persistence
//
// Wired HERE rather than in `./cache-persistence.ts` because this module owns the cache
// instances and that one owns none of them: the dependency points one way, and the storage
// code knows nothing about titles or shelves. See that file's header for the rule that
// makes it safe -- everything restored is for painting, never for answering.
// ---------------------------------------------------------------------------

/**
 * The two caches worth keeping, and what a reload actually needs from each.
 *
 * THE FRONT PAGE, because a reload lands on it and `SearchRoute` reads `cachedDiscover()`
 * in a `useState` initialiser -- one shelf payload, and the page is drawn.
 *
 * TITLE ROWS, because they are what paints a title page's header before its fetch lands,
 * and because every shelf and every search result is one. Two hundred rather than the
 * in-memory thousand: what survives a reload should be the pages the reader was just on,
 * and each extra row is bytes to read back at the one moment this is trying to be fast.
 *
 * NOT the facet cache, and that is worth stating because it looks like the expensive one.
 * Facets only ever short-circuit `getTitleDetail` alongside the ROW, and a restored row
 * never short-circuits anything -- so a persisted facet set would be read from disk on
 * every boot and could not save a single request. Not search or browse either: both are
 * answered from local SQLite in about a millisecond, and neither is where a reload lands.
 */
const PERSISTED_CACHES: PersistedCacheSpec[] = [
  { name: "discover", cache: discoverCache, keep: 1 },
  { name: "titles", cache: titleCache, keep: 200 },
];

const persistence = new CachePersistence(indexedDbSnapshotStore(), PERSISTED_CACHES);

/**
 * How long the first render will wait for the snapshot before going without it.
 *
 * A budget rather than a measurement: two hundred title rows come back as a structured
 * clone with no parsing, which is single-digit milliseconds on the hardware this runs on.
 * The number exists for the pathological case -- another tab mid-upgrade, a device
 * thrashing -- where the right answer is to start the app.
 */
export const HYDRATE_DEADLINE_MS = 250;

/** Fill the caches from the last session. Called once, before the first render. */
export function hydrateCaches(): Promise<void> {
  return withDeadline(persistence.hydrate(), HYDRATE_DEADLINE_MS);
}

/** Write back what changed. Called when the page is going away -- see `main.tsx`. */
export function flushCaches(): Promise<void> {
  return persistence.flush();
}

/**
 * Forget the on-disk copy.
 *
 * Called on sign-out. The in-memory caches die with the page load that follows, but a
 * snapshot outlives it -- and a title row records what the library holds and what this
 * reader asked for, which is not something to leave on a shared iPad for whoever signs in
 * next.
 */
export function clearPersistedCaches(): Promise<void> {
  return persistence.clear();
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
