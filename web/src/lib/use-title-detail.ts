/**
 * The detail page's async policy, in one place.
 *
 * The page never waits. It paints the local row -- poster, title, year, runtime, genres,
 * IMDb score, library state -- and lets facets arrive behind it. Nothing about a slow or
 * dead provider is allowed to be visible as a stall.
 *
 * LATE DATA IS CACHE-ONLY. A provider that misses the server's deadline keeps running
 * and its answer lands in the facet cache regardless, so the next view of the title has
 * it at t=0. There is no push channel: what this hook adds is a SHORT BOUNDED SCHEDULE of
 * deferred re-reads, which turns "reload the page" into "wait a beat" for every case we
 * have measured, without a poll loop and without a new transport. If a pane never
 * appears, the answer is genuinely "open it again", not "the cast is missing".
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type ArrLink,
  cachedTitle,
  type EpisodeState,
  getTitleDetail,
  type PersonLinks,
  type RenderedPane,
  subscribeTitleState,
  type Title,
  type TitleAwards,
  type TitleDetail,
  titleStateVersion,
} from "./api";
import type { FacetName, FacetProblem, ResolvedFacets } from "./facets";

/**
 * How long to wait before asking the server again, growing as the work drags on.
 *
 * The page keeps re-reading while the SERVER says providers are still owed answers, so
 * this table is a CADENCE and not a deadline -- it decides how often to look, never how
 * long to keep looking. The last value repeats for as long as work continues.
 *
 * Front-loaded on measurement rather than taste. Cold titles opened one at a time settled
 * at 417 / 422 / 1240 ms against the live container on 2026-08-31; four opened in quick
 * succession -- an ordinary browse session -- settled at 1363 / 1520 / 1772 / 2027 ms,
 * because `HostPacer` floors calls per host and every title after the first waits its
 * turn. So most answers land inside two seconds and the early polls are the ones that pay.
 * After that the reader has already seen most of the page and a slower cadence costs them
 * nothing.
 *
 * A poll is cheap ON PURPOSE, which is what makes polling the right tool here rather than
 * a transport: `/api/title/:tconst` reads local SQLite only, and its `warm()` joins work
 * already in flight instead of starting a second upstream call. The providers never see it.
 */
export const POLL_CADENCE_MS = [300, 400, 600, 900, 1400, 2000] as const;

/**
 * How many consecutive failed reads before we stop asking.
 *
 * The loop's stop condition is the SERVER saying it has finished, so it needs one other
 * exit for the case where the server is not answering at all. Three, because a single
 * blip must not end a run that is otherwise progressing -- the old one-shot retry ended
 * on the first error and made a transient failure indistinguishable from a provider that
 * had genuinely answered "nothing".
 */
export const POLL_ERROR_BUDGET = 3;

/** How the policy is told what it is looking at. Injected so a test needs no DOM. */
export interface PollPolicy<T> {
  /** Fetch again. Its side effects (painting the new data) are the caller's business. */
  load: () => Promise<T>;
  /** Is the SERVER still working on this? Not "is anything pending" -- see `paneView`. */
  isWorking: (data: T) => boolean;
  /** Advance to the next attempt. The hook backs this with a cancellable timer. */
  sleep: (ms: number) => Promise<void>;
  /** Has this view gone away (unmounted, or the tconst changed)? */
  stopped?: () => boolean;
  cadence?: readonly number[];
  errorBudget?: number;
}

/**
 * Keep reading while the server says it is still working, then stop.
 *
 * The FIRST response is the caller's -- it needs it to paint -- so this takes it as an
 * argument rather than fetching it. Returns once the work is done, the view has gone away,
 * or the server has stopped answering.
 *
 * > [!IMPORTANT] The stop condition is the SERVER's answer, not a clock
 * > This replaced a fixed three-attempt schedule that gave up at 3.3 s whether or not
 * > facets were still landing, which is how `/title/tt1748179` rendered a header with no
 * > synopsis, no cast and no ratings. A timer in the browser is a guess about work
 * > happening somewhere else, and it is wrong in both directions: too short hides a facet
 * > that was about to arrive, too long holds a skeleton over a provider that already died.
 * >
 * > **It cannot poll forever, and that is a property of the server rather than a cap
 * > here.** Every provider either answers or is cancelled at the hard deadline, and the
 * > resolver writes a row for every outcome -- so `working` drains on its own. The only
 * > cap in this function is `errorBudget`, for a server that has stopped replying at all.
 *
 * A THROWN LOAD COSTS ONE ATTEMPT, NOT THE RUN, and the budget RESETS on any success: a
 * blip in the middle of a healthy poll must not count towards giving up.
 */
export async function pollWhileWorking<T>(first: T, policy: PollPolicy<T>): Promise<void> {
  const stopped = policy.stopped ?? (() => false);
  const cadence = policy.cadence ?? POLL_CADENCE_MS;
  const budget = policy.errorBudget ?? POLL_ERROR_BUDGET;
  if (!policy.isWorking(first)) return;

  let errors = 0;
  for (let attempt = 0; ; attempt++) {
    if (stopped()) return;
    // The last value repeats: the cadence decides how OFTEN to look, never how long to
    // keep looking, so running off the end of the table must not end the poll.
    await policy.sleep(cadence[Math.min(attempt, cadence.length - 1)] ?? 0);
    if (stopped()) return;

    try {
      const data = await policy.load();
      if (stopped()) return;
      if (!policy.isWorking(data)) return;
      errors = 0;
    } catch {
      if (++errors >= budget) return;
    }
  }
}

export interface TitleDetailView {
  /** The local half, available before the fetch lands whenever we already held the row. */
  title: Title | null;
  /** Undefined until the first response; panes render skeletons until then. */
  facets: ResolvedFacets | undefined;
  /**
   * Our own person ids for this title's credits, by provider id and by folded name.
   *
   * From the index, not from a provider, so it is not a facet -- and undefined until the
   * detail response lands, which is why a cast name is plain text for one frame before it
   * becomes a link. Either half is empty on an index built before the stage that fills it.
   */
  people: PersonLinks | undefined;
  /** The rest of this title's collection, decorated. Undefined until the response lands. */
  collectionTitles: Title[] | undefined;
  /**
   * Plugin-authored panes, rendered to blocks server-side. Undefined until the response
   * lands, and an empty array whenever no plugin claimed a slot -- which is the ordinary
   * case and draws nothing.
   */
  panes: RenderedPane[] | undefined;
  /** "More like this", decorated. Undefined until the response lands. */
  relatedTitles: Title[] | undefined;
  /**
   * The facets a provider is still genuinely working on -- what `paneView` may skeleton.
   *
   * `undefined` before the first response, which is not the same as the empty array: the
   * first means "we do not know what this title has yet" and every pane reserves its
   * space, the second means "nobody owes this title anything" and a still-`pending` facet
   * is not coming on this view.
   */
  working: FacetName[] | undefined;
  /** Which plugin failed and why, for anything that wants to say so out loud. */
  problems: FacetProblem[];
  /**
   * Where an ADMIN manages this title in Radarr or Sonarr, or null.
   *
   * Null is the server's answer for every non-admin -- the address is never sent -- so an
   * ordinary reader's page has nothing to hide.
   */
  arrLink: ArrLink | null;
  /**
   * Our own Sonarr's per-episode state for this series. Undefined until the response
   * lands, and empty for anything Sonarr does not hold.
   */
  episodeState: EpisodeState[] | undefined;
  /**
   * What the Academy gave this film. `null` for nearly every title, undefined before the
   * response lands -- and the pane draws nothing in either case.
   *
   * There is no third state here, which is the point: awards come from our own imported
   * tables rather than from a provider, so they arrive complete with the first response
   * and never sit `pending`. Nothing about them belongs in the poll.
   */
  awards: TitleAwards | null | undefined;
  error: string | null;
}

export function useTitleDetail(tconst: string): TitleDetailView {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Library and request state are patched into the cache in place, which React cannot
  // see. Without this, requesting a title would not update the button under the cursor.
  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  useEffect(() => {
    let stale = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    setDetail(null);
    setError(null);

    const load = async (): Promise<TitleDetail> => {
      const data = await getTitleDetail(tconst);
      if (!stale) setDetail(data);
      return data;
    };

    // Cancellable, so leaving the page does not hold a timer open for the rest of the
    // schedule. `pollWhileWorking` re-checks `stopped` on the other side of every await.
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        retry = setTimeout(resolve, ms);
      });

    load()
      .then((data) =>
        pollWhileWorking(data, {
          load,
          // The SERVER's count, not our reading of the statuses. A facet whose provider the
          // outbound gate refused is `pending` with nobody working on it, so polling on
          // `hasPendingFacet` would never stop.
          isWorking: (d) => d.work.working > 0,
          sleep,
          stopped: () => stale,
        }),
      )
      .catch((e: Error) => {
        if (stale) return;
        setError(e.message);
      });

    return () => {
      stale = true;
      clearTimeout(retry);
    };
  }, [tconst]);

  // The cache is authoritative for the row: it is what `patchTitleState` rewrites, and
  // it is already populated when the user arrived from a search or a shelf.
  // `people` rides on the detail response rather than the cached row, because the row is
  // shared with search and browse results, which never carry it.
  return {
    title: cachedTitle(tconst) ?? detail ?? null,
    facets: detail?.facets,
    people: detail?.people,
    collectionTitles: detail?.collectionTitles,
    relatedTitles: detail?.relatedTitles,
    panes: detail?.panes,
    working: detail?.work.facets,
    problems: detail?.work.problems ?? [],
    arrLink: detail?.arrLink ?? null,
    episodeState: detail?.episodeState,
    awards: detail?.awards,
    error,
  };
}
