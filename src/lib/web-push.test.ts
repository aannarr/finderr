import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  type Bytes,
  encryptPayload,
  generateVapidKeys,
  type PushTarget,
  sendPush,
  vapidHeader,
} from "./web-push";

/**
 * THE POINT OF THIS FILE: the encryption is checked by DECRYPTING IT, the way a browser
 * would.
 *
 * A wrong constant in `web-push.ts` does not fail there. The push service returns 201, the
 * request looks perfect from this side, and the failure happens inside somebody else's
 * phone where nothing reports it. Asserting that our own output is well-formed would repeat
 * whatever mistake produced it, so the test below plays the SUBSCRIBER instead: it mints a
 * P-256 key pair, hands the public half over as a subscription, and then derives the same
 * content key from the private half and opens the record. If any label, length or ordering
 * in the module is wrong, this cannot possibly pass.
 */

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

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

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  return new Uint8Array((await hmac(prk, concat(info, new Uint8Array([1])))).subarray(0, length));
}

/** A browser: a P-256 pair plus the 16-byte auth secret it keeps to itself. */
async function subscriber() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: b64url(publicRaw), auth: b64url(authSecret) },
    publicRaw,
    authSecret,
    privateKey: pair.privateKey,
  };
}

/**
 * The receiving half of RFC 8291 + RFC 8188, written from the specs rather than from
 * `web-push.ts` -- otherwise a shared mistake would cancel itself out.
 */
async function decrypt(ua: Awaited<ReturnType<typeof subscriber>>, body: Bytes): Promise<string> {
  const salt = new Uint8Array(body.subarray(0, 16));
  const idLength = body[20];
  expect(idLength).toBe(65);
  const asPublic = new Uint8Array(body.subarray(21, 21 + 65));
  const sealed = new Uint8Array(body.subarray(21 + 65));

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          asPublic,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      ua.privateKey,
      256,
    ),
  );

  const ikm = await hkdf(ua.authSecret, shared, concat(utf8("WebPush: info\0"), ua.publicRaw, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const opened = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
      sealed,
    ),
  );
  // The trailing byte is RFC 8188's record delimiter, not payload.
  expect(opened[opened.length - 1]).toBe(2);
  return new TextDecoder().decode(opened.slice(0, -1));
}

describe("payload encryption", () => {
  test("a browser holding the subscription can read it back", async () => {
    const ua = await subscriber();
    const message = JSON.stringify({ title: "Alien", body: "Alien is ready to watch" });
    const body = await encryptPayload(ua.keys, message);
    expect(await decrypt(ua, body)).toBe(message);
  });

  test("the record header is the shape RFC 8188 describes", async () => {
    const ua = await subscriber();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptPayload(ua.keys, "hello", salt);

    expect([...body.slice(0, 16)]).toEqual([...salt]);
    // Bytes 16-19 are the record size, big endian.
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);
    // 16 + 4 + 1 + 65 of header, the plaintext, its delimiter byte, and a 16-byte tag.
    expect(body.length).toBe(86 + "hello".length + 1 + 16);
  });

  /**
   * The ephemeral pair and the salt are the only inputs that vary, and reusing either
   * across two messages would reuse an AES-GCM (key, nonce) pair -- the one mistake that
   * breaks the mode outright rather than weakening it.
   */
  test("two messages with the same text produce different bytes", async () => {
    const ua = await subscriber();
    const a = await encryptPayload(ua.keys, "same");
    const b = await encryptPayload(ua.keys, "same");
    expect(b64url(a)).not.toBe(b64url(b));
    // ...and both still decrypt, so the difference is nonce material rather than damage.
    expect(await decrypt(ua, a)).toBe("same");
    expect(await decrypt(ua, b)).toBe("same");
  });

  test("a subscription key that is not a P-256 point is refused", async () => {
    await expect(encryptPayload({ p256dh: b64url(new Uint8Array(32)), auth: "AAAA" }, "x")).rejects.toThrow(
      /P-256 point/,
    );
  });
});

describe("the VAPID header", () => {
  test("it carries a verifiable ES256 token and the public key", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidHeader(keys, "https://push.example.com/send/abc123", "mailto:ops@example.com");

    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, jwt, publicKey] = match as RegExpExecArray;
    expect(publicKey).toBe(keys.publicKey);

    const [head, claims, signature] = (jwt as string).split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });

    const parsed = JSON.parse(Buffer.from(claims, "base64url").toString());
    // The ORIGIN, never the endpoint: one token is valid for every endpoint that service
    // hosts, and a path would make the token an identifier for one subscriber.
    expect(parsed.aud).toBe("https://push.example.com");
    expect(parsed.sub).toBe("mailto:ops@example.com");
    expect(parsed.exp).toBeGreaterThan(Date.now() / 1000);
    // The spec caps a token at 24 hours and a push service will reject a longer one.
    expect(parsed.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 60 * 60);

    // The push service verifies this against `k`. A DER-encoded signature, or the wrong
    // signing input, would be accepted by nothing -- so it is verified here for real.
    const point = new Uint8Array(Buffer.from(keys.publicKey, "base64url"));
    const verifyKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(point.slice(1, 33)).toString("base64url"),
        y: Buffer.from(point.slice(33, 65)).toString("base64url"),
        ext: true,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      new Uint8Array(Buffer.from(signature, "base64url")),
      utf8(`${head}.${claims}`),
    );
    expect(ok).toBe(true);
  });
});

describe("sendPush", () => {
  const target: PushTarget = {
    endpoint: "https://push.example.com/send/abc123",
    p256dh: "",
    auth: "",
  };

  async function withSubscriber(): Promise<PushTarget> {
    const ua = await subscriber();
    return { ...target, ...ua.keys };
  }

  test("a 201 is 'sent', and the request carries the aes128gcm framing", async () => {
    let seen: Request | undefined;
    const outcome = await sendPush(
      await generateVapidKeys(),
      "mailto:ops@example.com",
      await withSubscriber(),
      "hello",
      {
        fetch: (async (url: string, init: RequestInit) => {
          seen = new Request(url, init);
          return new Response(null, { status: 201 });
        }) as unknown as typeof fetch,
      },
    );

    expect(outcome).toEqual({ kind: "sent" });
    expect(seen?.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(seen?.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(seen?.headers.get("Authorization")).toStartWith("vapid t=");
    expect(seen?.headers.get("TTL")).toBe(String(4 * 60 * 60));
  });

  /**
   * 404 and 410 are the push service saying the browser is gone for good -- unsubscribed,
   * uninstalled, storage cleared. The caller DELETES the row. Reporting them as ordinary
   * failures is how a subscription table fills up with ghosts that are retried forever.
   */
  test("404 and 410 are 'gone', and every other refusal is retryable", async () => {
    const keys = await generateVapidKeys();
    const to = await withSubscriber();
    const respond = (status: number) => ({
      fetch: (async () => new Response("nope", { status })) as unknown as typeof fetch,
    });

    expect(await sendPush(keys, "mailto:a@b.c", to, "x", respond(404))).toEqual({ kind: "gone" });
    expect(await sendPush(keys, "mailto:a@b.c", to, "x", respond(410))).toEqual({ kind: "gone" });
    expect(await sendPush(keys, "mailto:a@b.c", to, "x", respond(429))).toMatchObject({
      kind: "failed",
      status: 429,
    });
  });

  /**
   * A push service that cannot be reached at all and one that answers 500 call for the
   * same response -- leave the subscription alone and try again -- so a thrown fetch is
   * reported rather than propagated. The reconcile timer that calls this must not be able
   * to die on a DNS failure.
   */
  test("a network failure is reported, never thrown", async () => {
    const outcome = await sendPush(await generateVapidKeys(), "mailto:a@b.c", await withSubscriber(), "x", {
      fetch: (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed", status: 0 });
  });
});
