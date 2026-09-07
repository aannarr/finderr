/**
 * The rules behind `/log` -- ordering the request log, and who is in it.
 *
 * Pure functions over rows, with no React and no DOM, for the same reason
 * `pollWhileWorking` lives beside its hook: the decisions worth pinning here are decisions
 * about DATA, and a test for them should not have to render anything.
 */

import { VERDICT_COPY } from "../../../src/lib/request-diagnostics";
import { decodeSeasons } from "../../../src/lib/seasons";
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
  // `decodeSeasons` is the one owner of how a selection is spelled in that column, and it
  // already answers null for all three of the cases that render as nothing. A `split(",")`
  // here was a fourth copy of a rule that file exists to hold once.
  const numbers = decodeSeasons(request.seasons);
  return numbers ? summariseSeasons(numbers) : null;
}

/**
 * Is anything in this list still moving?
 *
 * The question `/requests` asks before it refetches: a page of arrived and dead-ended rows
 * reads exactly the same in eight seconds, so polling it is chatter -- and a page with a bar
 * on it that does NOT refetch is a bar frozen at whatever percentage it loaded with.
 *
 * Asked of the TONE rather than of the verdict, because `working` is already the single owner
 * of "keep waiting" (`VERDICT_COPY`). Listing the verdicts here would be a second copy of that
 * rule, free to disagree the next time one is added.
 *
 * A row with no verdict at all counts as NOT working: the server sends `null` for a request it
 * cannot say anything about, and treating an unknown as in-flight is how a page polls forever.
 */
export function hasWorkInFlight(rows: readonly Pick<MediaRequest, "requestVerdict">[]): boolean {
  return rows.some((r) => r.requestVerdict !== null && VERDICT_COPY[r.requestVerdict].tone === "working");
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
 * `/requests`, ordered: newly-arrived first, then everything else by most recent activity.
 *
 * The server already sorts by `updated_at`, so this only lifts the news to the top -- which
 * is the one thing a reader who followed the ready badge came for. A stable partition rather
 * than a full comparator: within each group the server's order is kept.
 *
 * > [!IMPORTANT] `news` is the VISIT's memory of what was new, and it overrides the server
 * > `isNew` is derived per read from `available_seen_at`, and opening the page clears that
 * > column -- so the second poll comes back with every flag false, and the markers the reader
 * > is looking at would vanish under them, taking the ordering with them. The caller
 * > accumulates the set across the visit and never prunes it: something that was news while
 * > you were on this page stays marked until you leave. Which is what the marker means.
 *
 * Beside `logOrder` rather than in the route because they are the same kind of thing -- the
 * two orderings the two request lists use -- and keeping them apart is how a page ends up
 * re-deriving the other one's rule slightly differently.
 */
export function newsFirst(requests: readonly MediaRequest[], news: ReadonlySet<string>): MediaRequest[] {
  const marked = requests.map((r) => (news.has(r.tconst) ? { ...r, isNew: true } : r));
  return [...marked.filter((r) => r.isNew), ...marked.filter((r) => !r.isNew)];
}

/**
 * The buckets `/requests` reads as a dashboard rather than as a receipt.
 *
 * THREE OF THEM ARE `VerdictTone` UNDER ANOTHER NAME, and that is deliberate: `working`,
 * `done` and `dead_end` already exist as the single owner of how a verdict feels, and
 * listing verdicts here would be a second copy free to disagree the next time one is added.
 * `downloading` is a SPLIT inside `working` on one predicate -- is a release actually coming
 * down -- rather than a fifth vocabulary.
 *
 * `removed` is the ONE bucket keyed on a verdict, and it is a deliberate exception rather than
 * the start of a list. It is `done` in tone -- stop waiting, nothing further will happen -- but
 * filing it under "Arrived" would tell somebody a film they can no longer watch is there. No
 * tone can separate those two, because the tone is about what the reader should DO and in both
 * cases the answer is "nothing"; the difference is what they HAVE. See `bucketOf`.
 */
const BUCKET_ORDER = ["downloading", "waiting", "arrived", "failed", "removed"] as const;

export type RequestBucket = (typeof BUCKET_ORDER)[number];

/**
 * What each bucket is called on screen.
 *
 * The reading order is `BUCKET_ORDER` and not this object's key order: a `Record` that
 * happened to be iterated would be an ordering nobody declared, one reformat away from
 * putting "Needs attention" first. The type is derived from the array, so a bucket added to
 * one and not the other is a compile error rather than a heading that never draws.
 */
export const BUCKET_LABEL: Record<RequestBucket, string> = {
  downloading: "Downloading",
  waiting: "Waiting",
  arrived: "Arrived",
  failed: "Needs attention",
  removed: "Removed",
};

/** One bucket with its rows. Empty buckets are dropped, so a heading always has rows under it. */
export interface RequestGroup {
  bucket: RequestBucket;
  rows: MediaRequest[];
}

/**
 * Which bucket one request belongs in.
 *
 * A row with NO verdict lands in `waiting`, which is the honest reading: the server sends
 * null when it cannot say anything about a request, and "we have not got an answer yet" is
 * waiting rather than failure. It is not a state a `/requests` row reaches today -- every
 * row there has a stored request behind it -- but the type allows it and a silent `undefined`
 * bucket would drop the row off the page entirely.
 */
function bucketOf(request: MediaRequest): RequestBucket {
  if (!request.requestVerdict) return "waiting";
  // BEFORE the tone, and it is the only verdict named in this file. `removed` is `done` --
  // there is nothing left to wait for -- but "Arrived" over a film that has been deleted is
  // the page telling somebody they have something they do not. See `BUCKET_ORDER`.
  if (request.requestVerdict === "removed") return "removed";
  const tone = VERDICT_COPY[request.requestVerdict].tone;
  if (tone === "done") return "arrived";
  if (tone === "dead_end") return "failed";
  // The one split this file makes for itself: a release is either coming down or it is not,
  // and a reader watching a bar wants those apart. `requestProgress` is non-null exactly
  // while the arr has something in its queue for this title.
  return request.requestProgress === null ? "waiting" : "downloading";
}

/**
 * The list partitioned into its four states, in the order a reader cares about them.
 *
 * ONE PASS AND ONE PREDICATE, rather than a `.filter()` per bucket in the route: four filters
 * over one array is four chances to disagree about where a verdict lands, and the fourth is
 * always the one that gets the new state added to it last. Pure and beside the two orderings
 * for the same reason they are here -- these are decisions about DATA, and a test for them
 * should not have to render anything.
 *
 * ORDER WITHIN A BUCKET IS THE CALLER'S and is preserved. `/requests` hands rows that have
 * already been through `newsFirst`, so a newly-arrived title stays at the top of `Arrived`.
 *
 * An EMPTY bucket is dropped rather than returned with no rows. A heading over nothing is the
 * page claiming a state it is not in -- "Needs attention (0)" reads as a warning at a glance,
 * and the whole point of the grouping is that a glance is enough.
 */
export function groupByState(requests: readonly MediaRequest[]): RequestGroup[] {
  const byBucket = new Map<RequestBucket, MediaRequest[]>();
  for (const request of requests) {
    const bucket = bucketOf(request);
    const rows = byBucket.get(bucket);
    if (rows) rows.push(request);
    else byBucket.set(bucket, [request]);
  }

  return BUCKET_ORDER.map((bucket) => ({ bucket, rows: byBucket.get(bucket) ?? [] })).filter(
    (group) => group.rows.length > 0,
  );
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
