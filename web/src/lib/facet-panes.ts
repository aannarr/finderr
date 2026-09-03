/**
 * What a pane does with a facet, and the small formatting decisions its content needs.
 *
 * Everything here is PURE and DOM-free: the pane components below `components/` decide
 * what a cast row looks like, this module decides whether there is a cast row at all and
 * what its values read as. That split is what makes the pane rule -- skeleton, content,
 * problem, hidden -- testable in one place instead of re-argued in every component.
 */

import type { PersonLinks } from "../../../src/lib/people";
/*
  WHERE TO WATCH MOVED OUT, and this re-export is what keeps every call site pointing at
  one owner rather than at a copy.

  `watchServices` and its 42-spelling mark table now live in `src/lib/watch-services.ts`,
  because the SERVER has to fold service names the same way to answer "what else is on
  Netflix" -- see that module's header. The module is pure, so importing it as a VALUE
  costs the bundle the table and nothing else. Panes still import these from here, which is
  where a render module expects to find them.
*/
export {
  pickWatchProviders,
  serviceKey,
  STREAMING_MARKS,
  streamingLogo,
  type WatchService,
  watchServices,
} from "../../../src/lib/watch-services";
import type {
  Certification,
  CrewMember,
  EntityKind,
  Episode,
  ExternalIds,
  ExternalLink,
  FacetName,
  FacetProblem,
  FacetShapes,
  FailureReason,
  Language,
  PersonCredit,
  Rating,
  ReleaseDates,
  ResolvedFacets,
  Season,
  Trailer,
  WatchProviders,
} from "./facets";

/**
 * Four states, and the fourth one is the difference between "nothing here" and "broken".
 *
 * `hidden` is everything we are not going to get and have nothing to say about: a facet
 * nobody provides, and a provider that answered with nothing. `problem` is a facet a named
 * addon FAILED on -- which used to go down the `hidden` path too, so a title whose cast
 * provider timed out rendered identically to a title that genuinely has no cast. A reader
 * could not tell those apart, and neither could we.
 *
 * A DISCRIMINATED UNION rather than one struct with two optional fields, because "`data` is
 * present exactly when the state is `content`" is a rule a comment can only assert and the
 * compiler can enforce.
 */
export type PaneView<F extends FacetName> =
  | { state: "skeleton" }
  | { state: "hidden" }
  | { state: "content"; data: FacetShapes[F] }
  | { state: "problem"; problems: readonly FacetProblem[] };

/**
 * Whether a pane draws its content, reserves its space, says a provider broke, or
 * disappears.
 *
 * `working` is the SERVER's answer to "who still owes this title a facet" -- `work.facets`
 * off the response, or `undefined` before the first one lands. A `pending` facet draws a
 * skeleton only while a provider is genuinely still working on it.
 *
 * > [!IMPORTANT] `pending` and "somebody is still trying" are NOT the same thing
 * > This took a page-wide `settled` boolean until 2026-08-31, flipped by a timer in the
 * > browser, and the timer was always going to be wrong in one direction or the other: too
 * > short and a facet that was about to land was hidden, too long and a dead one kept its
 * > skeleton. Neither is guesswork now, because a facet is `pending` whenever a provider
 * > OWES it an answer -- which includes a provider the server's outbound gate REFUSED, who
 * > is not working on it at all. The status alone cannot tell those apart. The provider
 * > count can, and the server already knows it.
 * >
 * > So the client stops when the WORK stops rather than when a clock says so, and every
 * > facet decides for itself instead of the whole page settling at once. A fast synopsis
 * > paints while a slow cast keeps its skeleton.
 *
 * `problems` is `work.problems` off the same response -- who FAILED, by name. It is the
 * whole title's list rather than this facet's, exactly like `working`, so a caller never
 * has to filter before asking. A failure only becomes visible when the facet is `failed`
 * AND somebody in that list owns it: a facet two plugins provide, where one failed and the
 * other answered, is `ready` and says nothing, which is right -- the reader has the cast.
 */
export function paneView<F extends FacetName>(
  facets: ResolvedFacets | undefined,
  facet: F,
  working: readonly FacetName[] | undefined,
  problems?: readonly FacetProblem[],
): PaneView<F> {
  // No response yet, so we do not know whether this facet even exists here. Reserve the
  // space rather than draw a pane that is about to vanish.
  if (!facets) return { state: "skeleton" };

  const resolved = facets[facet];
  // The server did not declare this facet for this entity kind -- `seasons` on a film.
  if (!resolved) return { state: "hidden" };

  switch (resolved.status) {
    case "ready":
      return hasContent(resolved.data) ? { state: "content", data: resolved.data } : { state: "hidden" };
    case "pending":
      // Still owed by somebody -> hold the space. Owed by nobody -> the answer is not
      // coming on this view, so drawing a skeleton would be a lie about work in progress.
      return { state: working?.includes(facet) ? "skeleton" : "hidden" };
    case "failed": {
      // A failure nobody claims stays quiet. `workState` reports problems from CURRENT
      // rows only, so a failure under a superseded plugin config has no owner here and
      // naming an author whose next answer is already in flight would be wrong.
      const owned = (problems ?? []).filter((p) => p.facet === facet);
      return owned.length > 0 ? { state: "problem", problems: owned } : { state: "hidden" };
    }
    default:
      return { state: "hidden" };
  }
}

/**
 * Is there anything to draw? A `ready` facet can still hold an empty list, and an empty
 * list is nothing to show.
 *
 * A type PREDICATE rather than an `isEmpty` boolean, so the one caller that needs the data
 * afterwards gets it non-optional: `ResolvedFacet.data` is declared optional for every
 * status, and this is where a `content` view stops being a maybe.
 */
function hasContent<T>(data: T | null | undefined): data is T {
  return data !== undefined && data !== null && !(Array.isArray(data) && data.length === 0);
}

/**
 * What a failure reason READS as, and the client's copy of the closed vocabulary.
 *
 * The reason arrives as a CODE precisely so it is safe to show a browser -- the message
 * stays in the container log, because an upstream error can quote a URL with a credential
 * in its query string (`src/lib/facets.ts`, `FAILURE_REASONS`). This table is where the
 * code becomes English, and being a table rather than a lookup on the wire value is what
 * makes it a GUARD: a `reason` nobody here recognises can never reach the page verbatim.
 *
 * Mirrored rather than imported for the same reason `STREAMING_MARKS` mirrors
 * `slugifyLogo`: `FAILURE_REASONS` is a VALUE in a server module, and importing it would
 * pull that module into the browser bundle.
 */
const FAILURE_PHRASES: Record<FailureReason, string> = {
  timeout: "timed out",
  error: "failed",
  "invalid-shape": "sent something we could not read",
};

/**
 * `error` is the honest generalisation for a code we do not know -- the same answer the
 * server gives a row written before the column existed. Something went wrong and the log
 * knows what; guessing at a phrase, or printing the raw value, would be worse.
 */
function failurePhrase(reason: FailureReason): string {
  return FAILURE_PHRASES[reason] ?? FAILURE_PHRASES.error;
}

/**
 * What a plugin id has to look like before it is printed at a reader.
 *
 * The SAME shape `src/lib/plugins.ts` enforces on every manifest it loads, mirrored here
 * for the same reason `FAILURE_PHRASES` is -- and it earns its place as a second guard
 * rather than a second copy: this is the only line on the page whose text comes from an
 * addon, so nothing that is not an id gets to be the text.
 */
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The addon by name, or an anonymous mention of it when the id is not one. */
function addonName(pluginId: string): string {
  return PLUGIN_ID.test(pluginId) ? pluginId : "an addon";
}

/**
 * The one muted line a failed pane says, instead of vanishing.
 *
 * It names the ADDON and the REASON and stops there, which is the whole design: it is
 * enough to tell a reader this is broken rather than absent, and enough to send whoever
 * maintains the box to the right plugin's log lines. Two plugins failing one facet is two
 * clauses, deduplicated -- the same failure reported twice is one fact.
 */
export function problemNote(problems: readonly FacetProblem[]): string {
  const clauses = new Set(problems.map((p) => `${addonName(p.pluginId)} ${failurePhrase(p.reason)}`));
  return `Unavailable: ${[...clauses].join(", ")}`;
}

/** Is anything still outstanding? Drives the deferred re-read and the skeletons. */
export function hasPendingFacet(facets: ResolvedFacets): boolean {
  return Object.values(facets).some((f) => f?.status === "pending");
}

/**
 * May the client keep this facet set for the rest of the session?
 *
 * Only when every facet has reached a FINAL answer. `pending` is obviously not final --
 * but neither is `failed`, and conflating the two is a bug this used to have: the client
 * cached on `!hasPendingFacet` alone, so a single transient provider failure was frozen
 * for the session while the server happily retried it after its own short failure TTL.
 * The client out-cached the server, and because `paneView` hid every `failed` facet in
 * silence back then, the symptom was a title page with a header and no panes at all, with
 * no way back short of a hard reload. A failure says so out loud now, which makes that
 * symptom legible -- and does nothing to make it acceptable, so this rule still stands.
 *
 * `empty` IS final: the provider answered, and the answer was "nothing".
 */
export function isCacheableFacetSet(facets: ResolvedFacets): boolean {
  return Object.values(facets).every((f) => f?.status !== "pending" && f?.status !== "failed");
}

// --- ratings ---------------------------------------------------------------

/**
 * The IMDb score we already hold locally, as a first-class entry in the merged row.
 *
 * Without this the ratings row would show every source EXCEPT the one we can always
 * answer for free, and the row's whole point is that it is one row across sources.
 */
export function localImdbRating(rating: number, votes: number, url: string): Rating | null {
  if (!(rating > 0)) return null;
  return { source: "IMDb", kind: "user", value: rating, outOf: 10, count: votes, url };
}

/**
 * One row across sources, deduplicated by source and kind.
 *
 * A provider's own entry WINS over the local seed for the same source -- it carries a
 * vote count and a link we do not have -- and it takes the seed's position, so a late
 * contribution never reshuffles the row under the reader's eyes.
 */
export function mergeRatings(local: Rating | null, provided: readonly Rating[]): Rating[] {
  const byKey = new Map<string, Rating>();
  if (local) byKey.set(ratingKey(local), local);
  for (const [key, contribution] of richestPerKey(provided)) byKey.set(key, contribution);
  return [...byKey.values()];
}

/**
 * How much a contribution is worth when two of them claim the same tile.
 *
 * A link is worth more than a vote count because it is the only thing a reader can act
 * on: a tile that does not open the review page is a dead tile, whereas a missing count
 * merely prints one line less.
 */
function ratingRichness(r: Rating): number {
  return (r.url ? 2 : 0) + (r.count === undefined ? 0 : 1);
}

/**
 * The best contribution per source and kind, ranked on CONTENT rather than arrival.
 *
 * Two plugins send a `RottenTomatoes|critics` score and only one of them carries the
 * link, so ranking on position made the clickable tile a coin flip between an Algolia
 * call and a Radarr-proxy call -- the same title rendered a live link on one load and a
 * dead one on the next. A tie keeps the incumbent, so the row is stable rather than
 * merely differently arbitrary, and a winner inherits the loser's slot for the same
 * reason the local seed does: the row must not reshuffle as answers land.
 */
function richestPerKey(provided: readonly Rating[]): Map<string, Rating> {
  const richest = new Map<string, Rating>();
  for (const contribution of provided) {
    const key = ratingKey(contribution);
    const incumbent = richest.get(key);
    if (!incumbent || ratingRichness(contribution) > ratingRichness(incumbent)) {
      richest.set(key, contribution);
    }
  }
  return richest;
}

function ratingKey(r: Rating): string {
  return `${r.source.trim().toLowerCase()}|${r.kind}`;
}

/**
 * Rotten Tomatoes' own fresh/rotten line, and the only number in this file that is
 * somebody else's editorial rule rather than ours.
 */
const FRESH_AT = 60;

/**
 * The bundled mark for a rating source, or `null` when we have no art for it.
 *
 * A LOOKUP, not a slugify. Studio and network names are an unbounded vocabulary, so those
 * are folded through `slugifyLogo` on the server against a manifest; rating sources are a
 * fixed handful, and providers spell them inconsistently anyway (`servarr-metadata` emits
 * `Imdb`, the local seed emits `IMDb`). Matching a lowercased source against an explicit
 * table is both simpler and the only thing that survives that spelling difference.
 *
 * RT gets four marks rather than one because the tomato IS the score: a splat beside 34%
 * says the same thing twice, which is the point of the mark. Critics and audience are
 * different art, so the two tiles are distinguishable at a glance -- which is what the
 * text label was failing to do.
 *
 * `null` is ordinary. An unmapped source renders its name as text, exactly as before.
 */
export function ratingLogo(r: Rating): string | null {
  const source = sourceKey(r.source);

  if (source === "rottentomatoes") {
    if (r.kind === "user") return null;
    const half = r.kind === "critics" ? "crit" : "aud";
    // Percent scores only. A source that ever sent RT a /10 value would otherwise be
    // compared against 60 and always read rotten.
    if (r.outOf !== 100) return null;
    return logoPath(`rt-${half}-${r.value >= FRESH_AT ? "fresh" : "rotten"}`);
  }

  const flat: Record<string, string> = {
    imdb: "imdb",
    tmdb: "tmdb",
    metacritic: "metacritic",
    trakt: "trakt",
    letterboxd: "letterboxd",
    anidb: "anidb",
  };
  const slug = flat[source];
  return slug ? logoPath(slug) : null;
}

/** Same shape the server builds for studio marks, so the two never drift apart. */
function logoPath(slug: string): string {
  return `/logos/rating/${slug}.png`;
}

/**
 * How a provider's name is folded before anything is looked up by it.
 *
 * ONE owner, because two tables are keyed on it -- `ratingLogo` and `sourceName` -- and a
 * source the two disagree about is a tile wearing one provider's mark under another's name.
 * Alphanumerics only, so `RottenTomatoes`, `Rotten Tomatoes` and `rotten-tomatoes` are one
 * key; all three spellings are live in this repo already.
 */
function sourceKey(source: string): string {
  return source.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * How a provider is NAMED on screen, however it spells itself on the wire.
 *
 * Providers hand us their own id rather than a label. The `synopsis` facet carries `tvdb`
 * for a series and `tmdb` for a film, and rating sources arrive as `Imdb`, `Tmdb`,
 * `RottenTomatoes`. Printed raw, the attribution under a paragraph of prose is a lowercase
 * slug, which reads as a debug string rather than as credit to whoever wrote the summary.
 *
 * An unmapped source is returned VERBATIM, never title-cased. Guessing at somebody's
 * capitalisation is how `MUBI` becomes `Mubi` and `AniDB` becomes `Anidb`; printing exactly
 * what the provider called itself is the honest answer, and adding a real name is one line
 * here. Same rule as `ratingLogo` returning `null`: we say nothing rather than something
 * invented.
 */
export function sourceName(source: string): string {
  const names: Record<string, string> = {
    tvdb: "TheTVDB",
    thetvdb: "TheTVDB",
    tmdb: "TMDB",
    imdb: "IMDb",
    rottentomatoes: "Rotten Tomatoes",
    metacritic: "Metacritic",
    trakt: "Trakt",
    letterboxd: "Letterboxd",
    anidb: "AniDB",
  };
  return names[sourceKey(source)] ?? source;
}

/**
 * How a person's name is keyed when looking up our own id for it.
 *
 * A DELIBERATE second copy of `personNameKey` in `src/lib/people.ts`, for the same reason
 * `decadeOf` has one in `search-params.ts`: importing the value would pull a server module
 * into the browser bundle, which is a build-config decision rather than a tidying one. The
 * two must agree exactly -- the server builds the map with its copy and the client reads
 * it with this one, so a divergence silently unlinks every name rather than failing loudly.
 *
 * Case and surrounding space only. Punctuation is kept: a conservative fold that misses a
 * match costs one unlinked name, an eager one sends a reader to the wrong person.
 */
export function personNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Our person id for one credit, BY ID FIRST AND BY NAME SECOND.
 *
 * The single owner of that precedence, used by every cast tile and every crew line. The
 * order is not a preference: an id match is one identity resolved to another, while a name
 * match is a string that happens to be unique among the ten people IMDb bills on this title.
 * The name half is measurably wrong 1.7% of the time on the population it is the only answer
 * for -- IMDb holds two Peter Mileses, and no matcher can separate them -- so it is what we
 * fall back TO, never what we check first.
 *
 * **Null is a real answer and the correct one.** A credit resolves to nothing when the index
 * predates the tables, when the person is below the cast vote floor, when Wikidata's mapping
 * for them is ambiguous, or when two people on this title share a name. In every one of
 * those there is no page worth sending anyone to, and the dead-end rule says do not make it
 * look like there is.
 */
export function nconstForCredit(credit: PersonCredit, links: PersonLinks | undefined): string | null {
  if (!links) return null;
  const byId = credit.personId ? links.byId[credit.personId] : undefined;
  return byId ?? links.byName[personNameKey(credit.name)] ?? null;
}

/** `86%` for a /100 score, `7.4` for a /10 one, `4.2/5` for anything else. */
export function formatRatingValue(r: Rating): string {
  if (r.outOf === 100) return `${Math.round(r.value)}%`;
  if (r.outOf === 10) return r.value.toFixed(1);
  return `${r.value}/${r.outOf}`;
}

/** Critics and audience are different facts about the same film; `user` needs no label. */
export function ratingKindLabel(kind: Rating["kind"]): string | null {
  return kind === "user" ? null : kind;
}

/**
 * `999`, `743k`, `2.7M` -- the way the title header and the ratings row both print a count.
 *
 * Extracted rather than re-typed: the header and the ratings row print the same number
 * and would otherwise drift into two roundings of it.
 *
 * The millions tier is not decoration. Every title the ratings row is interesting for is a
 * popular one, and `k` alone printed Game of Thrones' 2,655,421 votes as `2655k` -- four
 * significant figures in a caption sized to hold three, which reads as a glitch rather than
 * as a number. One decimal place, so `2.7M` still says which of two blockbusters is bigger.
 */
export function formatVotes(votes: number): string {
  if (votes >= 1_000_000) return `${(votes / 1_000_000).toFixed(1)}M`;
  return votes >= 1000 ? `${Math.round(votes / 1000)}k` : String(votes);
}

// --- the reader's country --------------------------------------------------

/** Coverage is best for these, and one of them is intelligible almost everywhere. */
const FALLBACK_COUNTRIES = ["US", "GB"] as const;

/**
 * Which country's answer to show, most wanted first.
 *
 * ONE OWNER for the whole product: the certificate and the streaming row are the same
 * question -- "where is this reader?" -- asked by two panes, and two copies of the rule
 * would be two answers on one page. It was `preferredCertificationCountries` until the
 * streaming row needed it, which is when the name stopped being true.
 *
 * Locales are passed in rather than read from `navigator` so this stays pure and the
 * preference can come from a user setting later without touching the rule.
 */
export function preferredCountries(locales: readonly string[]): string[] {
  const out: string[] = [];
  for (const locale of locales) {
    const region = regionOf(locale);
    if (region && !out.includes(region)) out.push(region);
  }
  for (const country of FALLBACK_COUNTRIES) {
    if (!out.includes(country)) out.push(country);
  }
  return out;
}

function regionOf(locale: string): string | null {
  try {
    return new Intl.Locale(locale).region ?? null;
  } catch {
    // A hand-edited or truncated locale is expected input, not an error case.
    return null;
  }
}

/**
 * One certificate, not all forty-two.
 *
 * Falls back to the first country that has one rather than to nothing: a rating labelled
 * with its country is useful, and an empty pane where we hold 42 answers is not.
 */
export function pickCertification(
  certs: readonly Certification[],
  preferred: readonly string[],
): Certification | null {
  const rated = certs.filter((c) => c.rating.trim() !== "");
  for (const country of preferred) {
    const hit = rated.find((c) => c.country.toUpperCase() === country.toUpperCase());
    if (hit) return hit;
  }
  return rated[0] ?? null;
}

// --- language --------------------------------------------------------------

/**
 * The languages a title was made in, named in the reader's own words.
 *
 * THE NAME IS MADE HERE AND NEVER STORED. `Intl.DisplayNames` is a full CLDR table in
 * every browser, so `hi` reads as "Hindi" to an English reader and "हिन्दी" to a Hindi one
 * off the same cached row -- which is the whole reason the facet carries a code. A name in
 * the database would be one reader's English frozen into every other reader's page, and a
 * hand-written code -> name map would be a worse copy of a table already shipped.
 *
 * TWO THINGS ARE DROPPED, and neither can be caught upstream in `languageCode`:
 *
 *   - a code nothing can NAME. `xx` and `qqq` are well-formed language tags that name no
 *     language, so the canonicaliser accepts them; `DisplayNames` gives back the code
 *     itself, which is how this recognises the miss. Printing "Language: xx" at a reader
 *     is worse than printing nothing.
 *   - a DUPLICATE. The facet merges as a list, so two providers agreeing that a film is in
 *     Hindi contribute two entries -- the same collision `mergeRatings` and `watchServices`
 *     each guard from their own direction. Deduped on the NAME rather than the code, so
 *     `cmn` and `zh` cannot both print "Chinese".
 *
 * Locales are passed in rather than read off `navigator`, so this stays pure and the tests
 * pin a locale: `Intl` with no locale follows the test runner's, which makes an assertion
 * on a formatted string machine-dependent. Same rule `formatCalendarDate` follows.
 */
export function languageNames(langs: readonly Language[], locales: readonly string[]): string[] {
  const names = new Intl.DisplayNames(readableLocales(locales), { type: "language" });
  const out: string[] = [];
  for (const lang of langs) {
    const name = languageName(names, lang.code);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The reader's locales, minus anything `Intl` would throw on, with English behind them.
 *
 * ONE bad entry poisons the whole list -- the `DisplayNames` constructor rejects the array
 * rather than skipping the member -- so a truncated or hand-edited `navigator.languages`
 * would cost the reader every language name on the page rather than one. Filtering first
 * is what makes a junk locale cost nothing. `preferredCountries` treats the same input the
 * same way and for the same reason.
 */
function readableLocales(locales: readonly string[]): string[] {
  const usable = locales.filter((locale) => {
    try {
      return Intl.getCanonicalLocales(locale).length > 0;
    } catch {
      return false;
    }
  });
  return [...usable, "en"];
}

/** One language's name, or `null` when nothing can put a name to the code. */
function languageName(names: Intl.DisplayNames, code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  try {
    const name = names.of(trimmed);
    // `of` hands the code straight back when it knows no name for it.
    return !name || name.toLowerCase() === trimmed.toLowerCase() ? null : name;
  } catch {
    // A malformed code is expected input here, not an error case -- `of` throws on one,
    // and the pane simply has one less thing to say.
    return null;
  }
}

// --- crew ------------------------------------------------------------------

export interface CrewGroup {
  job: string;
  members: CrewMember[];
}

/** Who made it, in the order a reader looks for them. Everything else is secondary. */
const LEAD_JOBS = ["director", "creator", "writer", "screenplay", "story"];

/**
 * Crew grouped by job, leads first.
 *
 * Grouping matters more than it looks: a provider sends three writers as three entries,
 * and "Writer: A, B, C" is one line where three rows would be three.
 */
export function groupCrewByJob(crew: readonly CrewMember[]): { leads: CrewGroup[]; rest: CrewGroup[] } {
  const groups = new Map<string, CrewGroup>();
  for (const member of crew) {
    const key = member.job.trim().toLowerCase();
    if (key === "") continue;
    const group = groups.get(key);
    if (group) group.members.push(member);
    else groups.set(key, { job: member.job.trim(), members: [member] });
  }

  const leads: CrewGroup[] = [];
  for (const job of LEAD_JOBS) {
    const group = groups.get(job);
    if (group) {
      leads.push(group);
      groups.delete(job);
    }
  }
  // Alphabetical, so the secondary block is stable however the providers ordered it.
  const rest = [...groups.values()].sort((a, b) => a.job.localeCompare(b.job));
  return { leads, rest };
}

// --- release dates ---------------------------------------------------------

export interface ReleaseRow {
  label: string;
  date: string;
}

/** Only the three dated windows -- `byCountry` is a different pane's problem. */
const RELEASE_LABELS: [key: "cinema" | "physical" | "digital", label: string][] = [
  ["cinema", "Cinema"],
  ["physical", "Physical"],
  ["digital", "Digital"],
];

/** The dates we actually have, in cinema -> physical -> digital order. */
export function releaseRows(dates: ReleaseDates): ReleaseRow[] {
  const rows: ReleaseRow[] = [];
  for (const [key, label] of RELEASE_LABELS) {
    const value = dates[key];
    if (typeof value === "string" && value.trim() !== "") rows.push({ label, date: value });
  }
  return rows;
}

/**
 * A date a provider sent us, or that string verbatim if it is not one.
 *
 * Named for the shape rather than for one pane's use of it: a cinema release, a season
 * premiere and an episode air date are the same `YYYY-MM-DD` printed the same way, and a
 * second formatter for the second caller would be a second rounding of the same fact.
 *
 * The ISO shape is checked BEFORE parsing rather than relying on `Date.parse` failing:
 * `Date.parse` is lenient enough to turn "sometime in 2010" into January 1st, and a
 * fabricated date is worse than an ugly one.
 *
 * Formatted in UTC deliberately. A date-only `2010-07-16` parses as UTC midnight, so
 * rendering it in the viewer's own zone shows the 15th to everybody west of Greenwich.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/;

export function formatCalendarDate(value: string, locales?: string | string[]): string {
  const ms = ISO_DATE.test(value.trim()) ? Date.parse(value.trim()) : Number.NaN;
  if (Number.isNaN(ms)) return value;
  return new Intl.DateTimeFormat(locales, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(ms));
}

/**
 * `Tue, Aug 24` -- a date on a SHELF CARD, which rounds differently from a date in a pane.
 *
 * A sibling of `formatCalendarDate` rather than a replacement, and it lives beside it so
 * date formatting still has one owner in one file. The two differ because the questions
 * differ: a release date in a pane is a historical fact and wants its YEAR; a card on
 * "Airing soon" is always inside about three weeks, where the year is noise and the
 * WEEKDAY is the thing a reader actually wants -- "is that tonight, or next weekend?".
 *
 * UTC like its sibling, because the mirror stores a plain `YYYY-MM-DD` with no time in
 * it; parsing that in local time shifts the day backwards for anyone west of Greenwich
 * and would print the wrong weekday for half the planet.
 */
export function formatShelfDate(value: string, locales?: string | string[]): string {
  const ms = ISO_DATE.test(value.trim()) ? Date.parse(value.trim()) : Number.NaN;
  if (Number.isNaN(ms)) return value;
  return new Intl.DateTimeFormat(locales, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

/**
 * What a card says about a date: `Tonight`, `Tomorrow`, or `Tue, Aug 24`.
 *
 * The two relative words earn their place because they are what makes the shelf scannable
 * -- "Tonight" is read at a glance and `Tue, Aug 24` has to be worked out against today.
 * Anything further out gets the absolute date, because "in 9 days" is harder to act on
 * than a weekday you can find on a calendar.
 *
 * Yesterday is deliberately NOT special-cased into a word. A past episode is unusual on a
 * shelf called "Airing soon" and the date should look different enough to notice.
 */
export function shelfDateLabel(date: string, today: string, locales?: string | string[]): string {
  if (date === today) return "Tonight";
  if (date === addDays(today, 1)) return "Tomorrow";
  return formatShelfDate(date, locales);
}

function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

// --- trailers --------------------------------------------------------------

export interface TrailerLink {
  url: string;
  /** The visible text when there is no mark, and the accessible name in every case. */
  label: string;
  /** The host's mark on disk, or null when we have no art for it. */
  logo: string | null;
}

/**
 * How to reach a trailer on the sites we know how to reach.
 *
 * A facet carries `{site, key}` and never a URL, so the address is built here -- and only
 * for a site named in this table. An unknown site yields no link rather than a guessed
 * one: a dead link is worse than an absent pane. A new site is one entry here and no
 * change to anything that renders a trailer.
 *
 * `youtube` is the only entry because it is the only site any provider emits today
 * (`src/plugins/servarr/radarr.ts` maps Radarr's `YoutubeTrailerId`); the table is the
 * seam, not a prediction about which site comes second.
 */
const TRAILER_SITES: Record<string, (key: string) => string> = {
  youtube: (key) => `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`,
};

/** What the link says. Providers name few trailers, so the kind is the usual answer. */
function trailerLabel(trailer: Trailer): string {
  return trailer.name?.trim() || trailer.kind?.trim() || "Trailer";
}

/**
 * A trailer host -> the Kometa slug for its mark, in the STREAMING set.
 *
 * There is no `trailer` group in the imported logo set and this deliberately does not add
 * one. `bun run logos:import` writes exactly four groups -- rating, streaming, network,
 * studio -- so a fifth directory would be a PNG placed by hand that the importer neither
 * writes nor refreshes, which is the drift `assets/brand` has its own rule about. YouTube
 * is already in the streaming set because TMDB sells it as a service, and it is the same
 * mark either way: what a logo means does not change with the folder it sits in.
 *
 * Keyed on the SITE id a provider sends (`src/plugins/servarr/radarr.ts` emits `youtube`),
 * not on a service name, so this stays a separate table from `STREAMING_MARKS` rather than
 * a call into it -- the two are keyed on different vocabularies that happen to agree on one
 * word today. `null` is ordinary and is the answer for every host we have no art for.
 *
 * Exported for the manifest guard in the tests, the same as `STREAMING_MARKS`.
 */
export const TRAILER_MARKS: Record<string, string> = {
  youtube: "youtube",
};

/**
 * The mark for a trailer host, or `null` when we have none.
 *
 * Same shape and same reason as `ratingLogo` and `streamingLogo`: the client names a file
 * directly rather than reading the logo manifest, so a test asserts every path this can
 * emit exists in `src/logos.json` and an upstream rename fails the suite instead of 404ing
 * in somebody's browser.
 */
export function trailerLogo(site: string): string | null {
  const slug = TRAILER_MARKS[site.trim().toLowerCase()];
  return slug ? `/logos/streaming/${slug}.png` : null;
}

/**
 * The trailers we can actually open, in the order the providers sent them.
 *
 * `trailer` merges as a list, so two plugins can contribute the same video and a reader
 * would see the same link twice; deduplicating on the built URL keeps the first one,
 * which is the same "a late contribution never reshuffles the row" rule the ratings row
 * follows.
 */
export function trailerLinks(trailers: readonly Trailer[]): TrailerLink[] {
  const byUrl = new Map<string, TrailerLink>();
  for (const trailer of trailers) {
    const site = trailer.site.trim().toLowerCase();
    const buildUrl = TRAILER_SITES[site];
    const key = trailer.key.trim();
    if (!buildUrl || key === "") continue;
    const url = buildUrl(key);
    if (!byUrl.has(url)) {
      byUrl.set(url, { url, label: trailerLabel(trailer), logo: trailerLogo(site) });
    }
  }
  return [...byUrl.values()];
}

// --- seasons and episodes --------------------------------------------------

/**
 * TVDB's convention, which skyhook passes straight through: season 0 is the specials.
 *
 * Behind trailers, recaps and behind-the-scenes shorts, and there are 55 of them on Game
 * of Thrones -- more than any real season. Landing a reader there would be wrong, so the
 * ordering below puts it last and `defaultSeasonNumber` therefore never picks it.
 */
export const SPECIALS_SEASON = 0;

function specialsLast(season: Season): number {
  return season.number === SPECIALS_SEASON ? 1 : 0;
}

/** Ascending by number, with the specials moved to the end where they belong. */
export function orderSeasons(seasons: readonly Season[]): Season[] {
  return [...seasons].sort((a, b) => specialsLast(a) - specialsLast(b) || a.number - b.number);
}

/**
 * The season a reader lands on with no choice made yet.
 *
 * Reads the first of the ordered list rather than re-stating "not the specials", so the
 * two rules cannot disagree. Null only when there are no seasons at all, which a pane
 * never renders -- `paneView` has already hidden an empty list by then.
 */
export function defaultSeasonNumber(seasons: readonly Season[]): number | null {
  return orderSeasons(seasons)[0]?.number ?? null;
}

/**
 * The season one step either side of the current one, for the ← and → keys.
 *
 * Ordered-position arithmetic, not number arithmetic: the specials are season 0 and sit
 * LAST, so "one to the left of Specials" is the final real season rather than season -1.
 * Clamped at both ends -- an arrow at the edge of the list does nothing, which is what a
 * reader expects from a row of chips and cheaper to reason about than wrapping around.
 */
export function adjacentSeasonNumber(
  ordered: readonly Season[],
  current: number | null,
  step: 1 | -1,
): number | null {
  const at = ordered.findIndex((s) => s.number === current);
  if (at === -1) return null;
  return ordered[Math.min(Math.max(at + step, 0), ordered.length - 1)]?.number ?? null;
}

/** `Specials`, `Season 3`, or `Season 3 · Fire and Blood` where skyhook named it. */
export function seasonLabel(season: Season): string {
  if (season.number === SPECIALS_SEASON) return "Specials";
  const numbered = `Season ${season.number}`;
  return season.name?.trim() ? `${numbered} · ${season.name.trim()}` : numbered;
}

/**
 * When the season ran: `17 Apr 2011 – 19 Jun 2011`, or one date, or nothing.
 *
 * Both ends are derived from the episodes by the provider, so a season still airing has
 * an `endDate` that is simply its latest known episode. Collapsing an identical pair to a
 * single date keeps a one-episode season from reading as a range from a day to itself.
 */
export function seasonAirRange(season: Season, locales?: string | string[]): string | null {
  const first = season.premiereDate ? formatCalendarDate(season.premiereDate, locales) : null;
  const last = season.endDate ? formatCalendarDate(season.endDate, locales) : null;
  if (!first) return last;
  if (!last || last === first) return first;
  return `${first} – ${last}`;
}

/** One season's episodes, in broadcast order, without mutating the provider's array. */
export function episodesForSeason(episodes: readonly Episode[], season: number): Episode[] {
  return episodes.filter((e) => e.season === season).sort((a, b) => a.number - b.number);
}

/** A provider that sent no title still gets a row -- the air date is what we came for. */
export function episodeLabel(episode: Episode): string {
  return episode.title?.trim() || `Episode ${episode.number}`;
}

/**
 * Sonarr's episode list as a lookup, keyed on the pair the two sources agree on.
 *
 * The key format is built HERE and read HERE, from a list the server sent as two integers
 * per row -- so unlike `personNameKey` there is no second copy on the server that could
 * drift out of step with it.
 */
export function episodeStateIndex<T extends { season: number; episode: number }>(
  states: readonly T[] | undefined,
): Map<string, T> {
  return new Map((states ?? []).map((s) => [`${s.season}:${s.episode}`, s]));
}

/** Enough rows that the area does not look broken when a season count is missing. */
const ASSUMED_EPISODES_PER_SEASON = 6;

/** Past this the placeholder reserves more screen than anybody waits in front of. */
const MAX_SKELETON_EPISODE_ROWS = 12;

/**
 * How many placeholder rows to reserve while a season's episodes are still landing.
 *
 * Sized from the count on the season we already hold, so the space reserved is the real
 * height rather than a guess -- capped, because the 55-episode specials season would
 * otherwise reserve four screens for a list that is about to replace it anyway.
 */
export function episodeSkeletonRows(season: Season | null): number {
  const count = season?.episodeCount ?? ASSUMED_EPISODES_PER_SEASON;
  return Math.min(Math.max(count, 1), MAX_SKELETON_EPISODE_ROWS);
}

// --- images ----------------------------------------------------------------

/**
 * A facet image we are willing to put in an `<img>`, or null.
 *
 * finderr is internet-facing while its metadata providers are an implementation detail,
 * so the browser is never handed an upstream URL -- the same rule `posterUrl` follows in
 * `./api`. It guards all four image fields the vocabulary declares: cast and crew
 * headshots, season posters, episode stills.
 *
 * The server rewrites those four to `/img/f/<key>` before the facet leaves
 * `/api/title/:tconst` (`src/server/facet-images.ts`), so what arrives here is normally
 * same-origin and passes. This stays a GUARD rather than becoming dead code: anything the
 * server did NOT rewrite -- a facet shape nobody anticipated, a provider reaching the
 * client by some other route -- is still refused here.
 */
export function localImageUrl(image: string | null): string | null {
  if (!image) return null;
  // A protocol-relative "//host/x" is an absolute URL wearing a relative costume.
  return image.startsWith("/") && !image.startsWith("//") ? image : null;
}

/** Two letters standing in for a missing headshot. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}

/** Billing order, as the provider declared it. */
export function byBillingOrder<T extends { order: number }>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => a.order - b.order);
}

// --- links out -------------------------------------------------------------

/**
 * A URL we are willing to put in an `href`, normalised, or null.
 *
 * The mirror image of `localImageUrl` above, and the two are opposites on purpose. An
 * `<img>` may only load from OUR origin, because the browser fetching a provider's CDN is
 * a leak and a request it could not make anyway. A LINK is the one thing that is supposed
 * to leave: a reader clicking "IMDb" wants imdb.com. So this guard is about the SCHEME
 * rather than the origin -- `http:` and `https:` and nothing else.
 *
 * `javascript:` is the reason it exists. `links` is a plugin-fed facet, and while a plugin
 * already runs with the server's privileges -- so this is not the wall that stops a hostile
 * addon -- an href is the one place a merely SLOPPY provider turns a bad string into script
 * in the reader's page. `new URL` with no base also rejects a relative path, which is
 * correct here: a link out that is not absolute is a bug in whoever sent it.
 *
 * Returns `parsed.href` rather than the input, so two spellings of one address dedupe.
 */
export function externalHref(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    // Not a URL at all. Nothing to render, and nothing worth guessing at.
    return null;
  }
}

/**
 * The one place that knows how an IMDb id becomes an IMDb page.
 *
 * It used to be `imdbUrl` in `./api`, called by `TitleRoute` for its footer line and by the
 * ratings row for the score we hold locally. It lives here now because this is where every
 * other address is built -- and because it could not stay: `./api` value-imports
 * `isCacheableFacetSet` from this module, so reaching back the other way would have made
 * the two mutually recursive.
 */
export function imdbUrl(tconst: string): string {
  return `https://www.imdb.com/title/${tconst}/`;
}

/** A destination as the pane draws it: somewhere to go, and what to call it. */
export interface TitleLink {
  url: string;
  label: string;
}

/**
 * How a site or a kind of link is NAMED on screen.
 *
 * One table for both halves of the row -- the sites we build addresses for, and the kinds a
 * provider sends -- so a link cannot be called one thing when we derived it and another when
 * somebody contributed it. Falls through to `sourceName`, which already knows the handful
 * this shares with the ratings row, and which returns an unknown name verbatim rather than
 * inventing a capitalisation.
 */
const LINK_NAMES: Record<string, string> = {
  tvmaze: "TVmaze",
  mal: "MyAnimeList",
  anilist: "AniList",
  homepage: "Official site",
};

function linkName(kind: string): string {
  return LINK_NAMES[sourceKey(kind)] ?? sourceName(kind);
}

/**
 * A site we know how to reach, given an id we already hold.
 *
 * `space` is the key in `externalIds` the address is built from. Three sites read `imdb`,
 * which every title has: our own `tconst` IS an IMDb id, so IMDb, Trakt and Letterboxd cost
 * no provider and are on the page at t=0.
 */
interface LinkSite {
  /** Names the site, and the key `LINK_NAMES` labels it by. */
  id: string;
  space: string;
  /** `null` when this site has no page for this kind of title. */
  url: (id: string, kind: EntityKind) => string | null;
}

/**
 * Every id space that is also a destination, in the order the row draws them.
 *
 * A TABLE, not a switch, for the same reason `TRAILER_SITES` is one: adding a site is one
 * entry here and no change to anything that renders a link. An id space MISSING from it
 * yields no link rather than a guessed one -- which is the dead-end rule, and it has a live
 * example. `tvrage` arrives in `externalIds` on almost every series and is not here: the
 * real TVRage shut down in 2018 and the domain now serves a scraped SEO clone, so a chip
 * saying "TVRage" would look exactly like the other eight and land somewhere we would not
 * send anyone.
 *
 * Order is IMDb first because it is the id this whole product is built on and the one
 * asked for by name; the rest run broad-to-narrow.
 *
 * EVERY ADDRESS BELOW WAS OPENED IN A BROWSER, SIGNED OUT, ON 2026-09-03. The date is here
 * because these rot: the Trakt entry was correct when written and had silently 404ed for
 * some time before anyone noticed, and the comment asserting it was fine is what stopped
 * the re-check. Two rules learned from that, for whoever re-verifies these next: a status
 * code is not an answer on a client-rendered site -- Trakt's dead search answers 200 -- and
 * it has to be checked SIGNED OUT, because a maintainer's own browser is logged in.
 */
const LINK_SITES: readonly LinkSite[] = [
  { id: "imdb", space: "imdb", url: (id) => imdbUrl(id) },
  {
    id: "trakt",
    space: "imdb",
    // Trakt's item pages accept an IMDb id where their own slug goes, and render for a
    // signed-out reader. Their SEARCH does not: every /search address answers 200 and shows
    // a signup wall, which is the dead-end shape this table exists to keep off the page.
    // Kind-dependent like TMDB's, for the same reason -- the path segment is Trakt's URL
    // layout, not something the title vocabulary knows about.
    url: (id, kind) => `https://trakt.tv/${kind === "series" ? "shows" : "movies"}/${id}`,
  },
  {
    id: "tmdb",
    space: "tmdb",
    // The one address whose shape depends on what kind of thing this is. Not a `title.kind`
    // check in a pane -- the vocabulary says nothing about TMDB's URL layout, and the kind
    // arrives already collapsed by the server. See `entityKindOf`.
    url: (id, kind) => `https://www.themoviedb.org/${kind === "series" ? "tv" : "movie"}/${id}`,
  },
  // Films only -- Letterboxd does not catalogue television, and its `/imdb/` redirect
  // answers 200 with a not-found page for a series rather than refusing, so a series link
  // would look live and be a dead end.
  {
    id: "letterboxd",
    space: "imdb",
    url: (id, kind) => (kind === "series" ? null : `https://letterboxd.com/imdb/${id}/`),
  },
  { id: "tvdb", space: "tvdb", url: (id) => `https://thetvdb.com/dereferrer/series/${id}` },
  { id: "tvmaze", space: "tvmaze", url: (id) => `https://www.tvmaze.com/shows/${id}` },
  { id: "mal", space: "mal", url: (id) => `https://myanimelist.net/anime/${id}` },
  { id: "anidb", space: "anidb", url: (id) => `https://anidb.net/anime/${id}` },
  { id: "anilist", space: "anilist", url: (id) => `https://anilist.co/anime/${id}` },
];

/**
 * The kind of thing this is, read off the field the server already decided it on.
 *
 * `Title.kind` is IMDb's raw `titleType` -- `tvMiniSeries`, `tvMovie`, `short` -- and
 * collapsing it is `entityKindFor`'s job in `src/lib/facets.ts`. Importing that would be a
 * VALUE cross-import pulling a server module into the browser bundle, and copying it would
 * be a second owner of the collapse. Neither is necessary: `service` is that same function's
 * answer, computed on the server in `serviceFor` and already on the wire.
 */
export function entityKindOf(title: { service: "radarr" | "sonarr" }): EntityKind {
  return title.service === "sonarr" ? "series" : "movie";
}

/**
 * Everywhere else this title lives: the addresses we can build, then the ones we were given.
 *
 * DERIVED FIRST, and derived rather than stored. Every entry in `LINK_SITES` is a pure
 * function of an id we already hold, so IMDb, Trakt and Letterboxd render at t=0 with no
 * provider at all and the rest land the moment `externalIds` does. Storing those URLs in
 * the `links` facet would be storing a second copy of `externalIds`, which is how the two
 * come to disagree.
 *
 * CONTRIBUTED SECOND, and only what no id space could express -- an official site, a
 * campaign page. Appended rather than interleaved so the row's familiar half never moves
 * as a provider answers; the same "a late contribution does not reshuffle the row" rule the
 * ratings row follows, one facet along.
 *
 * Deduplicated on the normalised URL, first writer winning, so a provider contributing an
 * address we already build does not print the chip twice.
 */
export function titleLinks(
  tconst: string,
  kind: EntityKind,
  ids: ExternalIds | undefined,
  provided: readonly ExternalLink[] | undefined,
): TitleLink[] {
  // Our own id, under the name every site keys on. A provider's `externalIds` normally
  // carries the same value; seeding it here is what makes the first three links free.
  const spaces: ExternalIds = { imdb: tconst, ...(ids ?? {}) };
  const byUrl = new Map<string, TitleLink>();

  for (const site of LINK_SITES) {
    const id = singleId(spaces[site.space]);
    if (id === null) continue;
    const url = externalHref(site.url(id, kind));
    if (url && !byUrl.has(url)) byUrl.set(url, { url, label: linkName(site.id) });
  }

  for (const link of provided ?? []) {
    const url = externalHref(link?.url);
    // A provider's own name wins -- "Warner Bros." says more than "Official site", and a
    // plugin that bothered to send one knows something the kind alone does not.
    const label = link.name?.trim() || linkName(link.kind ?? "");
    if (url && !byUrl.has(url)) byUrl.set(url, { url, label });
  }

  return [...byUrl.values()];
}

/**
 * What an id has to look like before it is pasted into a URL path.
 *
 * A WHITELIST rather than `encodeURIComponent`, because escaping is the wrong answer here:
 * every id space in `LINK_SITES` is a bare number or a `tt`-prefixed one, so a value with a
 * slash or a space in it is junk rather than something to escape -- and escaping it would
 * dutifully build a link to a page that cannot exist. Refusing costs one missing chip.
 */
const BARE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One usable id, or null when there is not exactly one.
 *
 * The anime spaces are comma-joined LISTS -- a TVDB series can map to several AniDB
 * entries, and `externalIds` carries them as `"1,2,3"`. Picking one would be a guess, and
 * rendering three chips all labelled "AniDB" is a row the reader cannot choose from. So a
 * multi-valued space contributes nothing, which is the same answer `PersonLink` gives when
 * two people share a name on one title. `BARE_ID` rejects the comma on its own; it is
 * called out here because that case is a real shape upstream sends, not a malformed one.
 */
function singleId(value: string | number | undefined): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const id = value.trim();
  return BARE_ID.test(id) ? id : null;
}
