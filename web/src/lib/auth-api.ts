/**
 * The client half of identity.
 *
 * Imported by BOTH bundles -- the pre-auth sign-in page and the app itself -- because
 * "sign in" and "add a second device" are the same ceremony seen from two places. Keep it
 * dependency-light for that reason: everything the sign-in page pulls in is code an
 * anonymous visitor downloads.
 */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export type Role = "admin" | "user";

export interface PublicUser {
  id: string;
  displayName: string;
  role: Role;
  plexUsername: string | null;
  /**
   * Is a Plex account attached?
   *
   * Its own field rather than `plexUsername !== null`, because Plex does not promise a
   * username -- a linked account with none would otherwise render as "not connected" beside
   * a Connect button that then refuses with a 409.
   */
  plexConnected: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  disabled: boolean;
  /**
   * This person's own daily title limit, or null to follow the site's.
   *
   * The EFFECTIVE limit is `QuotaState.limitPerDay`; this is the override that produced it,
   * and the two are separate fields because only their difference tells "5 because we said
   * so" from "5 because the site says so". Null is the ordinary case.
   */
  quotaPerDay: number | null;
  /** May they use the assistant? An admin's decision, per person, on `/admin/users/:id`. */
  assistantAllowed: boolean;
}

export interface AuthState {
  authenticated: boolean;
  user?: PublicUser;
  /** Whether to draw the Plex button at all. The server decides; the client never guesses. */
  plex?: boolean;
  /**
   * This server has no accounts, so whoever is reading may create the first one and it
   * will be the admin.
   *
   * Present only while that is true -- the server omits it rather than sending `false`, so
   * an ordinary sign-in page discloses nothing new. Which means the client must test it as
   * a truthy value and never as `=== false`.
   */
  setup?: boolean;
}

/**
 * Can this browser do WebAuthn AT ALL from here?
 *
 * > [!IMPORTANT] `isSecureContext` is the check, not feature detection
 * > `navigator.credentials` exists over plain http and then REFUSES, with an error the
 * > user reads as "it is broken". finderr typically runs on a plain-http LAN address, which
 * > is not a secure context, so on the LAN the honest answer is to hide the passkey path
 * > and explain -- not to offer a button that cannot work. `localhost` is the one http
 * > origin browsers exempt, which is why development still works.
 */
export function passkeysAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential === "function"
  );
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as { error?: string };
  // The server's message is deliberately generic for anything an anonymous caller can
  // provoke; it is shown verbatim because inventing a friendlier one here would be a
  // second, less accurate owner of what went wrong.
  if (!res.ok) throw new Error(parsed.error ?? `that did not work (${res.status})`);
  return parsed as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const parsed = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `request failed (${res.status})`);
  return parsed as T;
}

/**
 * A DELETE that raises the server's own refusal, so a caller can render it.
 *
 * `fallback` is what a reader is told when the server sent no message at all -- a proxy
 * error page, or a network the request never left. It is per-caller because "that account
 * could not be removed" and "that key could not be revoked" are different sentences, and a
 * generic one would be the least useful thing on screen at the moment it matters.
 */
async function del(path: string, fallback = "that did not work"): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

export function getAuthState(): Promise<AuthState> {
  return get<AuthState>("/api/auth/state");
}

/** `{ ok: false }` for expired, redeemed and never-existed alike -- one answer, on purpose. */
export async function checkInvite(token: string): Promise<{ ok: boolean; displayName?: string | null }> {
  const res = await fetch(`/api/auth/invite?token=${encodeURIComponent(token)}`);
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; displayName?: string | null };
}

/**
 * Sign in with a passkey.
 *
 * No username is collected or sent: the credential is discoverable, so the authenticator
 * offers whatever it holds for this site and the server identifies the account from the
 * credential itself.
 */
export async function loginWithPasskey(): Promise<PublicUser | null> {
  const begin = await post<{ handle: string; options: unknown }>("/api/auth/passkey/login/begin");
  const response = await startAuthentication({ optionsJSON: begin.options as never });
  const done = await post<{ user: PublicUser | null }>("/api/auth/passkey/login/finish", {
    handle: begin.handle,
    response,
  });
  return done.user;
}

/**
 * Create an account from an invite, or add another device to the account you are in.
 *
 * The distinction is `token`: with one, this is a sign-up; without one it requires a live
 * session and adds a credential to it. Nothing else changes, which is why it is one
 * function rather than two.
 */
export async function registerPasskey(opts: {
  token?: string;
  displayName?: string;
  label?: string;
}): Promise<PublicUser | null> {
  const begin = await post<{ handle: string; options: unknown }>("/api/auth/passkey/register/begin", {
    token: opts.token,
    displayName: opts.displayName,
  });
  const response = await startRegistration({ optionsJSON: begin.options as never });
  const done = await post<{ user: PublicUser | null }>("/api/auth/passkey/register/finish", {
    handle: begin.handle,
    response,
    label: opts.label,
  });
  return done.user;
}

/**
 * `next` is where to land AFTER the round trip through plex.tv.
 *
 * It has to go through the server: the browser leaves this origin entirely and comes back
 * to whatever `forwardUrl` Plex was given, so a destination held only in this tab is gone
 * by then. The server validates it before embedding it (`safeReturnPath`), and the login
 * screen validates it again on arrival -- neither end trusts the other with an open
 * redirect.
 */
export function plexBegin(token?: string, next?: string): Promise<{ pinId: string; authUrl: string }> {
  return post("/api/auth/plex/begin", { ...(token ? { token } : {}), ...(next ? { next } : {}) });
}

/** `{ pending: true }` while the user is still on plex.tv. The caller polls. */
export function plexFinish(pinId: string): Promise<{ pending?: boolean; user?: PublicUser }> {
  return post("/api/auth/plex/finish", { pinId });
}

export function logout(): Promise<{ ok: boolean }> {
  return post("/api/auth/logout");
}

export interface CredentialSummary {
  id: string;
  label: string | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}

export function getMe(): Promise<{
  user: PublicUser;
  credentials: CredentialSummary[];
  sessions: SessionSummary[];
}> {
  return get("/api/auth/me");
}

export async function deleteCredential(id: string): Promise<void> {
  const res = await fetch(`/api/auth/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "could not remove that passkey");
  }
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error("could not end that session");
}

/**
 * Name a passkey. `null` clears the name back to the device type.
 *
 * `registerPasskey` guesses a label from the user agent, and a guess is exactly the kind of
 * thing that needs correcting: two rows both reading "Mac" are two rows nobody can revoke
 * with any confidence.
 */
export async function renameCredential(id: string, label: string | null): Promise<void> {
  const res = await fetch(`/api/auth/credentials/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "could not rename that passkey");
  }
}

/**
 * Start attaching a Plex account to the account you are already signed in to.
 *
 * A DIFFERENT ceremony from `plexBegin`, which is the public sign-in one -- see the routes.
 * This one carries no invite token, because there is no account to create.
 */
export function plexLinkBegin(): Promise<{ pinId: string; authUrl: string }> {
  return post("/api/auth/plex/link/begin");
}

/** `{ pending: true }` while the user is still on plex.tv. The caller polls. */
export function plexLinkFinish(
  pinId: string,
): Promise<{ pending?: boolean; ok?: boolean; plexUsername?: string | null }> {
  return post("/api/auth/plex/link/finish", { pinId });
}

/** Refused with a 409 when Plex is your only way back in. That message is shown verbatim. */
export async function unlinkPlex(): Promise<void> {
  const res = await fetch("/api/auth/plex", { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "could not disconnect Plex");
  }
}

// --- agent key ---------------------------------------------------------------

/**
 * Your ONE agent key, as the account page sees it. Never the token: only the sha256 is
 * stored, so the plaintext exists exactly once, in the snippet returned at creation.
 */
export interface AgentKeySummary {
  createdAt: string;
  lastUsedAt: string | null;
  readOnly: boolean;
}

const AGENT_KEY_PATH = "/api/auth/agent-key";

export function getAgentKey(): Promise<{ key: AgentKeySummary | null }> {
  return get(AGENT_KEY_PATH);
}

/**
 * Create the key, or REPLACE the one you have -- the same call, because there is one key
 * per user and the row is overwritten. `rotated` says which of the two just happened, so
 * the UI can tell somebody their previous key has stopped working.
 *
 * `snippet` is the deliverable: a copyable block that points an agent at the manifest and
 * carries the credential. It is built on the server so the origin comes from the live
 * request rather than from a constant that is wrong on one of the addresses this app
 * answers on.
 */
export function createAgentKey(opts: {
  readOnly: boolean;
}): Promise<{ token: string; snippet: string; rotated: boolean; key: AgentKeySummary }> {
  return post(AGENT_KEY_PATH, opts);
}

export async function revokeAgentKey(): Promise<void> {
  await del(AGENT_KEY_PATH, "could not revoke that key");
}

// --- admin -----------------------------------------------------------------

export interface AdminUser extends PublicUser {
  credentials: number;
  sessions: number;
  /** Titles asked for in the last seven UTC days, today included. */
  requestsThisWeek: number;
}

export interface AdminInvite {
  /** The token's HASH. A live token is shown exactly once, at the moment it is minted. */
  id: string;
  role: Role;
  note: string | null;
  displayName: string | null;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
}

export function listUsers(): Promise<{ users: AdminUser[] }> {
  return get("/api/admin/users");
}

export function listInvites(): Promise<{ invites: AdminInvite[] }> {
  return get("/api/admin/invites");
}

export function createInvite(opts: {
  role: Role;
  displayName?: string;
  note?: string;
  hours?: number;
}): Promise<{ token: string; url: string; expiresAt: string }> {
  return post("/api/admin/invites", opts);
}

export async function revokeInvite(id: string): Promise<void> {
  await del(`/api/admin/invites/${encodeURIComponent(id)}`, "that invite could not be revoked");
}

/**
 * Change what an admin decides about somebody. Every field is optional; an ABSENT one is
 * left alone, which is what makes `quotaPerDay: null` mean "clear the override".
 *
 * `null` and omitting the key are therefore different requests, and `undefined` cannot
 * express the first -- `JSON.stringify` drops it. Callers that want to clear the override
 * must pass an explicit `null`.
 */
export async function patchUser(
  id: string,
  patch: {
    role?: Role;
    disabled?: boolean;
    displayName?: string;
    quotaPerDay?: number | null;
    assistantAllowed?: boolean;
  },
): Promise<void> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "that change was refused");
  }
}

export async function deleteUser(id: string): Promise<void> {
  await del(`/api/admin/users/${encodeURIComponent(id)}`, "that account could not be removed");
}

/**
 * Revoke ONE of somebody's passkeys, or ONE of their open sessions.
 *
 * The narrow instrument, for a lost LAPTOP: `resetUser` below is for a lost account. Both
 * are scoped by the target user on the server, so an id belonging to somebody else answers
 * 404 rather than deleting their row.
 */
export async function revokeUserCredential(userId: string, credentialId: string): Promise<void> {
  await del(`/api/admin/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`);
}

export async function revokeUserSession(userId: string, sessionId: string): Promise<void> {
  await del(`/api/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * Revoke everything and hand back a fresh invite -- the passkey answer to "force a
 * password reset". There is no password to reset, so what a locked-out or compromised
 * account needs is every credential gone and a new way in.
 */
export function resetUser(
  id: string,
): Promise<{ url: string; token: string; revoked: { credentials: number; sessions: number } }> {
  return post(`/api/admin/users/${encodeURIComponent(id)}/reset`);
}

/**
 * A request row as the ADMIN surfaces see it -- the whole log on `/admin`, and one person's
 * own on `/admin/users/:id`.
 *
 * Narrower than `MediaRequest` in `./api.ts` on purpose: this is the raw stored row, so it
 * carries no `requestVerdict` and no progress. Those are derived per reader by `/api/requests`
 * and drawn on `/log`, which is where a reader goes to ask how a request is getting on. What
 * an admin page needs is what was asked for, by whom, and when.
 */
export interface AttributedRequest {
  /** The row's own key. `logOrder` breaks a same-millisecond tie on it. */
  id: number;
  tconst: string;
  title: string;
  year: number | null;
  /** The state machine's own word -- "queued", "downloading", "available". */
  status: string;
  /** Comma-joined season numbers, or null for "all". Series only. */
  seasons: string | null;
  created_at: string;
  updated_at: string;
  requested_by: string | null;
  requestedByName: string | null;
}

/** ADMIN ONLY, and it is a separate route for that reason rather than a filtered field. */
export function adminRequests(): Promise<{ requests: AttributedRequest[] }> {
  return get("/api/admin/requests");
}

/** Where one person stands against the daily request limit. See `src/lib/request-quota.ts`. */
export interface QuotaState {
  /**
   * Titles per UTC day that actually bind THIS person: their own override where they have
   * one, else the site's. Zero or less is unlimited. Resolved by `quotaLimitFor`.
   */
  limitPerDay: number;
  /**
   * What the site would give them, so an editor can offer "follow the site default (N)" as
   * a real choice. Equal to `limitPerDay` exactly when `user.quotaPerDay` is null.
   */
  siteLimitPerDay: number;
  usedToday: number;
  /** ISO instant of the next UTC midnight. */
  resetsAt: string;
  /**
   * Does the limit BIND this person? The server answers it, because the exemptions -- an
   * admin, and a limit of zero -- are the request rule's to own and not a screen's to infer.
   */
  applies: boolean;
}

/**
 * One person, whole: the admin-scoped twin of `getMe`, plus what only an admin may read.
 *
 * READ ONLY. Nothing on this payload is an action, and the page that draws it deliberately
 * offers none -- promoting, disabling, revoking and removing all land together, with their
 * confirmations, rather than one of them arriving early without one.
 */
export interface AdminUserDetail {
  user: PublicUser;
  credentials: CredentialSummary[];
  sessions: SessionSummary[];
  requests: AttributedRequest[];
  quota: QuotaState;
  /** Present or absent -- never the key itself, which exists only in the snippet shown once. */
  agentKey: AgentKeySummary | null;
}

export function getAdminUser(id: string): Promise<AdminUserDetail> {
  return get(`/api/admin/users/${encodeURIComponent(id)}`);
}
