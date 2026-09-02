/**
 * Web push, from the specifications, with no dependency.
 *
 * Three RFCs meet in this file and each one owns a piece of the request that goes out:
 *
 *   - RFC 8291 (Message Encryption) -- the BODY. A push service is an untrusted relay, so
 *     the payload is encrypted end to end with a key only the subscribing browser holds.
 *     Nothing in this file can read what it sends once it has sent it.
 *   - RFC 8188 (aes128gcm) -- the framing of that body: salt, record size, the sender's
 *     public key, then one AEAD record.
 *   - RFC 8292 (VAPID) -- the `Authorization` header. It identifies THIS SERVER to the push
 *     service so a stolen endpoint URL cannot be used by anybody else to push to that
 *     browser.
 *
 * > [!IMPORTANT] WHY IT IS WRITTEN HERE RATHER THAN INSTALLED
 * > The `web-push` package is the obvious answer and it is a Node library with a
 * > transitive tree, for about a hundred lines of WebCrypto that Bun ships natively. The
 * > whole of it is `encryptPayload` and `vapidHeader` below, both of which are pinned by a
 * > round-trip test that decrypts this module's own output with a browser-shaped key --
 * > which is a stronger check than "the dependency is popular".
 *
 * > [!CAUTION] EVERY LENGTH AND EVERY LABEL BELOW IS FROM A SPEC, NOT A CHOICE
 * > A wrong byte does not fail here. It fails inside a browser's push handler on somebody
 * > else's phone, silently, with the push service having returned 201. The constants carry
 * > their section numbers for that reason.
 */

import { Buffer } from "node:buffer";

/** What a browser hands us when it subscribes, in the shape `PushSubscription.toJSON()` uses. */
export interface PushSubscriptionKeys {
  /** The subscriber's public key, base64url, uncompressed P-256 point (65 bytes). */
  p256dh: string;
  /** The subscriber's authentication secret, base64url, 16 bytes. */
  auth: string;
}

export interface PushTarget extends PushSubscriptionKeys {
  /** Where to POST. Opaque, and chosen by the browser's push service. */
  endpoint: string;
}

/** The server's identity to a push service. One pair for the whole instance. */
export interface VapidKeys {
  /** base64url, uncompressed P-256 point. Also what the browser subscribes with. */
  publicKey: string;
  /** base64url of the raw P-256 scalar (`d`). Never leaves this process. */
  privateKey: string;
}

/**
 * RFC 8188 §2.1. The record size, which bounds one AEAD record.
 *
 * 4096 rather than the 4078-byte minimum: notifications here are a title and a sentence,
 * so a single record is never close to full and the number only has to be large enough
 * that padding never forces a second one.
 */
const RECORD_SIZE = 4096;

/** RFC 8291 §3.3. The label that binds a derivation to web push and to these two parties. */
const WEB_PUSH_INFO = "WebPush: info\0";

/** RFC 8188 §2.2. The two content-encoding labels, byte for byte. */
const CEK_INFO = "Content-Encoding: aes128gcm\0";
const NONCE_INFO = "Content-Encoding: nonce\0";

/** An uncompressed P-256 point is 1 + 32 + 32. Both parties' keys are this length. */
const P256_POINT_BYTES = 65;

/**
 * Bytes backed by a plain `ArrayBuffer`, which is what WebCrypto's `BufferSource` demands.
 *
 * A bare `Uint8Array` is `Uint8Array<ArrayBufferLike>` -- it might be a view on a
 * `SharedArrayBuffer`, which `crypto.subtle` refuses -- and `.slice()` and `Buffer.from()`
 * both produce that wider type. Naming the narrow one is what keeps every helper below
 * composable without a cast at each call, and a cast is the wrong tool here: the guarantee
 * is real and the compiler can carry it.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const b64url = {
  encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url"),
  decode: (text: string): Bytes => new Uint8Array(Buffer.from(text, "base64url")),
};

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

/** One HMAC-SHA-256. Every key derivation below is a stack of these. */
async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/**
 * HKDF, expanded to exactly one block.
 *
 * Both outputs this file needs -- a 16-byte key and a 12-byte nonce -- are shorter than
 * SHA-256's 32, so the expand step never loops. Writing the general form would be more code
 * and one more thing to get wrong for an iteration that cannot happen.
 */
async function hkdfOneBlock(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return new Uint8Array(okm.subarray(0, length));
}

/**
 * Mint a VAPID key pair.
 *
 * > [!CAUTION] The pair is the identity every existing subscription was created against
 * > A browser stores `applicationServerKey` with the subscription and the push service
 * > checks the signature against it, so replacing these keys does not "rotate" anything --
 * > it invalidates every subscription in one step, and each affected browser has to
 * > subscribe again. The caller is expected to generate once and keep them.
 */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  // The JWK's `d` is the raw scalar in base64url already, which is exactly the storage
  // form -- exporting pkcs8 would mean re-parsing DER to get back to the same 32 bytes.
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d) throw new Error("generated VAPID key has no private scalar");
  return { publicKey: b64url.encode(publicKey), privateKey: jwk.d };
}

/**
 * The private half, back into something WebCrypto will sign with.
 *
 * The public point is carried alongside because a JWK private key needs `x` and `y` too:
 * WebCrypto will not import a bare scalar, and re-deriving the point would mean doing
 * P-256 arithmetic by hand.
 */
async function importVapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const point = b64url.decode(keys.publicKey);
  if (point.length !== P256_POINT_BYTES) throw new Error("VAPID public key is not a P-256 point");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      // Byte 0 is the 0x04 "uncompressed" tag; x and y are the two halves after it.
      x: b64url.encode(point.slice(1, 33)),
      y: b64url.encode(point.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * RFC 8292 §2. The `Authorization` header value for one push service.
 *
 * `aud` is the push service's ORIGIN, not the endpoint -- one token is valid for every
 * endpoint that service hosts, and including the path would make the token a tracking
 * identifier for one subscriber.
 *
 * `sub` is how the push service reaches the operator about abuse. It is configuration
 * rather than a constant here for exactly that reason: it is a claim about a deployment,
 * and this repo is somebody else's deployment.
 */
export async function vapidHeader(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  now: () => number = Date.now,
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: new URL(endpoint).origin,
    // Twelve hours. The spec caps a token at 24; half of that leaves room for a clock that
    // disagrees with the push service's without ever minting one it will call expired.
    exp: Math.floor(now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };

  const signingInput = utf8(
    `${b64url.encode(utf8(JSON.stringify(header)))}.${b64url.encode(utf8(JSON.stringify(claims)))}`,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await importVapidPrivateKey(keys),
      signingInput,
    ),
  );
  // WebCrypto returns the raw r||s pair, which is precisely what JWS ES256 wants -- a DER
  // signature here would be rejected by every push service.
  const jwt = `${new TextDecoder().decode(signingInput)}.${b64url.encode(signature)}`;
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/**
 * RFC 8291 §3 and RFC 8188 §2. One encrypted record, ready to be the request body.
 *
 * The shape that comes out:
 *
 *     salt (16) | record size (4, big endian) | key id length (1) | our public key (65) | AEAD
 *
 * Only the subscribing browser can undo it: the key is derived from an ECDH shared secret
 * plus the 16-byte `auth` secret that never leaves that browser except in the subscription
 * it handed us.
 */
export async function encryptPayload(
  keys: PushSubscriptionKeys,
  plaintext: string,
  /** Injected so the round-trip test can pin an exact known-answer. Random in production. */
  salt: Bytes = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Bytes> {
  const uaPublic = b64url.decode(keys.p256dh);
  const authSecret = b64url.decode(keys.auth);
  if (uaPublic.length !== P256_POINT_BYTES) throw new Error("subscription key is not a P-256 point");

  // A FRESH PAIR PER MESSAGE, and it must be: the salt and this key are the only inputs
  // that vary, so reusing one across messages reuses the (key, nonce) pair for AES-GCM,
  // which is the one thing that breaks the mode outright.
  const ours = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ours.publicKey));

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          uaPublic,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      ours.privateKey,
      256,
    ),
  );

  /*
    RFC 8291 §3.3 -- the input keying material.

    The `auth` secret is the SALT of this first extraction and the ECDH output is the
    material, which is the step that binds the derivation to a browser rather than to
    whoever happens to hold the endpoint URL. The info string then commits to both public
    keys, so a shared secret cannot be replayed between two different pairs of parties.
  */
  const ikm = await hkdfOneBlock(authSecret, shared, concat(utf8(WEB_PUSH_INFO), uaPublic, asPublic), 32);

  const cek = await hkdfOneBlock(salt, ikm, utf8(CEK_INFO), 16);
  const nonce = await hkdfOneBlock(salt, ikm, utf8(NONCE_INFO), 12);

  // RFC 8188 §2: the last record of a payload ends with the delimiter 0x02. A single
  // record is always the last one, so it is always 0x02 here and never 0x01.
  const padded = concat(utf8(plaintext), new Uint8Array([2]));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]),
      padded,
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, sealed);
}

/** What a push service said, reduced to the only three answers a caller can act on. */
export type PushOutcome =
  /** Accepted for delivery. Not a promise that anybody saw it. */
  | { kind: "sent" }
  /**
   * The subscription is dead -- 404 or 410. THE CALLER MUST DELETE IT.
   *
   * A push service returns this for a browser that has unsubscribed, been uninstalled or
   * had its storage cleared, and it is permanent. Retrying it forever is how a table of
   * subscriptions becomes a table of ghosts.
   */
  | { kind: "gone" }
  /** Anything else: a bad request, a rate limit, a service that is down. Safe to retry. */
  | { kind: "failed"; status: number; detail: string };

/**
 * Deliver one notification to one subscription.
 *
 * It never throws. Every outcome a caller can do something about is in the return type,
 * and the two they cannot -- a DNS failure, a socket reset -- are reported as `failed` with
 * a status of 0, because "the push service did not answer" and "the push service said no"
 * call for the same response: leave the subscription alone and try again later.
 */
export async function sendPush(
  keys: VapidKeys,
  subject: string,
  target: PushTarget,
  payload: string,
  opts: { ttlSeconds?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<PushOutcome> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const body = await encryptPayload(target, payload);
    const res = await doFetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(keys, target.endpoint, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // How long the service holds it for a device that is offline. Four hours: a
        // notification that a film arrived is still worth reading after a night's sleep,
        // and is not worth reading a week later.
        TTL: String(opts.ttlSeconds ?? 4 * 60 * 60),
      },
      body: body as unknown as BodyInit,
    });

    if (res.ok) return { kind: "sent" };
    if (res.status === 404 || res.status === 410) return { kind: "gone" };
    return { kind: "failed", status: res.status, detail: await safeBody(res) };
  } catch (err) {
    return { kind: "failed", status: 0, detail: (err as Error).message };
  }
}

/** A push service's error text, bounded -- it is written to a log line, not to a page. */
async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
