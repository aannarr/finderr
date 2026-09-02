/// <reference lib="webworker" />

/**
 * finderr's service worker: the EFFECTS half.
 *
 * Every decision about what happens to a given request is in `./lib/sw-policy.ts`, which is
 * a pure function with its own tests. This file does the four things that need a real
 * worker -- precache the offline page, retire old caches, run a plan, and keep a bucket
 * from growing without limit -- and holds no policy of its own.
 *
 * > [!IMPORTANT] IT IS AN ES MODULE, registered with `{ type: "module" }`
 * > That is what lets the policy live in another file instead of being pasted in here. It
 * > needs Safari 16.4, Chrome 91 or Firefox 111; an older browser rejects the registration,
 * > `main.tsx` swallows the rejection, and finderr works exactly as it did before this file
 * > existed. Offline is the feature that is missing, not the app.
 *
 * > [!CAUTION] `skipWaiting` + `clients.claim` -- the update story, which the card called
 * > out as the real risk
 * > A worker that will not update is worse than no worker: it pins a stale app on a device
 * > with no way for the reader to know or fix it. Two things make that impossible here.
 * > First, HTML is NEVER stored, so the shell is a live request on every load and a new
 * > release lands the moment the network is up. Second, this worker takes over immediately
 * > rather than waiting for every tab to close, so a fixed worker ships on the next load
 * > too. The cost of claiming early is that an already-open page may start being served by
 * > a newer worker mid-session -- harmless here, because the only things it serves from
 * > disk are content-hashed URLs and images, and the asset bucket deliberately holds
 * > several releases' worth of chunks so an old page can still load a lazy one.
 */

import { planFor, type SwCache } from "./lib/sw-policy";

declare const self: ServiceWorkerGlobalScope;

/**
 * Bumped when the SHAPE of what is stored changes, never per release.
 *
 * Per-release cache names would be wrong twice over: every asset URL already carries a
 * content hash so two releases cannot collide, and dropping the old bucket on activate is
 * exactly how an open page loses the chunk it is about to lazy-load.
 */
const CACHE_VERSION = "v1";
const CACHE_PREFIX = "finderr-";
const cacheName = (bucket: SwCache | "offline") => `${CACHE_PREFIX}${bucket}-${CACHE_VERSION}`;

/**
 * The one page this worker can produce with no network at all.
 *
 * In its own bucket rather than in `static`, so that trimming -- which evicts the oldest
 * entry when a bucket is full -- can never be the thing that deletes the offline page and
 * turns an offline load into a browser error screen.
 */
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName("offline"));
      // `cache: "reload"` bypasses the HTTP cache. Without it an install triggered by a
      // release can store the copy the browser already had, which is the version this
      // release is replacing.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([
        cacheName("assets"),
        cacheName("images"),
        cacheName("static"),
        cacheName("offline"),
      ]);
      // Only ever OUR caches: the prefix test is what stops this deleting a bucket some
      // other worker on the same origin owns. There is no other worker today, and a rule
      // that quietly assumes so is the kind that surprises somebody later.
      const stale = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX) && !keep.has(n));
      await Promise.all(stale.map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const plan = planFor({
    url: new URL(event.request.url),
    scope: new URL(self.registration.scope),
    method: event.request.method,
    isNavigation: event.request.mode === "navigate",
  });

  // Not calling `respondWith` at all is not the same as responding with `fetch(request)`:
  // it hands the request back to the browser untouched, which keeps every header, redirect
  // and credential rule exactly as it would have been without a worker installed. That is
  // what "passthrough" has to mean for a route the policy declined to handle.
  if (plan.kind === "passthrough") return;

  if (plan.kind === "network-first") {
    event.respondWith(navigateOrOffline(event.request));
    return;
  }

  event.respondWith(
    plan.kind === "cache-first"
      ? cacheFirst(event.request, plan.cache, plan.maxEntries)
      : revalidate(event.request, plan.cache, plan.maxEntries),
  );
});

/**
 * A document request. The network decides; the offline page is the consolation.
 *
 * The response is deliberately never stored -- see the `network-first` note in
 * `./lib/sw-policy.ts` for why caching a shell whose content depends on a cookie is the one
 * thing this worker must not do.
 */
async function navigateOrOffline(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(OFFLINE_URL, { cacheName: cacheName("offline") });
    // The fallback for a browser that somehow has this worker without the precache: a
    // plain 503 rather than a thrown error, so the tab shows a status instead of a crash.
    return cached ?? new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

/** Immutable URLs: the cache is the answer, and the network only fills a gap. */
async function cacheFirst(request: Request, bucket: SwCache, maxEntries: number): Promise<Response> {
  const cache = await caches.open(cacheName(bucket));
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  await store(cache, request, response, maxEntries);
  return response;
}

/** Unhashed static files: answer now, correct in the background. */
async function revalidate(request: Request, bucket: SwCache, maxEntries: number): Promise<Response> {
  const cache = await caches.open(cacheName(bucket));
  const hit = await cache.match(request);

  const fresh = fetch(request)
    .then(async (response) => {
      await store(cache, request, response, maxEntries);
      return response;
    })
    // A failed background refresh is not an error anybody can act on: the cached copy is
    // already on its way to the page. Swallowed here so it does not surface as an unhandled
    // rejection in a context nobody is watching.
    .catch(() => undefined);

  if (hit) return hit;
  const response = await fresh;
  // Only reachable with an empty cache AND a dead network, which for a static file is the
  // same situation the offline page exists for -- but this is a subresource, so a 503 is
  // the honest answer rather than a page.
  return response ?? new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
}

/**
 * Store a response, then bring the bucket back under its cap.
 *
 * > [!WARNING] Only a 200 is stored, and `response.type` must not be `opaque`
 * > An error page cached against an asset URL is a permanent 404 for that URL -- the whole
 * > point of `cache-first` is that it stops asking. Opaque responses (a no-cors
 * > cross-origin fetch) are excluded because their size cannot be read, so a handful of
 * > them can blow the origin's storage quota and get every bucket evicted at once.
 */
async function store(cache: Cache, request: Request, response: Response, maxEntries: number): Promise<void> {
  if (!response.ok || response.type === "opaque") return;
  await cache.put(request, response.clone());
  await trim(cache, maxEntries);
}

/**
 * Evict oldest-first until the bucket fits.
 *
 * `cache.keys()` returns insertion order, which makes this FIFO rather than LRU: a poster
 * on screen every day is dropped on the same schedule as one seen once. Deliberate -- true
 * LRU needs a read to be a write, and a poster that is evicted while still wanted costs one
 * request the browser's own HTTP cache probably answers anyway.
 */
async function trim(cache: Cache, maxEntries: number): Promise<void> {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
}
