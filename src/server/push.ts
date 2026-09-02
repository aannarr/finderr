/**
 * Telling somebody their request arrived, on the device they asked from.
 *
 * `src/lib/web-push.ts` is the PROTOCOL -- encryption, VAPID, one HTTP call. This is the
 * POLICY: whose keys, which devices, what the message says, and what to do with a
 * subscription the push service says is dead.
 *
 * > [!IMPORTANT] The only legitimate use of `request.requested_by` outside the admin view
 * > That column is admin-only on the way OUT of the API -- `visibleRequest` strips it for
 * > everybody else -- and this does not weaken that. Nothing here sends a name anywhere: it
 * > reads the column to decide who is owed one message about their own request, and the
 * > message goes to that person's own devices and to nowhere else.
 *
 * > [!CAUTION] The message is not a broadcast and must never become one
 * > A notification is sent about ONE request, to the ONE person who asked for it. There is
 * > no path here that would tell a household that somebody else's film arrived, and adding
 * > one would be a disclosure decision rather than a feature.
 */

import type { AuthStore, PushSubscriptionRow } from "../lib/auth-store";
import type { MediaRequest, Store } from "../lib/store";
import { generateVapidKeys, sendPush, type VapidKeys } from "../lib/web-push";

/** Where the instance's VAPID pair is kept. One pair, generated once, for the life of the DB. */
const VAPID_KV_KEY = "vapid_keys";

/**
 * What the service worker receives and turns into a notification.
 *
 * A closed shape rather than free text, because the worker cannot negotiate: a payload it
 * does not understand becomes a blank notification on somebody's lock screen, and there is
 * no way to find out from here that it happened.
 */
export interface PushMessage {
  title: string;
  body: string;
  /** Where clicking it goes, as a path on this origin. */
  url: string;
  /**
   * The notification's replacement key.
   *
   * Two messages sharing a tag REPLACE each other rather than stacking, which is what stops
   * a series arriving season by season from filling a lock screen. Keyed per request.
   */
  tag: string;
}

export interface PushDeps {
  store: Store;
  authStore: AuthStore;
  enabled: boolean;
  /** The VAPID `sub` claim: how a push service reaches this operator. See `config.push`. */
  contact: string;
  log: (...args: unknown[]) => void;
  /** Injected for tests. Production passes nothing and gets the global. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The instance's push identity and its one outbound path.
 *
 * A class rather than functions because the VAPID pair has to be generated at most once and
 * then reused, and "at most once" is state. Everything else here is stateless.
 */
export class PushNotifier {
  /**
   * The in-flight or completed key load.
   *
   * Memoised as a PROMISE, not as a value: `keys()` is reachable from an HTTP handler and
   * from the reconcile timer, and two callers arriving together on a fresh database would
   * otherwise generate two pairs and race to write them -- after which half the
   * subscriptions in existence would have been made against a key this server no longer
   * holds, and no error anywhere would say so.
   */
  private loading: Promise<VapidKeys> | undefined;

  constructor(private readonly deps: PushDeps) {}

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** The public half, for a browser to subscribe with. Null when push is switched off. */
  async publicKey(): Promise<string | null> {
    if (!this.deps.enabled) return null;
    return (await this.keys()).publicKey;
  }

  private keys(): Promise<VapidKeys> {
    this.loading ??= this.loadOrGenerate();
    return this.loading;
  }

  private async loadOrGenerate(): Promise<VapidKeys> {
    const stored = this.deps.store.getKv(VAPID_KV_KEY);
    if (stored) {
      try {
        return JSON.parse(stored) as VapidKeys;
      } catch {
        // Unparseable is the same as absent, and regenerating is the only way forward --
        // but it invalidates every existing subscription, so it is said out loud.
        this.deps.log("push: stored VAPID keys are unreadable; generating a new pair");
      }
    }
    const keys = await generateVapidKeys();
    this.deps.store.setKv(VAPID_KV_KEY, JSON.stringify(keys));
    this.deps.log("push: generated a VAPID key pair");
    return keys;
  }

  /**
   * Tell the person who asked for this title that it has arrived.
   *
   * ONE MESSAGE PER REQUEST, which is the rule that makes this bearable rather than
   * infuriating: a `request` row is one title however many seasons or episodes it became,
   * so a season pack finishing is one notification and not twenty. The batching is not done
   * here -- it is a property of what a request IS -- which is why there is no queue, no
   * debounce and no window in this file.
   *
   * Returns how many devices accepted it, which is 0 for the ordinary case of somebody who
   * has never turned notifications on. Never throws: it is called from the reconcile timer,
   * where an exception would stop the pass that is updating everybody else's requests.
   */
  async announceArrival(request: MediaRequest): Promise<number> {
    if (!this.deps.enabled) return 0;
    // No owner means nobody to tell: a request the system made on its own behalf, or one
    // from before there were accounts.
    if (!request.requested_by) return 0;

    const targets = this.deps.authStore.listPushSubscriptions(request.requested_by);
    // Checked BEFORE `send`, which would otherwise load the VAPID pair -- generating one on
    // a fresh database -- for a person who has never turned notifications on. That is the
    // overwhelming majority of arrivals.
    if (targets.length === 0) return 0;

    const year = request.year === null ? "" : ` (${request.year})`;
    return this.send(targets, {
      title: `${request.title}${year} is ready`,
      body: request.service === "sonarr" ? "The episodes you asked for have arrived." : "Ready to watch.",
      url: `/title/${request.tconst}`,
      tag: `request-${request.tconst}`,
    });
  }

  /**
   * Deliver one message to every device a user has subscribed.
   *
   * Sequential rather than parallel. A household has a handful of devices, the arrival it
   * is reporting took hours, and firing concurrent requests at a push service is how a
   * sender ends up rate limited for a saving nobody could measure.
   */
  private async send(targets: readonly PushSubscriptionRow[], message: PushMessage): Promise<number> {
    const keys = await this.keys();
    const payload = JSON.stringify(message);
    let delivered = 0;

    for (const target of targets) {
      const outcome = await sendPush(keys, this.deps.contact, target, payload, {
        fetch: this.deps.fetch,
      });
      if (outcome.kind === "sent") {
        this.deps.authStore.markPushSent(target.endpoint);
        delivered++;
        continue;
      }
      if (outcome.kind === "gone") {
        /*
          THE ONLY SELF-HEALING THIS TABLE GETS.

          404 and 410 mean the browser is permanently gone -- unsubscribed, uninstalled,
          storage cleared -- and there is no other signal that ever tells us. Without this
          delete, a phone that was reset in March is retried on every arrival forever, and
          the table only grows.
        */
        this.deps.authStore.forgetPushEndpoint(target.endpoint);
        this.deps.log(`push: dropped a subscription the push service says is gone`);
        continue;
      }
      // Retryable, and NOT retried: the next arrival is the next attempt. A message about
      // a film that landed an hour ago is not worth a retry schedule, and a push service
      // that is down stays down for longer than one would cover.
      this.deps.log(`push: delivery failed (${outcome.status}) -- ${outcome.detail}`);
    }
    return delivered;
  }
}
