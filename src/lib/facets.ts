/**
 * The facet vocabulary: the facts core knows a title can have.
 *
 * Core does not know what Rotten Tomatoes is. Core knows that a title HAS ratings,
 * that ratings have a shape, and that something renders them. A plugin knows the rest.
 *
 *   FACET     a fact type core declares       "ratings", "cast", "seasons"
 *   PROVIDER  a plugin that supplies a facet  src/plugins/rotten-tomatoes.ts
 *
 * Two plugins contributing `ratings` must produce merge-able data rather than two
 * shapes, which is the only reason this vocabulary is central at all.
 *
 * NOT to be confused with `Facets` in `./search`, which is the search filter's facet
 * COUNTS (genre/decade/year/kind). Same English word, unrelated concept: that one is
 * "how many hits are in each bucket", this one is "what do we know about a title".
 */

/**
 * What a provider is asked about. Deliberately narrow -- everything here is already
 * in the local index, so building one costs no query.
 */
export interface FacetEntity {
  kind: EntityKind;
  tconst: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  runtime: number | null;
  /** External ids we already hold. A provider may add more via the `externalIds` facet. */
  ids: Record<string, string | number>;
}

/**
 * The kinds a facet can be declared for.
 *
 * IMDb's `titleType` is finer than this (movie, tvSeries, tvMiniSeries, tvMovie, ...);
 * `entityKindFor` collapses it, because no provider cares about the difference between
 * a tvMovie and a movie.
 */
export type EntityKind = "movie" | "series" | "episode";

/** Collapse an IMDb `titleType` to the kind providers are declared against. */
export function entityKindFor(titleType: string): EntityKind {
  return titleType === "tvSeries" || titleType === "tvMiniSeries" ? "series" : "movie";
}

// --- the shapes ------------------------------------------------------------

export interface Synopsis {
  text: string;
  language: string;
  source: string;
}

/**
 * A LIST, not an object, and that single choice is the point of the whole design:
 * RT, IMDb, Metacritic and Trakt can arrive from three different plugins and still
 * render as one row. Every entry names its own `source`, so a missing provider leaves
 * a gap rather than a hole.
 */
export interface Rating {
  source: string;
  kind: "critics" | "audience" | "user";
  value: number;
  outOf: number;
  count?: number;
  url?: string;
}

export interface CastMember {
  name: string;
  character: string | null;
  order: number;
  personId: string | null;
  image: string | null;
}

/**
 * A TMDB person id in `CastMember.personId` / `CrewMember.personId` form.
 *
 * The single writer of that spelling. Two providers now put TMDB person ids in the same
 * field -- `servarr-metadata` for a film and `tmdb` for a series -- and a divergence
 * between them would be silent: every credit still renders, it just stops matching
 * anything that reads the id back. One function, so there is nothing to keep in step.
 */
export function tmdbPersonId(id: number): string {
  return `tmdb:${id}`;
}

export interface CrewMember {
  name: string;
  job: string;
  department: string | null;
  personId: string | null;
  image: string | null;
}

export interface Certification {
  country: string;
  rating: string;
}

export interface Trailer {
  site: string;
  key: string;
  name: string | null;
  kind: string | null;
}

export interface ReleaseDates {
  cinema: string | null;
  physical: string | null;
  digital: string | null;
  byCountry?: Record<string, string>;
}

export interface Season {
  number: number;
  name: string | null;
  episodeCount: number | null;
  premiereDate: string | null;
  endDate: string | null;
  image: string | null;
}

export interface Episode {
  season: number;
  number: number;
  title: string | null;
  airDate: string | null;
  overview: string | null;
  image: string | null;
  runtime: number | null;
}

export interface Collection {
  id: string;
  name: string;
  parts: { tconst: string | null; title: string }[];
}

export interface RelatedTitle {
  /** Our own id, once known. `null` means unresolved, NOT unresolvable -- see `tmdbId`. */
  tconst: string | null;
  title: string;
  reason: string | null;
  /**
   * The id the recommendation actually arrived with.
   *
   * Kept because throwing it away is what made this facet a dead end: the upstream
   * document identifies recommendations by TMDB id and we index by IMDb, so discarding it
   * left a list of bare title strings that nothing could ever link. Holding it means the
   * crosswalk can happen later, cheaply, and ON CLICK -- resolving ten of these at render
   * time would be a ten-fold fan-out onto Servarr's own infrastructure, which is the
   * "one click deep only, never a sweep" rule this repo runs on.
   */
  tmdbId: number | null;
}

export interface Keyword {
  id: string;
  name: string;
}

/**
 * The language a title was made in.
 *
 * A CODE and never a name. "Hindi" is English's word for it, and freezing one reader's
 * language into every cached row is the thing this avoids: the browser already knows how
 * to say `hi` in whatever the reader speaks, so the name is made at render time and the
 * cache stays reader-agnostic. Same reasoning as `Certification.country`, which stores
 * `US` rather than "United States".
 *
 * There is no `spoken` half and no `kind` discriminator. Neither keyless proxy carries the
 * spoken set -- both hand back the ORIGINAL language and nothing else -- so a field to
 * tell the two apart would have one possible value today. A provider that can genuinely
 * distinguish them is the moment to add it.
 */
export interface Language {
  /** Normalised by `languageCode` -- `en`, never `eng`. */
  code: string;
}

export interface WatchProviders {
  country: string;
  flatrate: string[];
  rent: string[];
  buy: string[];
  /**
   * Where a reader in this country can go to act on the row -- and the ONLY address
   * availability data comes with.
   *
   * There is no per-service deeplink to be had. TMDB's `watch/providers` carries exactly
   * one URL per country, its own watch page, which fronts JustWatch's catalogue; JustWatch
   * has a per-offer URL and we are not invited to their API. So a "Netflix" tile cannot
   * link to Netflix, and pretending otherwise would mean guessing a search URL -- which is
   * the dead end the links table refuses everywhere else.
   *
   * This is the one place a URL is STORED rather than derived, and the reason it does not
   * contradict the rule stated on `ExternalLink`: it is keyed on a country rather than on
   * an id we hold, so there is nothing to derive it from.
   */
  link: string | null;
}

/** Whatever a provider can crosswalk to. Open by design -- new id spaces keep appearing. */
export type ExternalIds = Record<string, string | number>;

/**
 * Somewhere else this title lives, that no id space can express.
 *
 * The narrow half of "where else is this?". Anything reachable FROM an id we already hold
 * -- an IMDb page, a TMDB page, a Trakt page -- is built at render time from `externalIds`
 * and never travels as a link, because storing a URL we can compute is storing a second
 * copy of a fact. This facet is for the rest: an official site, a studio's campaign page,
 * a wiki, anything a provider knows the ADDRESS of rather than the id.
 *
 * `kind` says what is at the other end (`homepage`), and doubles as the label when `name`
 * is absent. A provider with a better name for a link sends one -- "Warner Bros." reads
 * better than "Official site" -- and gets it printed verbatim.
 */
export interface ExternalLink {
  kind: string;
  url: string;
  name?: string | null;
}

/**
 * Library state: in the library, has a file, download progress.
 *
 * CORE ONLY -- the library mirror owns it and it is already local, so caching it here
 * would only make it wrong. Declared so the vocabulary is complete and so the registry
 * has something concrete to refuse a plugin against.
 */
export interface Availability {
  inLibrary: boolean;
  hasFile: boolean;
  progress: number | null;
}

/**
 * Facet name -> the shape core merges contributions into.
 *
 * This interface is the source of truth for the facet NAMES; `FACETS` below declares
 * how each behaves and is checked against it, so adding a facet without declaring it
 * (or vice versa) is a compile error rather than a runtime surprise.
 */
export interface FacetShapes {
  synopsis: Synopsis;
  ratings: Rating[];
  cast: CastMember[];
  crew: CrewMember[];
  certification: Certification[];
  trailer: Trailer[];
  releaseDates: ReleaseDates;
  seasons: Season[];
  episodes: Episode[];
  collection: Collection;
  related: RelatedTitle[];
  keywords: Keyword[];
  language: Language[];
  watchProviders: WatchProviders[];
  externalIds: ExternalIds;
  links: ExternalLink[];
  availability: Availability;
}

export type FacetName = keyof FacetShapes;

// --- how each facet behaves ------------------------------------------------

export interface FacetDeclaration<F extends FacetName = FacetName> {
  /** Entity kinds this facet exists for. A provider is never asked about the others. */
  entities: readonly EntityKind[];
  /**
   * How contributions from several plugins become one value.
   *   list   -- concatenated, so every source is present (this is why `ratings` merges)
   *   object -- shallow-merged key by key (this is how two id crosswalks combine)
   *   single -- the first contribution wins, ordered by plugin id so it is deterministic
   */
  merge: "list" | "object" | "single";
  /**
   * Resolved once and never re-fetched, whatever freshness a provider claims. The cast
   * of Inception is not going to change, and the `artwork` table already works this way.
   */
  immutable?: true;
  /** Core owns this fact. A plugin declaring it is refused at load time. */
  coreOnly?: true;
  /**
   * How strong one contribution is. The strongest SUPERSEDES the rest before they merge.
   *
   * The knob for a facet where two providers answer the same question rather than
   * different halves of it. `ratings` wants both sources; `cast` does not -- two providers
   * naming Kit Harington render two Kit Haringtons, because a `list` facet concatenates
   * and nothing downstream can tell one source's entry from another's.
   *
   * **A SCORE, never a list of plugin ids.** Naming the winner in core would weld this file
   * to the plugins that happen to exist today, close the facet to any addon that arrives
   * later, and make the answer depend on who is installed rather than on what they said.
   * Scoring the DATA keeps the rule open: whoever brings the better answer wins, including
   * a plugin nobody has written yet.
   *
   * A provider that is dark contributes nothing and is not scored, so a checkout missing
   * the stronger provider's key gets the weaker answer with no special case anywhere.
   * Contributions that TIE all survive and merge as usual -- precedence separates tiers,
   * it does not pick one winner out of equals.
   */
  precedence?: (data: FacetShapes[F]) => number;
}

/**
 * The declaration table's type, per facet rather than across them.
 *
 * A plain `Record<FacetName, FacetDeclaration>` would type `precedence` against the UNION
 * of every facet shape, so a scorer written for `CastMember[]` could not be declared and
 * `mergeContributions` could not call one. The mapped form ties each entry to its own shape.
 */
export type FacetVocabulary = { [F in FacetName]: FacetDeclaration<F> };

const MOVIE_AND_SERIES = ["movie", "series"] as const;

/**
 * How much of a cast list can actually be linked to a person.
 *
 * The precedence rule for `cast`, and the reason it is a share rather than a count: a
 * provider is competing on whether its answer is USABLE, not on how long it is. A list of
 * 44 names with no id in any space is a wall of plain text -- the name join in
 * `nconstsByNameForTitle` is all that can be done with it -- while a list carrying person
 * ids is one every reader can click through.
 *
 * An empty list scores 0 rather than dividing by zero, which is right on its own terms:
 * "we looked and there was nobody" supersedes nothing.
 */
function linkableShare(cast: CastMember[]): number {
  if (cast.length === 0) return 0;
  return cast.filter((member) => member.personId !== null).length / cast.length;
}

/**
 * The vocabulary. One entry per fact type core is willing to hold.
 *
 * Adding a facet is an edit HERE plus a shape in `FacetShapes` -- no provider, cache or
 * resolver code changes, which is the seam that lets a new fact type arrive without
 * reopening four files.
 */
export const FACETS: FacetVocabulary = {
  synopsis: { entities: ["movie", "series", "episode"], merge: "single" },
  ratings: { entities: MOVIE_AND_SERIES, merge: "list" },
  // The one facet two providers answer the SAME question for: `servarr-metadata` serves it
  // for both kinds, and `tmdb` serves a series again with real person ids. Concatenating
  // would print every id-bearing actor beside an id-less twin, so the better-linked answer
  // supersedes the other rather than joining it -- see `precedence`.
  cast: { entities: MOVIE_AND_SERIES, merge: "list", immutable: true, precedence: linkableShare },
  crew: { entities: MOVIE_AND_SERIES, merge: "list", immutable: true },
  certification: { entities: MOVIE_AND_SERIES, merge: "list" },
  trailer: { entities: MOVIE_AND_SERIES, merge: "list" },
  releaseDates: { entities: ["movie"], merge: "single" },
  seasons: { entities: ["series"], merge: "list" },
  episodes: { entities: ["series"], merge: "list" },
  // NOT immutable, and it was until 2026-08-31. `immutable` describes a fact that CANNOT
  // change, and "which films are in this collection" plainly can: a franchise gains
  // members. A sequel announced after the row was cached would never have appeared,
  // because nothing ever re-asked -- the one cached answer would outlive the film.
  //
  // It rides the ordinary age ladder instead, which is already right for it: the
  // Godfather collection is settled and gets 90 days, a collection hung on this year's
  // release is where the next entry actually lands and gets far less. That is the ladder
  // doing its job rather than a TTL picked for this facet by hand.
  collection: { entities: ["movie"], merge: "single" },
  related: { entities: MOVIE_AND_SERIES, merge: "list" },
  keywords: { entities: MOVIE_AND_SERIES, merge: "list" },
  // NOT `immutable`, though the language a film was shot in plainly cannot change -- the
  // same distinction `collection` draws just above. `immutable` caches the FIRST answer
  // forever, including an EMPTY one, and the titles most likely to have no language
  // upstream are the unreleased ones whose records get filled in later. The film that
  // prompted this facet, `tt12574330`, is a 2026 release; `tt0468569` answers
  // `OriginalLanguage: null` today. The ladder re-asks those on the young rungs and costs
  // nothing when it does -- this is cut from a document thirteen other facets already buy.
  language: { entities: MOVIE_AND_SERIES, merge: "list" },
  watchProviders: { entities: MOVIE_AND_SERIES, merge: "list" },
  externalIds: { entities: ["movie", "series", "episode"], merge: "object", immutable: true },
  // NOT immutable, unlike `externalIds` beside it, and the difference is the point. An id
  // crosswalk is a fact about identity and cannot change; an address can -- studio sites get
  // rebuilt and campaign pages come down. Re-resolving costs nothing anyway: the only
  // provider cuts this out of a document it is already fetching for `ratings`.
  links: { entities: ["movie", "series", "episode"], merge: "list" },
  availability: { entities: MOVIE_AND_SERIES, merge: "single", coreOnly: true },
};

export const FACET_NAMES = Object.keys(FACETS) as FacetName[];

// --- language codes --------------------------------------------------------

/**
 * One normalised language code, or `null` for anything that is not an answer.
 *
 * THE TWO KEYLESS PROXIES DISAGREE ABOUT WHICH ISO THEY SPEAK. `api.radarr.video` sends
 * 639-1 (`hi` for `tt12574330`) and `skyhook.sonarr.tv` sends 639-2 (`eng` for
 * `tt0944947`), so a facet that merges as a list would carry `en` and `eng` as two
 * different languages the moment a third provider contributed to a title either one
 * already answered for. Folding at the PROVIDER boundary is what stops that, which is why
 * this lives in core beside the shape rather than in one plugin.
 *
 * `Intl.getCanonicalLocales` is the fold: it is the platform's own ISO registry, so there
 * is no table here to fall behind the real one. It keeps 3-letter codes that genuinely
 * have no 2-letter form (`cmn`, `yue`) rather than inventing one.
 *
 * Two shapes of non-answer, and both are dropped rather than passed on:
 *
 *   - `und` is ISO's own "undetermined". It survives canonicalisation and `Intl.DisplayNames`
 *     renders it as "Unknown language", which is a sentence about our data wearing the
 *     costume of a fact about the film.
 *   - Anything structurally invalid (`""`, `en_US`, a stray number) throws `RangeError` out
 *     of the canonicaliser. Same non-answer, arriving as an exception.
 *
 * A code that is well-formed but names no language (`xx`, `qqq`) CANNOT be caught here --
 * `getCanonicalLocales` accepts it because it is syntactically fine. The render layer drops
 * it instead, on the only test that exists: whether anything can name it. See
 * `languageName` in `web/src/lib/facet-panes.ts`.
 */
export function languageCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(raw.trim());
    if (!canonical) return null;
    // A region or script subtag is about a DIALECT (`pt-BR`), and the question this facet
    // answers is which language, so the primary subtag is the whole answer.
    const code = canonical.split("-")[0].toLowerCase();
    return code === "und" ? null : code;
  } catch {
    return null;
  }
}

/** The `language` facet for one upstream code -- empty when there is nothing to say. */
export function languageFacet(raw: string | null | undefined): Language[] {
  const code = languageCode(raw);
  return code ? [{ code }] : [];
}

export function isFacetName(name: string): name is FacetName {
  return Object.hasOwn(FACETS, name);
}

/** Facets a provider may be asked for on this kind of entity. */
export function facetsFor(kind: EntityKind): FacetName[] {
  return FACET_NAMES.filter((f) => !FACETS[f].coreOnly && FACETS[f].entities.includes(kind));
}

// --- images ----------------------------------------------------------------

/**
 * Where an image-bearing facet keeps its upstream URLs.
 *
 * THE ONE PLACE that knows a facet has pictures in it. The browser is never handed an
 * upstream URL, so every one of these is rewritten to our own proxy before the facet
 * leaves the server (`src/server/facet-images.ts`) -- and a facet added later with an
 * image field needs an entry HERE and nothing else, rather than a second walk written
 * next to the first one.
 *
 * `satisfies (keyof X)[]` on each entry so renaming a field on `CastMember` or `Season`
 * is a compile error here rather than a walk that silently stops finding anything. Same
 * shape as `SCHEDULE_DATE_FIELDS` below, for the same reason.
 */
const IMAGE_FIELDS: Partial<Record<FacetName, readonly string[]>> = {
  cast: ["image"] satisfies (keyof CastMember)[],
  crew: ["image"] satisfies (keyof CrewMember)[],
  seasons: ["image"] satisfies (keyof Season)[],
  episodes: ["image"] satisfies (keyof Episode)[],
};

/** Facets that carry at least one image field. Exported for tests and for coverage checks. */
export const IMAGE_BEARING_FACETS = Object.keys(IMAGE_FIELDS) as FacetName[];

/**
 * Every image URL in a facet, put through `toLocal`.
 *
 * Returns the value UNCHANGED (same reference) for a facet that carries no images, so a
 * caller can walk all fifteen facets without paying for the eleven that have none. A
 * `null` back from `toLocal` clears the field: an image we will not proxy must read as
 * "there is no image" rather than as an upstream URL the browser would refuse anyway.
 *
 * Copies rather than mutates. The rewrite runs on data freshly parsed out of the facet
 * cache, so mutation would be safe today and wrong the first time anything memoises.
 */
export function mapFacetImages<F extends FacetName>(
  facet: F,
  data: FacetShapes[F],
  toLocal: (url: string) => string | null,
): FacetShapes[F] {
  const fields = IMAGE_FIELDS[facet];
  if (!fields || data === null || typeof data !== "object") return data;

  // The key is only known at runtime, so the walk works through a loose record; the
  // signature is what every CALLER sees, and it preserves the facet's own shape.
  const rewriteEntry = (entry: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...entry };
    for (const field of fields) {
      const value = out[field];
      if (typeof value === "string") out[field] = toLocal(value);
    }
    return out;
  };

  const entries = data as unknown;
  if (Array.isArray(entries)) {
    return entries.map((e) => (e && typeof e === "object" ? rewriteEntry(e) : e)) as FacetShapes[F];
  }
  return rewriteEntry(entries as Record<string, unknown>) as FacetShapes[F];
}

// --- freshness -------------------------------------------------------------

/**
 * A provider returns a CLASS, never a duration.
 *
 * A plugin cannot pick a good TTL, because the right TTL depends on the subject rather
 * than the source: the same RT lookup should cache for months on a 2010 film and hours
 * on one released last week. The plugin knows what kind of fact it fetched; only core
 * knows how settled this particular title is.
 */
export const FRESHNESS_CLASSES = ["immutable", "settled", "recent", "fresh", "moving", "volatile"] as const;

export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];

export function isFreshnessClass(value: unknown): value is FreshnessClass {
  return typeof value === "string" && (FRESHNESS_CLASSES as readonly string[]).includes(value);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * THE LADDER: the only place a cache duration is written down.
 *
 * `null` never expires. The rest are deliberately far apart rather than evenly spaced --
 * a fact worth re-asking twice a day and one worth re-asking four times a year are not
 * two settings of the same dial, and a middle rung nobody can justify is how a ladder
 * becomes a global constant again.
 */
export const FRESHNESS_TTL_MS: Record<FreshnessClass, number | null> = {
  immutable: null,
  settled: 90 * DAY_MS,
  recent: 14 * DAY_MS,
  fresh: 3 * DAY_MS,
  moving: 12 * HOUR_MS,
  // Churns for reasons that have nothing to do with the title's age -- a 1994 film leaves
  // a streaming service on the same notice as a 2026 one -- so it never rides the ladder.
  volatile: 7 * DAY_MS,
};

/**
 * Classes that describe the FACT rather than the SUBJECT.
 *
 * Everything else (`settled`/`recent`/`fresh`/`moving`) is one band: a provider naming any
 * of them is saying "this fact settles as the title settles", and core picks which rung
 * from the title's age. That is why the same RT lookup caches for months on a 2010 film
 * and hours on one released this year, without either plugin knowing which is which.
 */
const SUBJECT_INDEPENDENT: ReadonlySet<FreshnessClass> = new Set<FreshnessClass>(["immutable", "volatile"]);

/** How far past its newest episode a series still counts as on the air. */
const STILL_RUNNING_GRACE_MS = 35 * DAY_MS;

/** What the ladder needs to know about the title a contribution is about. */
export interface FreshnessSubject {
  /** Release year, from the local index. `null` when the index has none. */
  year: number | null;
  /**
   * The newest date this contribution itself knows about, ISO. Only a schedule-carrying
   * facet has one -- see `scheduleHorizonOf`, which is its only producer.
   */
  latestKnownDate?: string | null;
}

/**
 * Where a schedule-carrying facet keeps its dates.
 *
 * `satisfies (keyof X)[]` on each entry so renaming a field on `Episode` or `Season` is a
 * compile error here rather than a lookup that silently stops finding anything.
 */
const SCHEDULE_DATE_FIELDS: Partial<Record<FacetName, readonly string[]>> = {
  episodes: ["airDate"] satisfies (keyof Episode)[],
  seasons: ["endDate", "premiereDate"] satisfies (keyof Season)[],
};

/**
 * The newest date a contribution knows about, or null if it carries no schedule.
 *
 * `episodes` and `seasons` are cut from the same upstream document, so either one alone
 * is enough to tell a show still on the air from one that finished years ago. ISO dates
 * compare correctly as strings, which is why this needs no parsing to find the maximum.
 */
export function scheduleHorizonOf(facet: FacetName, data: unknown): string | null {
  const fields = SCHEDULE_DATE_FIELDS[facet];
  if (!fields || !Array.isArray(data)) return null;

  let latest: string | null = null;
  for (const entry of data as Record<string, unknown>[]) {
    for (const field of fields) {
      const value = entry?.[field];
      if (typeof value === "string" && (latest === null || value > latest)) latest = value;
    }
  }
  return latest;
}

/**
 * A series whose newest known episode is in the future, or aired within the last month,
 * is still running -- so its schedule is the one fact here that genuinely changes weekly
 * and must not inherit its title's age. `tt0944947` premiered in 2011; classifying its
 * `episodes` by release year would cache next week's episode away for three months.
 *
 * DERIVED rather than declared. The upstream document also carries a `status` field, but
 * promoting it would mean widening a shipped provider's output and core's shared shapes
 * for one consumer. If a show on a long hiatus ever reads as ended the cost is a stale
 * pane rather than a broken one, and the fix is one provider change.
 */
function isStillRunning(latestKnownDate: string | null | undefined, now: number): boolean {
  if (!latestKnownDate) return false;
  const aired = Date.parse(latestKnownDate);
  return !Number.isNaN(aired) && aired > now - STILL_RUNNING_GRACE_MS;
}

/**
 * Where a title sits on the age ladder.
 *
 * The index carries a release YEAR and nothing finer, so the month-level bands collapse
 * to whole years: this year is `fresh`, last year is `recent`, older is `settled`, and a
 * year still ahead of us means the facts are only now being written. A title with no year
 * gets `recent` -- 14 days is aannarr's stated floor, so it is the conservative answer
 * rather than the longest cache.
 */
function classForAge(year: number | null, now: number): FreshnessClass {
  if (year === null) return "recent";
  const thisYear = new Date(now).getUTCFullYear();
  if (year > thisYear) return "moving";
  if (year === thisYear) return "fresh";
  if (year === thisYear - 1) return "recent";
  return "settled";
}

/**
 * The class a contribution is actually cached at, which is rarely the one it claimed.
 *
 * A facet declared `immutable` ignores the provider entirely: the fact does not change,
 * so no provider gets to make us re-fetch it.
 */
export function classFor(
  facet: FacetName,
  claimed: FreshnessClass,
  subject: FreshnessSubject,
  now: number,
): FreshnessClass {
  if (FACETS[facet].immutable) return "immutable";
  if (SUBJECT_INDEPENDENT.has(claimed)) return claimed;
  if (isStillRunning(subject.latestKnownDate, now)) return "moving";
  return classForAge(subject.year, now);
}

// --- merging ---------------------------------------------------------------

/** One plugin's answer for one facet of one entity. */
export interface FacetContribution<F extends FacetName = FacetName> {
  data: FacetShapes[F];
  /** Omitted means `settled` -- the safe middle, not the longest cache. */
  freshness?: FreshnessClass;
}

/**
 * Merge namespaced contributions into the declared facet shape.
 *
 * Contributions arrive keyed by plugin id and are combined in plugin-id order, so the
 * merged value never depends on filesystem iteration order. A `list` facet concatenates
 * (RT audience lands beside servarr's IMDb score); a `single` facet takes the first, which
 * is arbitrary but deterministic.
 *
 * A facet that declares `precedence` narrows the field FIRST -- see `supersede`. That runs
 * ahead of every merge mode rather than beside them, so "who answers" and "how the answers
 * combine" stay two separate questions with one rule each.
 */
export function mergeContributions<F extends FacetName>(
  facet: F,
  byPlugin: Map<string, FacetShapes[F]>,
): FacetShapes[F] | null {
  const ordered = [...byPlugin.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  const kept = supersede(facet, ordered);
  if (kept.length === 0) return null;
  switch (FACETS[facet].merge) {
    case "list":
      return (kept as unknown[][]).flat() as FacetShapes[F];
    case "object":
      return Object.assign({}, ...kept) as FacetShapes[F];
    default:
      return kept[0] as FacetShapes[F];
  }
}

/**
 * Only the strongest contributions, for a facet that declares what strength means.
 *
 * Identity for the fourteen facets that declare nothing, and identity again when only one
 * provider answered -- which is what makes a keyless checkout behave exactly as it did
 * before any competing provider existed, with no branch anywhere that says so.
 *
 * Ties are KEPT, all of them. Two providers with equally linkable cast lists is a real
 * situation with no defensible winner, and silently dropping one on plugin-id order would
 * be the arbitrary choice this whole mechanism exists to replace.
 */
function supersede<F extends FacetName>(facet: F, contributions: FacetShapes[F][]): FacetShapes[F][] {
  const precedence = FACETS[facet].precedence;
  if (!precedence || contributions.length < 2) return contributions;

  const scored = contributions.map((data) => ({ data, score: precedence(data) }));
  const best = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === best).map((s) => s.data);
}

/**
 * Reject a contribution that does not fit the facet's declared shape.
 *
 * Not a full schema check -- per-field validation would mean a schema language for
 * fifteen shapes and would still not stop a provider inventing a plausible-looking
 * wrong value. This catches the shapes that would actually break a merge or a renderer:
 * a non-object contribution, a scalar where a list belongs, junk entries inside a list.
 */
export function isValidContribution(facet: FacetName, value: unknown): value is FacetContribution {
  if (!value || typeof value !== "object") return false;
  const c = value as { data?: unknown; freshness?: unknown };
  if (c.freshness !== undefined && !isFreshnessClass(c.freshness)) return false;
  if (c.data === null || c.data === undefined) return false;

  if (FACETS[facet].merge === "list") {
    return Array.isArray(c.data) && c.data.every((e) => !!e && typeof e === "object");
  }
  return typeof c.data === "object" && !Array.isArray(c.data);
}

/** `settled` is the safe middle -- neither the longest cache nor a re-fetch every view. */
export const DEFAULT_FRESHNESS: FreshnessClass = "settled";

/**
 * Why a contribution failed, in words a reader can act on.
 *
 * > [!IMPORTANT] A CODE, never the error message, because this reaches the browser
 * > `getJson` already reports through `safeUrl` because an upstream URL can carry a
 * > credential in its query string, and `FacetResolver` logs `err.message` verbatim. A
 * > closed vocabulary cannot leak one, however a plugin words its exception. **The message
 * > stays in the container log, and the code's job is to send a reader there** -- which is
 * > the whole point: "rotten-tomatoes timed out" tells you which plugin to grep for and
 * > which author to tell, without the page having to quote an exception at a stranger.
 *
 * `timeout` and `error` are the two a plugin author cares about and they want different
 * fixes: the first is their upstream being slow or their own code hanging, the second is a
 * bad response they should be handling. `invalid-shape` is OUR validator rejecting them,
 * which is a contract bug and not an outage. There is deliberately no code for overload --
 * a refused call writes no row at all, because we never asked.
 */
export const FAILURE_REASONS = ["timeout", "error", "invalid-shape"] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

/** One plugin's failure on one facet, in the form the client is given. */
export interface FacetProblem {
  pluginId: string;
  facet: FacetName;
  reason: FailureReason;
}
