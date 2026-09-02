/**
 * Turning notifications on and off, from the browser's side.
 *
 * Three things have to line up before a message can arrive, and they fail in three
 * different ways, so this module reports WHICH rather than a boolean: the browser has to
 * support push at all, the reader has to grant permission, and the server has to be willing
 * to send. A control that says "notifications are unavailable" for all three is a control
 * nobody can act on.
 *
 * > [!IMPORTANT] ON iOS THERE IS A FOURTH, AND IT IS NOT A SETTING
 * > Safari serves the Push API only to a web app the reader has ADDED TO THEIR HOME SCREEN,
 * > over HTTPS. In a normal Safari tab `window.PushManager` does not exist and no permission
 * > prompt can be reached. So on iOS the honest answer for a tab is "install it first",
 * > which is what `pushSupport` returns rather than pretending the browser is too old.
 */

import { serviceWorker } from "./sw-register";

/** Why push is or is not available here. One of these is on screen at any moment. */
export type PushSupport =
  /** Everything lines up. `enable()` will ask for permission if it does not have it. */
  | { kind: "available"; publicKey: string }
  /** iOS in a browser tab: the API is genuinely absent until the app is installed. */
  | { kind: "install-first" }
  /** This browser has no Push API and installing will not conjure one. */
  | { kind: "unsupported" }
  /** The reader said no. Only the OS or browser settings can undo it, never this app. */
  | { kind: "denied" }
  /** The server is not offering push. `config.push.enabled`. */
  | { kind: "server-off" };

interface PushKeyResponse {
  enabled: boolean;
  publicKey: string | null;
}

/**
 * Is this device running finderr as an installed app?
 *
 * `display-mode: standalone` covers every engine; `navigator.standalone` is the older
 * iOS-only flag, still the one Safari sets for a home-screen app. Both are checked because
 * neither covers the case alone on the platform that matters most here.
 */
export function isInstalledApp(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * What can be offered on this device right now.
 *
 * Asks the server LAST, so a browser that could never subscribe costs no request. The
 * answer is not cached: permission can be revoked in OS settings while the app is open, and
 * a control drawn from a stale reading is a button that does nothing.
 */
export async function pushSupport(): Promise<PushSupport> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // The distinction that matters on aannarr's own devices: an iPhone or iPad in a Safari
    // tab is not an old browser, it is an uninstalled app.
    return isIosLike() && !isInstalledApp() ? { kind: "install-first" } : { kind: "unsupported" };
  }
  if (Notification.permission === "denied") return { kind: "denied" };

  const res = await fetch("/api/push/key");
  if (!res.ok) return { kind: "server-off" };
  const { enabled, publicKey } = (await res.json()) as PushKeyResponse;
  if (!enabled || !publicKey) return { kind: "server-off" };
  return { kind: "available", publicKey };
}

/** Is this an Apple mobile engine? Used only to explain WHY push is missing, never to gate a feature. */
function isIosLike(): boolean {
  // iPadOS reports itself as a Mac, and the touch-point count is the one property that
  // still separates the two. A wrong answer here changes a sentence, not a behaviour.
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Is this browser already subscribed? Null when there is no worker to ask. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await serviceWorker();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Ask for permission, subscribe, and tell the server.
 *
 * Returns false for the one outcome the caller has to render differently: the reader
 * declined. Everything else that can go wrong throws, because it is a fault rather than an
 * answer and the caller shows it.
 */
export async function enablePush(publicKey: string): Promise<boolean> {
  const registration = await serviceWorker();
  if (!registration) throw new Error("this browser has no service worker to subscribe with");

  /*
    THE PROMPT MUST FOLLOW A CLICK, which is why this function exists rather than a
    `useEffect` somewhere.

    Asking on page load is the pattern browsers have spent years penalising: Chrome and
    Firefox both suppress a permission prompt that is not tied to a gesture, and a reader
    who dismisses one may never be offered it again on that origin. One button, one ask.
  */
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const subscription = await registration.pushManager.subscribe({
    // REQUIRED, and not merely a hint: every engine refuses a subscription without it, and
    // it is the promise the push handler in `sw.ts` keeps by always showing a notification.
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `toJSON()` produces exactly `{ endpoint, keys: { p256dh, auth } }`, which is the shape
    // the route reads. Building it by hand would be a second definition of a shape the
    // platform already defines.
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) {
    // The browser is subscribed and the server does not know, which would leave a device
    // that believes notifications are on and never receives one. Undo it rather than
    // leaving the two out of step.
    await subscription.unsubscribe().catch(() => undefined);
    throw new Error(`the server refused the subscription (${res.status})`);
  }
  return true;
}

/**
 * Stop notifications on this device.
 *
 * BOTH HALVES, and the server is told FIRST. Unsubscribing locally first would leave the
 * endpoint in the database with no way to reach the browser that owned it, so it would only
 * be cleaned up the next time something was sent to it and the push service said 410.
 */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);
  await subscription.unsubscribe();
}
