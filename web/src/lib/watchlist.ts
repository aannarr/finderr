/**
 * The reader's own watchlist, held once for the whole session.
 *
 * ONE module rather than a hook per screen, because three surfaces ask two different
 * questions of the same answer: `/watchlist` draws the cards, and every title card and the
 * title page ask only "is this one of mine". A per-component fetch would mean one request
 * per card; a boolean threaded through props would mean the grid re-deriving a fact the
 * server already sent. So the list is loaded once, kept here, and read through
 * `useSyncExternalStore` -- the same shape `subscribeTitleState` in `./api.ts` already uses
 * to let a badge update without every view holding its own copy of the row.
 *
 * > [!IMPORTANT] SAVING DOWNLOADS NOTHING
 * > Every call here writes one row on the server and stops. Request is still the only thing
 * > in this product that reaches an arr, and the two controls sit side by side on a card
 * > precisely so the difference is visible rather than explained.
 *
 * THE MUTATIONS ARE OPTIMISTIC AND ROLL BACK. A save has to feel instant -- it is a note to
 * yourself, not a transaction -- but a failed one must not leave the button lying about
 * where the title is, so the previous snapshot is restored and the error is re-thrown for
 * the caller to raise as a toast.
 */

import { useSyncExternalStore } from "react";
import type { Title } from "./api";

/** What the caller has saved, by id. A NEW Set on every change; the same one in between. */
let ids: ReadonlySet<string> = new Set();

/**
 * The saved titles as cards, newest save first, or `null` before the first load.
 *
 * Null is a state and not an empty list: "we have not asked yet" and "you have saved
 * nothing" render differently, and a page that could not tell them apart would flash its
 * empty-list copy at every reader on every visit.
 */
let titles: Title[] | null = null;

let inFlight: Promise<Title[]> | null = null;

/**
 * Bumped by every LOCAL change, so an in-flight load can tell whether it is still describing
 * the present.
 *
 * The race it settles is small and real: the shell starts the load on mount, and a reader who
 * saves something before it answers would have that save overwritten by a response computed
 * before the row existed -- leaving the button saying "not saved" for the rest of the session
 * about a title the server has. A load that comes back into a changed world publishes nothing
 * and leaves `titles` null, so the next reader of the list fetches the truth instead.
 */
let generation = 0;

const listeners = new Set<() => void>();

function publish(next: { ids: ReadonlySet<string>; titles: Title[] | null }): void {
  ids = next.ids;
  titles = next.titles;
  for (const fn of listeners) fn();
}

/** Publish a local change and mark every in-flight load as describing the past. */
function mutate(next: { ids: ReadonlySet<string>; titles: Title[] | null }): void {
  generation++;
  publish(next);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fetch the list once per session, and hand every concurrent caller the same promise.
 *
 * The dedupe matters more here than it looks: the shell loads this on mount at the same
 * moment a grid of sixty cards is mounting, and every one of them wants the answer.
 *
 * A FAILURE IS SWALLOWED INTO AN EMPTY LIST, which is the one place this module is
 * deliberately quiet. Not being able to read your watchlist is not something a reader who
 * came here to search can act on, and the alternative -- an error banner over the front page
 * because a side feature did not load -- is worse than a save button that offers to save
 * something already saved.
 */
export function loadWatchlist(): Promise<Title[]> {
  if (titles !== null) return Promise.resolve(titles);
  // Captured by the FIRST caller, which is the one whose request is actually running.
  const startedAt = generation;
  const current = () => generation === startedAt;
  inFlight ??= fetchWatchlist()
    .then((loaded) => {
      if (current()) publish({ ids: new Set(loaded.map((t) => t.tconst)), titles: loaded });
      return loaded;
    })
    .catch(() => {
      if (current()) publish({ ids: new Set(), titles: [] });
      return [] as Title[];
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function fetchWatchlist(): Promise<Title[]> {
  const res = await fetch("/api/watchlist");
  if (!res.ok) throw new Error(`watchlist failed: ${res.status}`);
  return ((await res.json()) as { titles: Title[] }).titles;
}

/**
 * Put a title on the list, now, and undo it if the server disagrees.
 *
 * It takes the whole `Title` rather than an id so the list can be kept in step without a
 * refetch: the card the reader just saved is the card `/watchlist` has to draw, and it is
 * already in their hand. Newest first, matching the server's own ordering -- the two would
 * otherwise disagree until the next reload, which is exactly the drift that makes an
 * optimistic update feel broken.
 */
export async function saveTitle(title: Title): Promise<void> {
  if (ids.has(title.tconst)) return;
  const before = { ids, titles };
  mutate({
    ids: new Set([...ids, title.tconst]),
    titles: titles ? [title, ...titles] : null,
  });
  try {
    await send("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tconst: title.tconst }),
    });
  } catch (err) {
    mutate(before);
    throw err;
  }
}

/** Take a title off the list, now, and put it back if the server disagrees. */
export async function unsaveTitle(tconst: string): Promise<void> {
  if (!ids.has(tconst)) return;
  const before = { ids, titles };
  const next = new Set(ids);
  next.delete(tconst);
  mutate({ ids: next, titles: titles?.filter((t) => t.tconst !== tconst) ?? null });
  try {
    await send(`/api/watchlist/${tconst}`, { method: "DELETE" });
  } catch (err) {
    mutate(before);
    throw err;
  }
}

/**
 * One write, with the server's own sentence surfaced on a refusal.
 *
 * Shared by both mutations because their whole boundary is this. It mirrors
 * `postRequestGrain` in `./api.ts` deliberately: a reader who is signed out gets "sign in to
 * keep a watchlist" from the server rather than a status code invented here.
 */
async function send(path: string, init: RequestInit): Promise<void> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `watchlist write failed: ${res.status}`);
}

/**
 * Is this title on the caller's list?
 *
 * Subscribed rather than passed down, so a save on the title page repaints the same film's
 * card in the related row behind it without either component knowing about the other.
 *
 * `false` is the SERVER snapshot -- the tests render these components to static markup, where
 * `useSyncExternalStore` demands a third argument, and "not saved" is the honest answer for a
 * render that never ran a fetch.
 */
export function useIsSaved(tconst: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ids.has(tconst),
    () => false,
  );
}

/** The whole list as cards, or `null` until the first load has answered. */
export function useWatchlist(): Title[] | null {
  return useSyncExternalStore(
    subscribe,
    () => titles,
    () => null,
  );
}

/**
 * Forget everything held here.
 *
 * Exported for the tests, which share one module instance across files, and for nothing
 * else: a session that signs out reloads the page, which is a stronger reset than this.
 */
export function resetWatchlist(): void {
  inFlight = null;
  mutate({ ids: new Set(), titles: null });
}
