/**
 * Identity: the vocabulary and the pure rules.
 *
 * Everything in this file is a value or a function of values -- no SQLite, no fetch, no
 * HTTP. The storage half is `./auth-store.ts`, the ceremonies are `./webauthn.ts` and
 * `./plex-auth.ts`, and the routes are `../server/auth-routes.ts`. Keeping the rules here
 * is what lets them be tested without a database or a browser.
 *
 * > [!IMPORTANT] A SECRET IS NEVER STORED, ONLY ITS HASH
 * > Session ids and invite tokens are bearer secrets: whoever holds one IS the user. So
 * > the database holds `sha256(token)` and the token itself exists only in the cookie or
 * > the invite link. A leaked backup, a stray `select *` in a log, or the board card
 * > somebody pastes a row into then contains nothing anybody can sign in with.
 *
 * The tokens are 32 random bytes. That is the same width as the session cookie in the
 * two shipped passkey implementations, and it is what makes "guess a row" the attack
 * rather than "break a MAC" -- there is no signature to forge because there is no
 * signature at all.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * What a user may do. Two values, deliberately.
 *
 * `admin` is not "power user": it is the set of people who may see WHO REQUESTED WHAT,
 * mint invites, and revoke somebody else's access. aannarr, 2026-08-31 -- request
 * attribution must not leak to an ordinary user, so the role is a privacy boundary
 * before it is a capability one. `visibleRequestFields` is where that is enforced.
 */
export type Role = "admin" | "user";

export const ROLES: readonly Role[] = ["admin", "user"];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export interface User {
  id: string;
  displayName: string;
  role: Role;
  /** Plex account id, when this user has linked one. Null is the ordinary case. */
  plexId: string | null;
  plexUsername: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** Set means "this account cannot sign in". The row survives so attribution does. */
  disabledAt: string | null;
}

export interface Credential {
  id: string;
  userId: string;
  /**
   * base64url of the COSE public key. TEXT, and never a BLOB.
   *
   * A COSE key round-tripped through SQLite as a BLOB comes back as something
   * `@simplewebauthn` refuses, AND THE FAILURE SURFACES AT VERIFY TIME -- so registration
   * looks like it worked and login is broken for a credential the user cannot re-create.
   * Learned in `portal2`, copied into `menu-maker`, and now into here.
   */
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: string | null;
  backedUp: boolean;
  /** What the user called this device. Free text, shown only to its owner. */
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Invite {
  /** sha256 of the token. The token itself is in the link and nowhere else. */
  tokenHash: string;
  role: Role;
  note: string | null;
  /** Prefills the display name on the sign-up form. Not a username; nothing keys on it. */
  displayName: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
}

export interface Session {
  idHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
}

/**
 * One person's ONE agent key.
 *
 * `userId` is the primary key, so "one key per user" is the schema rather than a check
 * somebody has to remember. Rotating is therefore an upsert: the new hash overwrites the
 * old one in a single statement, which is what makes the old token dead the instant the
 * new one exists -- no window where both work, and no way to end up with an orphan second
 * key nobody knows about.
 */
export interface AgentKey {
  userId: string;
  /** sha256 of the token. The token itself exists only in the snippet shown once. */
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  /**
   * Read-only means GET and HEAD, and nothing else.
   *
   * The cost of one key per user is that this is a TOGGLE rather than a choice per token:
   * a user cannot hold a read-only monitoring key and a write key at once. If that ever
   * bites, the fix is a second key KIND, never a collection.
   */
  readOnly: boolean;
}

/** Who is making this request, and how we know. */
export interface Principal {
  /**
   * How this caller was identified.
   *
   * `dev` is the development-only login (`auth.noAuth`), and it is a distinct kind rather
   * than a forged `session` so that anything inspecting a principal can tell a real sign-in
   * from a bypassed one. It still carries a real `user`, so every consumer that only cares
   * about WHO is calling needs no branch for it.
   *
   * `agent` is the same shape for the same reason: it carries the real owner, so every
   * consumer that only asks WHO is calling needs no branch -- and the things that DO differ
   * (no admin authority, a bucket of its own, a blocking title read) can ask for the kind.
   */
  kind: "session" | "api-key" | "dev" | "agent";
  /** Null for the system API key -- it is not a person and owns no requests. */
  user: User | null;
  /**
   * What this CALLER may do, which is not always what its owner may do.
   *
   * > [!CAUTION] An `agent` principal is always `user`, whatever role its owner holds
   * > A leaked admin agent key mints invites, changes roles and deletes accounts; a leaked
   * > ordinary one asks for films. The blast radius difference is enormous and the
   * > convenience gain is nil, because nothing an agent key is for is an admin operation.
   * > Everything downstream that branches on the role -- `visibleRequest`, `arrLink`,
   * > `adminPrincipal`, the per-request arr overrides, the daily quota -- inherits that from
   * > this one field rather than each carrying a check of its own.
   */
  role: Role;
  session?: Session;
  /** Set only for `kind: "agent"`. What that one key may do, beyond who it belongs to. */
  agent?: { readOnly: boolean };
}

// --- secrets ---------------------------------------------------------------

/**
 * A fresh bearer secret: 32 random bytes, base64url.
 *
 * `crypto.getRandomValues` rather than anything seeded, and no dependency: this is the
 * one place in the product where a predictable value is an account takeover.
 */
export function newToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

/** Base64url with no padding -- the alphabet WebAuthn and every token here speak. */
export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** What goes in the database when the caller holds the token. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/**
 * Compare two secrets without leaking where they differ.
 *
 * `a === b` returns as soon as a byte disagrees, so it leaks the length and then the
 * first differing byte -- a real attack against a token an attacker can retry as fast as
 * the network allows. The length check here is unavoidable (`timingSafeEqual` throws on a
 * mismatch) and is not a leak worth caring about: our tokens are all one width, so a
 * wrong-length candidate was never going to be right.
 */
export function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// --- time ------------------------------------------------------------------

export function isoNow(now: Date = new Date()): string {
  return now.toISOString();
}

export function isoIn(ms: number, now: Date = new Date()): string {
  return new Date(now.getTime() + ms).toISOString();
}

/** ISO strings compare correctly as strings, which is why every column here is TEXT. */
export function isExpired(expiresAt: string, now: Date = new Date()): boolean {
  return expiresAt <= isoNow(now);
}

// --- what a caller is allowed to see ---------------------------------------

/**
 * Strip every field an ordinary user may not see from a request row.
 *
 * > [!CAUTION] `requestedBy` is an ADMIN-ONLY fact and this is the only place that knows it
 * > aannarr, 2026-08-31: only admins know and can SEE who requested what, and the fact must
 * > not leak to a normal user. The temptation is to hide it in the component that draws
 * > the row -- which leaves it sitting in the JSON, one devtools tab away from every user
 * > on the system. Attribution is stripped on the SERVER, in one function, and a test
 * > pins it.
 *
 * **`root_folder_path` is stripped for the same reason and it is not merely tidiness.** It
 * is an absolute path on the server's filesystem, which is the same class of fact as a
 * hostname: not a credential, and not something an ordinary user should be handed either.
 * `quality_profile_id` and `search_on_add` go with it because all three are one decision an
 * admin made, and a row that shows two thirds of it invites somebody to add the third back.
 *
 * **`via_agent_key` is audit metadata beside `requested_by`, so it is stripped WITH it.**
 * It says HOW a request arrived; the row still says WHO asked, and an agent key does not
 * create a second requester. Splitting the two audiences -- who may see the person, who may
 * see the mechanism -- would be a second privacy rule with a second owner.
 *
 * It returns a new object rather than deleting in place, so a caller cannot accidentally
 * hand the same row to two audiences and have the second one mutated.
 */
export function visibleRequest<
  T extends {
    requested_by?: string | null;
    quality_profile_id?: number | null;
    root_folder_path?: string | null;
    search_on_add?: number | null;
    via_agent_key?: number | null;
  },
>(
  row: T,
  role: Role | null,
): Omit<T, "requested_by" | "quality_profile_id" | "root_folder_path" | "search_on_add" | "via_agent_key"> &
  Partial<
    Pick<T, "requested_by" | "quality_profile_id" | "root_folder_path" | "search_on_add" | "via_agent_key">
  > {
  // Destructured out by NAME rather than deleted from a copy: a spread that forgets one
  // field is exactly how this leaks, and the compiler can see this shape.
  const { requested_by, quality_profile_id, root_folder_path, search_on_add, via_agent_key, ...rest } = row;
  if (role !== "admin") return rest;
  return {
    ...rest,
    requested_by: (requested_by ?? null) as T["requested_by"],
    quality_profile_id: (quality_profile_id ?? null) as T["quality_profile_id"],
    root_folder_path: (root_folder_path ?? null) as T["root_folder_path"],
    search_on_add: (search_on_add ?? null) as T["search_on_add"],
    via_agent_key: (via_agent_key ?? null) as T["via_agent_key"],
  };
}

/** The public shape of a user. Same rule: nothing here is a secret, so nothing leaks. */
export function publicUser(u: User): {
  id: string;
  displayName: string;
  role: Role;
  plexUsername: string | null;
  plexConnected: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  disabled: boolean;
} {
  return {
    id: u.id,
    displayName: u.displayName,
    role: u.role,
    plexUsername: u.plexUsername,
    /*
      Whether a Plex account is attached, as its own field.

      `plexUsername !== null` is NOT the same question and would be wrong: `linkPlex` stores
      whatever Plex returned, and Plex does not promise a username. A linked account with no
      username would render as "not connected" beside a Connect button that then 409s.

      The plex ID itself stays out. It is Plex's identifier for a person, this shape is
      handed to admins listing users as well as to the owner, and nothing in the UI can do
      anything with it -- so the boolean is the whole of what a caller needs.
    */
    plexConnected: u.plexId !== null,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
    disabled: u.disabledAt !== null,
  };
}

// --- origins and return destinations ---------------------------------------

/**
 * The origin to hand a third party, or to write into a tag somebody else will store.
 *
 * Chosen from the CONFIGURED origins by matching the request's own host, never taken from
 * the request. An origin built out of a header is an open redirect with extra steps, and
 * both callers hand the result to somebody outside: Plex bounces a browser to it, and an
 * Open Graph tag is fetched by a crawler and then cached by Slack or Twitter for as long
 * as they feel like. A wrong value there is not a transient bug.
 *
 * Falls back to the first configured origin, which is what an unrecognised host deserves.
 */
export function publicOrigin(reqUrl: string, origins: readonly string[]): string {
  const host = new URL(reqUrl).host;
  const match = origins.find((o) => {
    try {
      return new URL(o).host === host;
    } catch {
      return false;
    }
  });
  return match ?? origins[0] ?? "";
}

/**
 * A caller-supplied place to go after signing in, or `null` if it is not one of ours.
 *
 * > [!CAUTION] This is an open-redirect guard and the rejections are the whole point
 * > It accepts a PATH and never a URL, because every URL-shaped thing is a way out of this
 * > origin. `//evil.example` is the one that catches people: it has no scheme, it starts
 * > with a slash, it passes a naive `startsWith("/")` check, and a browser reads it as
 * > protocol-relative and leaves. `\\evil.example` is the same trick for the browsers that
 * > normalise a backslash, and a control character can smuggle either past a regex that
 * > was written without `\n` in mind.
 *
 * Anything rejected becomes `null` and the caller sends the user to `/`, which is never
 * wrong -- only less helpful.
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length > 512) return null;
  if (!value.startsWith("/")) return null;
  // Protocol-relative, in both spellings a browser accepts.
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  // No scheme, no control characters, no whitespace, no fragment games.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\x00-\x20\x7f<>"'\\]/.test(value)) return null;
  return value;
}

// --- cookies ---------------------------------------------------------------

export const SESSION_COOKIE = "fdr_sid";

/**
 * Build the `Set-Cookie` for a session.
 *
 * **`SameSite=Lax`, never `Strict`.** An invite link arrives by message or email and is
 * followed cross-site; `Strict` drops the cookie on that first navigation, so somebody who
 * has just registered appears logged out. `Lax` still blocks the cross-site POST that CSRF
 * needs.
 *
 * **`Secure` is a parameter, not a constant, and that is a real tradeoff.** A browser
 * DISCARDS a `Secure` cookie sent over plain http, so hard-coding it would make finderr
 * unusable on a plain-http LAN address, which is where it typically runs. It is derived from
 * the configured origins (see `config.ts`), so the day the app is served over https the
 * flag turns itself on rather than being remembered.
 */
export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(opts: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Pull one cookie out of a `Cookie` header.
 *
 * Hand-parsed because the header is trivial and the alternative is a dependency in the
 * hardened runtime image. `Bun.CookieMap` exists and is tempting, but it wants a full
 * request-scoped map and this reads one name.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim() || null;
  }
  return null;
}
