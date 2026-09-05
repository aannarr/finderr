import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { AuthStore, applyAuthSchema } from "../lib/auth-store";
import type { MediaRequest, Store } from "../lib/store";
import { PushNotifier } from "./push";

/**
 * The POLICY around a notification, with no push service and no network.
 *
 * `src/lib/web-push.test.ts` proves the bytes are right by decrypting them. This file is
 * about the decisions on top: who gets told, how many messages one arrival produces, and
 * what happens to a subscription the push service says is dead. Everything here is checked
 * through a fake `fetch`, because the alternative is a test that only passes while Google
 * is up.
 */

/** Just enough `Store` for the notifier: `kv`, which is where the VAPID pair lives. */
function fakeStore(): Store {
  const kv = new Map<string, string>();
  return {
    getKv: (key: string) => kv.get(key) ?? null,
    setKv: (key: string, value: string) => void kv.set(key, value),
  } as unknown as Store;
}

function openAuth(): AuthStore {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  return new AuthStore(db);
}

/** A `request` row, only the fields `announceArrival` reads. */
function arrival(over: Partial<MediaRequest> = {}): MediaRequest {
  return {
    tconst: "tt1375666",
    title: "Inception",
    year: 2010,
    service: "radarr",
    requested_by: "ana",
    ...over,
  } as MediaRequest;
}

let auth: AuthStore;
let store: Store;
let calls: { url: string; body: Uint8Array }[];
let respond: (url: string) => Response;

function notifier(over: { enabled?: boolean } = {}) {
  return new PushNotifier({
    store,
    authStore: auth,
    enabled: over.enabled ?? true,
    contact: "mailto:ops@example.com",
    log: () => {},
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: init.body as Uint8Array });
      return respond(String(url));
    }) as unknown as typeof fetch,
  });
}

/** Subscribe one browser, with real P-256 material so the encryption actually runs. */
async function subscribe(userId: string, endpoint: string): Promise<void> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  auth.putPushSubscription({
    endpoint,
    userId,
    p256dh: Buffer.from(raw).toString("base64url"),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
  });
}

beforeEach(() => {
  auth = openAuth();
  store = fakeStore();
  calls = [];
  respond = () => new Response(null, { status: 201 });
  auth.createUser({ id: "ana", displayName: "Ana", role: "user" });
  auth.createUser({ id: "ben", displayName: "Ben", role: "user" });
});

describe("who gets told", () => {
  test("one message per subscribed device, and only the asker's", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    await subscribe("ana", "https://push.example/ana-ipad");
    await subscribe("ben", "https://push.example/ben-phone");

    expect(await notifier().announceArrival(arrival())).toBe(2);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://push.example/ana-ipad",
      "https://push.example/ana-phone",
    ]);
  });

  /**
   * The rule that makes this bearable rather than infuriating. A `request` row is one title
   * however many seasons or episodes it became, so a season pack finishing is ONE
   * notification. There is no queue or debounce here because the batching is a property of
   * what a request IS, not something this file arranges.
   */
  test("a series arriving is one message, not one per episode", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    const series = arrival({ tconst: "tt0944947", title: "Game of Thrones", service: "sonarr" });
    expect(await notifier().announceArrival(series)).toBe(1);
    expect(calls).toHaveLength(1);
  });

  /** A request the system made on its own behalf, or one from before there were accounts. */
  test("a request with no owner tells nobody", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    expect(await notifier().announceArrival(arrival({ requested_by: null }))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("somebody who never turned notifications on costs no request", async () => {
    expect(await notifier().announceArrival(arrival())).toBe(0);
    expect(calls).toHaveLength(0);
    // ...and no VAPID pair was minted for a message that was never going to be sent.
    expect(store.getKv("vapid_keys")).toBeNull();
  });

  test("push switched off on the server sends nothing", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    expect(await notifier({ enabled: false }).announceArrival(arrival())).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("the VAPID pair", () => {
  test("it is generated once and reused for every later message", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    const push = notifier();
    const first = await push.publicKey();
    await push.announceArrival(arrival());
    expect(await push.publicKey()).toBe(first);
    // Reused across instances too -- it is the identity every subscription was made
    // against, so a restart that minted a new one would silently break every device.
    expect(await notifier().publicKey()).toBe(first);
  });

  /**
   * Two callers arriving together on a fresh database -- an HTTP handler asking for the
   * public key while the reconcile timer sends a notification -- must not each mint a pair
   * and race to write it. Half the subscriptions in existence would then have been made
   * against a key this server no longer holds, with nothing anywhere reporting it.
   */
  test("concurrent callers share one pair", async () => {
    const push = notifier();
    const [a, b, c] = await Promise.all([push.publicKey(), push.publicKey(), push.publicKey()]);
    expect(a).toBe(b as string);
    expect(b).toBe(c as string);
  });

  test("push switched off has no public key to hand out", async () => {
    expect(await notifier({ enabled: false }).publicKey()).toBeNull();
  });
});

describe("what happens to a failed delivery", () => {
  /**
   * 404 and 410 are the push service saying the browser is gone for good, and they are the
   * ONLY signal that ever says so. Without this the phone somebody reset in March is
   * retried on every arrival forever and the table only grows.
   */
  test("a gone endpoint is deleted", async () => {
    await subscribe("ana", "https://push.example/dead");
    await subscribe("ana", "https://push.example/live");
    respond = (url) => new Response(null, { status: url.endsWith("dead") ? 410 : 201 });

    expect(await notifier().announceArrival(arrival())).toBe(1);
    expect(auth.listPushSubscriptions("ana").map((s) => s.endpoint)).toEqual(["https://push.example/live"]);
  });

  /**
   * A push service having a bad minute is not a reason to forget a device. The next arrival
   * is the next attempt -- a message about a film that landed an hour ago does not earn a
   * retry schedule.
   */
  test("a retryable failure keeps the subscription", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    respond = () => new Response("slow down", { status: 429 });

    expect(await notifier().announceArrival(arrival())).toBe(0);
    expect(auth.listPushSubscriptions("ana")).toHaveLength(1);
  });

  /**
   * It is called from the reconcile timer, where a throw would abandon the pass that is
   * updating everybody else's requests.
   */
  test("a dead network is reported as zero delivered, never thrown", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    respond = () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await notifier().announceArrival(arrival())).toBe(0);
  });
});

describe("the message", () => {
  test("a successful send stamps the device, so a stale row is visible", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    await notifier().announceArrival(arrival());
    expect(auth.listPushSubscriptions("ana")[0]?.last_sent_at).not.toBeNull();
  });

  /**
   * The body is ENCRYPTED -- this server cannot read it back once it is built, which is the
   * whole point of RFC 8291. So what is checked here is that a body was built at all and is
   * the right shape; that it decrypts to the right text is `web-push.test.ts`'s job.
   */
  test("the body is an aes128gcm record rather than the plaintext", async () => {
    await subscribe("ana", "https://push.example/ana-phone");
    await notifier().announceArrival(arrival());
    const body = calls[0]?.body as Uint8Array;
    // 16 salt + 4 record size + 1 key length + 65 key, then the sealed record.
    expect(body.length).toBeGreaterThan(86);
    expect(body[20]).toBe(65);
    expect(new TextDecoder().decode(body)).not.toContain("Inception");
  });
});
