/**
 * The URL is the search state.
 *
 * v0 kept the query and the facet filters in `useState`, which meant a refresh lost
 * your place, the back button left the app entirely, and a result set could not be
 * sent to anyone. Putting them in the URL fixes all three at once and is the whole
 * reason for adopting a router.
 */

import type { Filters } from "./api";

export interface SearchParams extends Filters {
  /** The raw query string, exactly as typed. */
  q?: string;
  /**
   * Which credit categories a person page is showing, comma-separated.
   *
   * A LIST because IMDb's vocabulary is not the reader's: "Acting" is `actor,actress`,
   * and sending only one would drop half the filmography while still looking right.
   */
  role?: string;
  /**
   * Which ORDER a browse is in -- and therefore which list you are looking at.
   *
   * In the URL, unlike `minVotes`, and the two are different kinds of thing. `minVotes` is
   * a tuning threshold that would become shareable state somebody has to keep meaningful
   * across index rebuilds; `sort=rank` is the difference between "every horror film" and
   * "the best horror films", which is a destination worth sending to someone.
   *
   * Absent means votes-ordered, so every link that existed before this param still means
   * exactly what it meant.
   *
   * ONE KEY ACROSS BOTH ROUTES, and each route understands one value: `rank` is browse's,
   * `year` is the person page's. They are the same kind of thing -- "which ordering am I
   * reading this list in" -- so a second key would be two names for one idea, and the
   * route that does not understand a value simply falls back to its own default rather
   * than erroring. Absent still means votes-ordered on both.
   */
  sort?: "rank" | "year";
}

/** Parse a positive integer, or undefined for anything that is not one. */
function posInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : undefined;
}

/**
 * `q` alone keeps its whitespace, and that is not a stylistic exception.
 *
 * The search box is CONTROLLED by what this validator returns -- `RootLayout` reads
 * `search.q` straight into the input's `value` -- so trimming here is not normalising a
 * URL, it is editing the user's keystrokes as they type. A trailed `"blade "` came back
 * as `"blade"` on the very next render and the space was unpressable: no query of more
 * than one word could be typed at all.
 *
 * Whitespace-only still drops, so `?q=%20%20` does not survive as a query. Every consumer
 * that actually SEARCHES trims for itself (`SearchRoute`, the server's `parseQuery`),
 * which is the right place for it -- the URL holds what was typed, the query is what it
 * means.
 */
function typedText(v: unknown): string | undefined {
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  return v;
}

/**
 * Validate and normalise the URL's search params.
 *
 * Hand-typed and stale URLs are expected input, so nothing here throws -- a junk
 * `decade=banana` is dropped rather than turned into an error page. Every key is
 * omitted when empty so the URL stays clean instead of accumulating `?q=&genre=`.
 */
export function validateSearch(raw: Record<string, unknown>): SearchParams {
  const out: SearchParams = {};
  const q = typedText(raw.q);
  if (q) out.q = q;
  const genre = nonEmpty(raw.genre);
  if (genre) out.genre = genre;
  const kind = nonEmpty(raw.kind);
  if (kind) out.kind = kind;
  const decade = posInt(raw.decade);
  if (decade) out.decade = decade;
  const year = posInt(raw.year);
  if (year) out.year = year;
  const role = nonEmpty(raw.role);
  if (role) out.role = role;
  // Only the non-defaults are spelled: `?sort=votes` would be a second way to write the
  // URL that already means that, and two spellings of one page are two cache entries.
  if (raw.sort === "rank" || raw.sort === "year") out.sort = raw.sort;
  return out;
}

/**
 * `collection:"lord of the rings"` -> `lord of the rings`, or null for an ordinary query.
 *
 * A NAVIGATION token, not a filter, and that is why it is parsed here rather than in the
 * server's `parseQuery`. Collection membership lives in the facet cache (`finderr.db`)
 * while search runs against the title index (`titles.db`) -- two separate SQLite files,
 * so `engine.search()` could not narrow by a collection even if it wanted to. What the
 * token means is "take me to that node", which is a decision about the URL, which is
 * what this module owns.
 *
 * Quotes are optional and stripped, because a franchise name has spaces and half the
 * people typing one will quote it.
 *
 * THE CLOSING QUOTE IS A COMMIT GESTURE, and `closed` is what reports it. Every keystroke
 * lands in the URL, so an unquoted token is read while it is still being typed:
 * `collection:star trek` passes through `collection:star`, which on its own matches one
 * collection -- Star Wars. Anything that navigates on that reading throws away the rest of
 * the typing. A closed pair of quotes is the reader saying the name is finished, and it is
 * the only signal here that does not amount to guessing when somebody has stopped typing.
 * `CollectionJump` is where the distinction is spent.
 */
const COLLECTION_TOKEN = /^\s*collection:\s*(?:"([^"]*)"|(.*))$/i;

export interface CollectionToken {
  name: string;
  /** The reader typed a closing quote, so this name is finished rather than in progress. */
  closed: boolean;
}

export function collectionTokenOf(q: string | undefined): CollectionToken | null {
  const m = COLLECTION_TOKEN.exec(q ?? "");
  if (!m) return null;
  const quoted = m[1] !== undefined;
  const name = (m[1] ?? m[2] ?? "").trim();
  return name.length > 0 ? { name, closed: quoted } : null;
}

/**
 * The `decade` filter value a year falls in -- 1994 is in the 1990s.
 *
 * The server's browse and facet queries do the same arithmetic; this is the client
 * copy, and it lives here because a decade is a filter value before it is anything
 * else. Anything wanting to link a year to its decade uses this rather than
 * spelling the floor division out again.
 */
export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * The filter half of the params, which is what the search and browse APIs take.
 *
 * PICKS the known filter keys rather than omitting the others. It used to omit `q` and
 * pass everything else through, which silently broke the moment a non-filter param was
 * added: `role` -- a person page's credit-category selection -- would have ridden into
 * `/api/browse?role=...` and, worse, into the browse cache key, so two identical grids
 * reached from different pages would have been two entries.
 *
 * A new filter needs a line here. That is the point: an omit-list quietly accepts
 * anything, a pick-list makes you say what you mean.
 */
export function filtersOf(s: SearchParams): Filters {
  const filters: Filters = {};
  if (s.genre !== undefined) filters.genre = s.genre;
  if (s.kind !== undefined) filters.kind = s.kind;
  if (s.decade !== undefined) filters.decade = s.decade;
  if (s.year !== undefined) filters.year = s.year;
  return filters;
}

/**
 * Apply a facet toggle.
 *
 * Clicking an already-active facet clears it -- the chip is a toggle, not a radio.
 * Returns a whole new params object because that is what `navigate({ search })` wants.
 */
export function toggleFilter(current: SearchParams, patch: Filters): SearchParams {
  const next: SearchParams = { ...current, ...patch };
  for (const k of Object.keys(patch) as (keyof Filters)[]) {
    if (current[k] === patch[k]) delete next[k];
  }
  return next;
}
