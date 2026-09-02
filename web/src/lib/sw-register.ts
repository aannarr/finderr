/**
 * Installing the service worker, and holding the one registration everything else needs.
 *
 * Two callers with two different reasons: `main.tsx` calls this at boot to get the worker
 * installed, and anything that needs the registration itself -- web push subscribes through
 * it -- calls the same function later and gets the same promise rather than racing to
 * register a second time.
 */

/**
 * Memoised, and that is the point of the module.
 *
 * `register()` is idempotent in the browser, but the PROMISE is not: two callers awaiting
 * two separate registrations is two chances to act on a half-installed worker. One promise,
 * created on first ask, resolved once.
 */
let pending: Promise<ServiceWorkerRegistration | null> | undefined;

/**
 * The worker's URL, and it is unhashed on purpose.
 *
 * A service worker's URL is its IDENTITY -- the browser compares byte-for-byte against the
 * script it already has at that address to decide whether an update exists. A hashed name
 * would register a brand new worker on every release and leave the old one alive, so
 * `vite.config.ts` names this entry explicitly. The two must agree.
 */
const SW_URL = "/sw.js";

/**
 * Register the worker if this browser will have it, and hand back the registration.
 *
 * Resolves to `null` rather than rejecting for every reason it can fail, because every one
 * of them is "finderr works, offline does not": no `serviceWorker` on `navigator` (any
 * insecure context, which includes the plain-http LAN address), a browser that refuses a
 * module worker (below Safari 16.4 / Chrome 91 / Firefox 111), or a registration the
 * browser declined. A caller can act on `null`; nobody can act on a thrown error here.
 */
export function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  pending ??= register();
  return pending;
}

async function register(): Promise<ServiceWorkerRegistration | null> {
  /*
    NOT IN DEV, and this is a deliberate hole in the coverage.

    `web/src/sw.ts` is a BUILD entry -- there is no `/sw.js` on the vite dev server, so a
    registration there would 404. Worse, a worker that did install would sit in front of the
    dev server caching hashed URLs that change on every save, which is the classic "why is
    my edit not showing up" afternoon. The worker is exercised against a real build; that is
    the trade.
  */
  if (!import.meta.env.PROD) return null;
  if (!("serviceWorker" in navigator)) return null;

  try {
    return await navigator.serviceWorker.register(SW_URL, { type: "module", scope: "/" });
  } catch {
    return null;
  }
}
