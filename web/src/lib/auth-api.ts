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
}

export interface AuthState {
  authenticated: boolean;
  user?: PublicUser;
  /** Whether to draw the Plex button at all. The server decides; the client never guesses. */
  plex?: boolean;
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

export function plexBegin(token?: string): Promise<{ pinId: string; authUrl: string }> {
  return post("/api/auth/plex/begin", token ? { token } : {});
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

// --- admin -----------------------------------------------------------------

export interface AdminUser extends PublicUser {
  credentials: number;
  sessions: number;
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
  await fetch(`/api/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function patchUser(
  id: string,
  patch: { role?: Role; disabled?: boolean; displayName?: string },
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
  const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "that account could not be removed");
  }
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

export interface AttributedRequest {
  tconst: string;
  title: string;
  status: string;
  updated_at: string;
  requested_by: string | null;
  requestedByName: string | null;
}

/** ADMIN ONLY, and it is a separate route for that reason rather than a filtered field. */
export function adminRequests(): Promise<{ requests: AttributedRequest[] }> {
  return get("/api/admin/requests");
}
