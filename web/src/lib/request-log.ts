/**
 * The rules behind `/log` -- ordering the request log, and who is in it.
 *
 * Pure functions over rows, with no React and no DOM, for the same reason
 * `pollWhileWorking` lives beside its hook: the decisions worth pinning here are decisions
 * about DATA, and a test for them should not have to render anything.
 */

import type { MediaRequest } from "./api";
import { summariseSeasons } from "./season-select";

/**
 * "Seasons 1-3", when the reader chose some. Null for a film, or for a series asked for
 * whole.
 *
 * Here rather than in either route because BOTH pages that list requests print it, and a
 * second copy would be two roundings of one fact -- the same reason `formatCalendarDate` has
 * one owner. `null` covers three cases that all render as nothing: a film, "all seasons",
 * and a stored list that parses to no numbers at all.
 */
export function seasonLine(request: Pick<MediaRequest, "seasons">): string | null {
  if (!request.seasons) return null;
  const numbers = request.seasons
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  return numbers.length > 0 ? summariseSeasons(numbers) : null;
}

/**
 * The log, newest ASKED first.
 *
 * > [!IMPORTANT] `created_at`, never `updated_at` -- they answer different questions
 * > The server sorts by `updated_at`, which the request worker rewrites on every status
 * > change, so a week-old request retrying its way through a stalled download keeps jumping
 * > back to the head of the list and reads as newer than everything asked for since. That is
 * > the right order for "what has moved lately"; it is the wrong order for a LOG, where the
 * > question is what was asked and when. `recentlyRequestedIds` in `src/lib/store.ts` made
 * > the same call for the same reason, and says so at length.
 *
 * `id` breaks the tie, because two requests made in the same millisecond carry the same ISO
 * string and an order that reshuffles between loads is worse than one that is imperfect.
 *
 * Generic over the row rather than tied to `MediaRequest`, because the admin user page lists
 * one person's requests from a NARROWER payload (`AttributedRequest`, no derived verdict) and
 * needs this exact ordering rule. One rule, two row shapes, and the type parameter is what
 * lets the second caller reuse it instead of re-sorting by `updated_at` and re-learning why
 * that is wrong.
 */
export function logOrder<T extends Pick<MediaRequest, "id" | "created_at">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
}

/**
 * May this reader be shown WHO asked?
 *
 * Answered by whether the SERVER sent attribution, never by a role the client holds an
 * opinion about. `attributedRequest` (`src/lib/auth.ts`) omits the key entirely for anybody
 * who is not an admin, so its presence IS the permission -- and the browser therefore has no
 * second copy of the rule to get wrong. A reader who is not an admin has no id in their JSON
 * to draw even if a component tried.
 *
 * An empty log answers `false`, which costs nothing: there is no column to head.
 */
export function attributionVisible(rows: readonly MediaRequest[]): boolean {
  return rows.some((r) => "requestedByName" in r);
}

/** One person in the log, and how much of it is theirs. */
export interface Requester {
  /** The user id, or null for the rows nobody is attached to. */
  id: string | null;
  name: string;
  count: number;
}

/**
 * Everybody who appears in the log, most prolific first.
 *
 * The filter bar on the admin's view of the log, and the answer to "who is asking for all
 * this" before any filtering happens. Ordered by COUNT and then by name, so the row does not
 * reshuffle as requests land -- the same stability rule the shelves follow.
 *
 * Unattributed rows collapse into one entry with a null id rather than being dropped: a
 * request made before attribution existed is still a request, and hiding it would make the
 * counts disagree with the log they sit above.
 */
export function requesters(rows: readonly MediaRequest[]): Requester[] {
  const seen = new Map<string, Requester>();
  for (const row of rows) {
    if (!("requestedByName" in row)) continue;
    const id = row.requested_by ?? null;
    const key = id ?? "";
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    seen.set(key, { id, name: row.requestedByName ?? "Unattributed", count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * The log narrowed to one person, or all of it.
 *
 * `who: undefined` means no filter; `who: null` means the unattributed rows, which is a real
 * selection and not the absence of one. Keeping those apart is why this takes a
 * `string | null | undefined` rather than a string and a boolean.
 */
export function byRequester(rows: readonly MediaRequest[], who: string | null | undefined): MediaRequest[] {
  if (who === undefined) return [...rows];
  return rows.filter((r) => (r.requested_by ?? null) === who);
}
