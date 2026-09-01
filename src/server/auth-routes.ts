/**
 * The HTTP surface of identity, and the guard that closes everything else.
 *
 * Three groups, and the split is the security model:
 *
 * - **Public** (`/api/auth/*`): sign in, redeem an invite. Rate limited per IP, because
 *   these are the only routes an anonymous caller can reach and one of them consumes a
 *   bearer secret.
 * - **Signed in** (`/api/auth/me`, credentials, sessions): manage your own devices.
 * - **Admin** (`/api/admin/*`): mint invites, manage users, see who requested what.
 *   Reachable by an admin's session OR by the system API key, which is how an AGENT does
 *   administration without being a person.
 *
 * > [!IMPORTANT] `withAuth` is what makes the app private, not a check in each handler
 * > aannarr, 2026-08-31: everything is behind the login wall. A per-handler check is a rule
 * > with one owner per handler, and the failure mode is a route added next month that
 * > nobody remembers to guard. `withAuth` wraps the whole route table and takes an explicit
 * > ALLOW-LIST, so a new route is private by default and being public is a deliberate edit.
 */

import {
  clearedSessionCookie,
  hashToken,
  isoIn,
  isRole,
  newToken,
  type Principal,
  publicUser,
  type Role,
  readCookie,
  SESSION_COOKIE,
  secretEquals,
  sessionCookie,
  type User,
} from "../lib/auth";
import type { AuthStore } from "../lib/auth-store";
import type { Config } from "../lib/config";
import { cookieIsSecure } from "../lib/config";
import {
  createPin,
  type FetchLike,
  hasServerAccess,
  plexAccount,
  plexAuthUrl,
  pollPin,
} from "../lib/plex-auth";
import { clientKey, RateLimiter } from "../lib/rate-limit";
import type { Store } from "../lib/store";
import { AuthError, PasskeyService } from "../lib/webauthn";
import { INDEX_GATE_PUBLIC_PATHS } from "./index-build";

type Handler = (req: Request, server?: unknown) => Response | Promise<Response>;
type RouteEntry = Handler | Record<string, Handler>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * Every refusal an anonymous caller can provoke says the same thing.
 *
 * Not politeness -- disclosure control. "no such invite" and "invite already redeemed" are
 * two different facts about our database, and answering them separately turns the endpoint
 * into an oracle. The log gets the real reason; the caller gets this.
 */
const REFUSED = "that did not work";

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export interface AuthServiceDeps {
  auth: AuthStore;
  store: Store;
  cfg: Config;
  log: (msg: string) => void;
  /** Injected in tests so no ceremony and no Plex call ever leaves the machine. */
  fetchImpl?: FetchLike;
  /** Reads the socket address. Bun's server provides it; tests pass a stub. */
  addressOf?: (req: Request) => string | null;
}

export class AuthService {
  private readonly passkeys: PasskeyService;
  private readonly authLimiter: RateLimiter;
  readonly searchLimiter: RateLimiter;
  private readonly fetchImpl: FetchLike;
  /** Set once by `ensureDevUser`, so the lookup is not repeated on every request. */
  private devUserId: string | null = null;

  constructor(private readonly deps: AuthServiceDeps) {
    this.passkeys = new PasskeyService(deps.auth, deps.cfg, deps.log);
    this.authLimiter = new RateLimiter(deps.cfg.auth.authRatePerMinute);
    this.searchLimiter = new RateLimiter(deps.cfg.auth.searchRatePerMinute);
    this.fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  private get secureCookie(): boolean {
    return cookieIsSecure(this.deps.cfg);
  }

  // --- who is calling ------------------------------------------------------

  /**
   * Resolve a request to a principal, or null.
   *
   * Two credentials, checked in this order: the session cookie (a person) and the
   * `Authorization: Bearer` system key (an agent). The key is compared in constant time
   * because it is a bearer token an attacker can retry, and `a === b` leaks the length and
   * then the first differing byte.
   */
  principal(req: Request): Principal | null {
    const bearer = req.headers.get("authorization");
    const key = this.deps.cfg.auth.adminApiKey;
    if (bearer && key) {
      const offered = bearer.replace(/^Bearer\s+/i, "");
      if (secretEquals(offered, key)) return { kind: "api-key", user: null, role: "admin" };
    }

    const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
    if (token) {
      const found = this.deps.auth.readSession(token);
      if (found) {
        this.deps.auth.touchSession(found.session.idHash);
        return { kind: "session", user: found.user, role: found.user.role, session: found.session };
      }
    }

    /*
      DEVELOPMENT ONLY, and this is the ONE place the login wall is opened.

      It is last rather than first, so a real cookie still wins: signing in as somebody else
      while this is on has to keep working, or the mode cannot be used to look at what a
      non-admin sees. A dead or expired cookie falls through to here rather than being
      refused, which is what stops a stale session from locking a developer out of their own
      dev server.

      `withAuth`, `requireAdmin` and the login-wall shell pick in `index.ts` all read through
      this method, so opening it here opens all three and nothing else needed a second edit.
      That is the whole return on `withAuth` wrapping the table instead of each handler
      checking for itself.
    */
    return this.devPrincipal();
  }

  /**
   * The dev admin, created on demand and remembered for the process.
   *
   * Memoised on the ID rather than the row, and the row is re-read every call: an admin may
   * disable or rename this account while the server runs, and a principal built from a
   * snapshot taken at boot would go on granting access to an account that no longer allows
   * it. A disabled dev user therefore stops working exactly like any other disabled user,
   * which is the behaviour worth having in the mode whose whole job is to rehearse the real
   * one.
   */
  private devPrincipal(): Principal | null {
    const name = this.deps.cfg.auth.devLoginAs;
    if (!name) return null;
    const user = this.ensureDevUser();
    if (!user || user.disabledAt !== null) return null;
    return { kind: "dev", user, role: user.role };
  }

  /**
   * Find or create the account named by `auth.devLoginAs`. Null when the flag is unset.
   *
   * Public because the boot banner reports the account it will be signing people in as, and
   * a banner naming an account that did not exist yet would be a second owner of "who is the
   * dev user". Matching is on the display name, trimmed and case-insensitive -- it is typed
   * into a shell by a human, so `aannarr` and `aannarr` cannot be two accounts.
   */
  ensureDevUser(): User | null {
    const name = this.deps.cfg.auth.devLoginAs?.trim();
    if (!name) return null;
    if (this.devUserId) return this.deps.auth.getUser(this.devUserId);

    const key = name.toLowerCase();
    const existing = this.deps.auth.listUsers().find((u) => u.displayName.trim().toLowerCase() === key);
    const user = existing ?? this.deps.auth.createUser({ displayName: name, role: "admin" });
    if (!existing) this.deps.log(`dev login: created admin account ${JSON.stringify(name)}`);
    this.devUserId = user.id;
    return user;
  }

  private ip(req: Request): string {
    // Configurable, and it MUST match the deployment -- see `auth.trustProxy` in config.ts,
    // where both directions of getting this wrong are written out. This used to be a hard
    // `false` with a comment saying to turn it on once Caddy was in front; Caddy went in
    // front on 2026-08-31 and a hardcoded false would have put the entire internet in one
    // rate-limit bucket, which is a limiter that cannot tell an attacker from a user.
    return clientKey(req, this.deps.addressOf?.(req) ?? null, {
      trustProxy: this.deps.cfg.auth.trustProxy,
    });
  }

  private limited(req: Request): Response | null {
    const k = this.ip(req);
    if (this.authLimiter.take(k)) return null;
    this.deps.log(`auth: rate limited ${k}`);
    return json(
      { error: "too many attempts" },
      { status: 429, headers: { "Retry-After": String(this.authLimiter.retryAfter(k)) } },
    );
  }

  /**
   * The origin to send a Plex user back to.
   *
   * Chosen from the CONFIGURED origins by matching the request's own host, never taken
   * from the request. A `forwardUrl` built out of a header is an open redirect with extra
   * steps, and this one is handed to a third party that will bounce a browser to it.
   */
  private originFor(req: Request): string {
    const host = new URL(req.url).host;
    const match = this.deps.cfg.auth.origins.find((o) => new URL(o).host === host);
    return match ?? this.deps.cfg.auth.origins[0];
  }

  private signIn(userId: string, req: Request): Response {
    const cfg = this.deps.cfg;
    const token = this.deps.auth.createSession({
      userId,
      expiresAt: isoIn(cfg.auth.sessionDays * 86_400_000),
      userAgent: req.headers.get("user-agent"),
    });
    this.deps.auth.touchUser(userId);
    this.authLimiter.clear(this.ip(req));
    const user = this.deps.auth.getUser(userId);
    return json(
      { ok: true, user: user ? publicUser(user) : null },
      {
        headers: {
          "Set-Cookie": sessionCookie(token, {
            secure: this.secureCookie,
            maxAgeSeconds: cfg.auth.sessionDays * 86_400,
          }),
        },
      },
    );
  }

  /** One shape for every failure a caller may see, with the detail going to the log. */
  private refuse(err: unknown, status = 400): Response {
    if (err instanceof AuthError) {
      this.deps.log(`auth refused: ${err.detail}`);
      return json({ error: err.message }, { status });
    }
    this.deps.log(`auth error: ${(err as Error).message}`);
    return json({ error: REFUSED }, { status: 500 });
  }

  // --- routes --------------------------------------------------------------

  /**
   * Paths reachable without a session. The allow-list `withAuth` reads.
   *
   * **`INDEX_GATE_PUBLIC_PATHS` is spread in rather than re-typed**, because anything that
   * answers while there is no INDEX must also answer to a caller with no SESSION: during a
   * first install there are no users at all, so every visitor is anonymous by construction.
   * Keeping them as two hand-written lists is exactly how `/api/index-status` ended up
   * exempt from one guard and refused by the other -- see that constant.
   *
   * `/api/health` appears in both lists and that is fine; `withAuth` reads this into a Set.
   */
  publicPaths(): string[] {
    return [
      ...INDEX_GATE_PUBLIC_PATHS,
      "/api/auth/state",
      "/api/auth/invite",
      "/api/auth/passkey/login/begin",
      "/api/auth/passkey/login/finish",
      "/api/auth/passkey/register/begin",
      "/api/auth/passkey/register/finish",
      "/api/auth/plex/begin",
      "/api/auth/plex/finish",
      "/api/auth/logout",
    ];
  }

  routes(): Record<string, RouteEntry> {
    return {
      /**
       * What the sign-in screen needs to know, and nothing more.
       *
       * Anonymous gets `{ authenticated: false }` plus whether the Plex button should be
       * drawn at all. It deliberately does NOT say how many users exist, whether an
       * invite is outstanding, or what this server is for.
       */
      "/api/auth/state": (req) => {
        const p = this.principal(req);
        if (!p?.user) {
          return json({
            authenticated: false,
            plex: this.deps.cfg.plex.enabled && !!this.deps.cfg.plex.token,
          });
        }
        /*
          No `devLogin` field. It briefly existed so the app could draw a banner saying
          authentication was off; aannarr removed the banner (2026-09-01, "no need for it
          ever") and the field went with it rather than lingering as a fact nobody reads.
          `auth.devLoginAs` in `/api/health` is the one place the mode is reported, and it
          is read by whoever is asking the question rather than by whoever already knows.
        */
        return json({ authenticated: true, user: publicUser(p.user) });
      },

      "/api/auth/me": (req) => {
        const p = this.principal(req);
        if (!p?.user) return json({ error: "not signed in" }, { status: 401 });
        return json({
          user: publicUser(p.user),
          credentials: this.deps.auth.credentialsFor(p.user.id).map((c) => ({
            id: c.id,
            label: c.label,
            deviceType: c.deviceType,
            backedUp: c.backedUp,
            createdAt: c.createdAt,
            lastUsedAt: c.lastUsedAt,
            current: false,
          })),
          sessions: this.deps.auth.sessionsFor(p.user.id).map((s) => ({
            id: s.idHash,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
            userAgent: s.userAgent,
            current: s.idHash === p.session?.idHash,
          })),
        });
      },

      "/api/auth/logout": (req) => {
        const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
        if (token) this.deps.auth.deleteSession(token);
        return json(
          { ok: true },
          { headers: { "Set-Cookie": clearedSessionCookie({ secure: this.secureCookie }) } },
        );
      },

      /**
       * Is this invitation live?
       *
       * The one endpoint that must answer a question about a secret, because the sign-up
       * form cannot be drawn without knowing. It is rate limited, and it answers only
       * `{ ok, displayName }` -- never the role, never who minted it, never a hint about
       * a token that is close but wrong.
       */
      "/api/auth/invite": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        const token = str(new URL(req.url).searchParams.get("token"));
        if (!token) return json({ ok: false }, { status: 404 });
        const invite = this.deps.auth.getInvite(hashToken(token));
        if (!invite || invite.redeemedAt !== null || invite.expiresAt <= new Date().toISOString()) {
          this.deps.log("auth: invite lookup miss");
          return json({ ok: false }, { status: 404 });
        }
        return json({ ok: true, displayName: invite.displayName });
      },

      "/api/auth/passkey/login/begin": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        try {
          const { handle, options } = await this.passkeys.beginLogin();
          return json({ handle, options });
        } catch (err) {
          return this.refuse(err);
        }
      },

      "/api/auth/passkey/login/finish": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        const b = await body(req);
        try {
          const user = await this.passkeys.finishLogin({
            handle: String(b.handle ?? ""),
            response: (b.response ?? {}) as Record<string, unknown>,
          });
          return this.signIn(user.id, req);
        } catch (err) {
          return this.refuse(err, 401);
        }
      },

      /**
       * Begin registering a passkey.
       *
       * Two ways in and they are told apart by what the caller has: an INVITE token (a new
       * account) or a live session (an existing user adding a second device). Neither is a
       * mode flag -- a request with neither is refused.
       */
      "/api/auth/passkey/register/begin": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        const b = await body(req);
        const p = this.principal(req);
        const displayName = str(b.displayName) ?? undefined;

        try {
          if (p?.user) return json(await this.passkeys.beginRegistration({ user: p.user }));

          const token = str(b.token);
          if (!token) return json({ error: REFUSED }, { status: 400 });
          const tokenHash = hashToken(token);
          const invite = this.deps.auth.getInvite(tokenHash);
          if (!invite || invite.redeemedAt !== null || invite.expiresAt <= new Date().toISOString()) {
            this.deps.log("auth: register begin with a dead invite");
            return json({ error: REFUSED }, { status: 400 });
          }
          return json(
            await this.passkeys.beginRegistration({
              invite: { tokenHash, role: invite.role, displayName: invite.displayName },
              displayName,
            }),
          );
        } catch (err) {
          return this.refuse(err);
        }
      },

      "/api/auth/passkey/register/finish": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        const b = await body(req);
        try {
          const { user } = await this.passkeys.finishRegistration({
            handle: String(b.handle ?? ""),
            response: (b.response ?? {}) as Record<string, unknown>,
            label: str(b.label),
          });
          // An existing user adding a device keeps the session they already had; a new one
          // is signed in immediately, because the alternative is a sign-in screen appearing
          // the instant after a successful Touch ID.
          return this.signIn(user.id, req);
        } catch (err) {
          return this.refuse(err);
        }
      },

      /**
       * Start a Plex sign-in.
       *
       * The invite (when there is one) is bound to the PIN row here, so the browser cannot
       * change which invitation it is redeeming halfway through the ceremony.
       */
      "/api/auth/plex/begin": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        if (!this.deps.cfg.plex.enabled) return json({ error: REFUSED }, { status: 404 });
        const b = await body(req);
        const token = str(b.token);
        const clientId = newToken(16);
        try {
          const pin = await createPin(this.fetchImpl, {
            clientId,
            product: this.deps.cfg.plex.productName,
          });
          this.deps.auth.putPin({
            id: pin.id,
            clientId,
            inviteHash: token ? hashToken(token) : null,
            expiresAt: isoIn(pin.expiresIn * 1000),
          });
          return json({
            pinId: pin.id,
            authUrl: plexAuthUrl({
              clientId,
              code: pin.code,
              product: this.deps.cfg.plex.productName,
              forwardUrl: `${this.originFor(req)}/login?plex=${encodeURIComponent(pin.id)}`,
            }),
          });
        } catch (err) {
          return this.refuse(err);
        }
      },

      /**
       * Finish a Plex sign-in, if the user has approved the PIN yet.
       *
       * `{ pending: true }` is the ordinary answer while they are still typing their
       * password, and the client polls. Everything after the token arrives is the
       * authorization half: a Plex account is not an account here.
       */
      "/api/auth/plex/finish": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        const b = await body(req);
        const pinId = str(b.pinId);
        if (!pinId) return json({ error: REFUSED }, { status: 400 });
        const pending = this.deps.auth.peekPin(pinId);
        if (!pending) return json({ error: REFUSED }, { status: 400 });

        try {
          const plexToken = await pollPin(this.fetchImpl, {
            id: pinId,
            clientId: pending.clientId,
            product: this.deps.cfg.plex.productName,
          });
          if (!plexToken) return json({ pending: true });

          const account = await plexAccount(this.fetchImpl, plexToken, this.deps.cfg.plex.productName);
          this.deps.auth.deletePin(pinId);

          // Gate two, when we know which server we are. Never a substitute for gate one.
          const machineId = this.deps.cfg.plex.machineIdentifier;
          if (machineId) {
            const ok = await hasServerAccess(this.fetchImpl, {
              token: plexToken,
              product: this.deps.cfg.plex.productName,
              machineIdentifier: machineId,
            });
            if (!ok) {
              this.deps.log(`auth: plex account ${account.id} has no access to our server`);
              return json({ error: REFUSED }, { status: 403 });
            }
          }

          const existing = this.deps.auth.getUserByPlexId(account.id);
          if (existing) {
            if (existing.disabledAt !== null) {
              this.deps.log(`auth: disabled user ${existing.id} tried to sign in with Plex`);
              return json({ error: REFUSED }, { status: 403 });
            }
            return this.signIn(existing.id, req);
          }

          // Gate one. No invite, no account -- there is no "any Plex account may sign in".
          if (!pending.inviteHash) {
            this.deps.log(`auth: plex account ${account.id} is unknown and carried no invite`);
            return json({ error: REFUSED }, { status: 403 });
          }
          const invite = this.deps.auth.claimInvite(pending.inviteHash);
          if (!invite) {
            this.deps.log("auth: plex sign-up against a dead invite");
            return json({ error: REFUSED }, { status: 403 });
          }
          const user = this.deps.auth.createUser({
            displayName: invite.displayName ?? account.username ?? "finderr user",
            role: invite.role,
            plexId: account.id,
            plexUsername: account.username,
          });
          try {
            this.deps.auth.attributeInvite(pending.inviteHash, user.id);
          } catch (err) {
            this.deps.log(`invite attribution failed (account is fine): ${(err as Error).message}`);
          }
          return this.signIn(user.id, req);
        } catch (err) {
          return this.refuse(err);
        }
      },

      // --- signed in: your own devices ---------------------------------------

      /**
       * Attach a Plex account to the account you are ALREADY signed in to.
       *
       * > [!IMPORTANT] This is not `/api/auth/plex/finish` with a session attached
       * > That route answers "who is this, and may they in?" -- it is authentication, it is
       * > public, it is rate limited per IP, and its whole second half is the invite gate
       * > that decides whether a stranger becomes a user. This one starts from a caller we
       * > have already identified, so there is no invite to claim, no account to create and
       * > no sign-in to issue. Folding the two together would put a branch on "is there a
       * > session?" through the middle of the one ceremony where a mistake creates an
       * > account for the wrong person.
       *
       * The PIN is minted with NO `inviteHash`, which is what makes it useless as a
       * sign-up: if it were somehow replayed against `/finish`, gate one refuses it.
       */
      "/api/auth/plex/link/begin": async (req) => {
        const p = this.principal(req);
        if (!p?.user) return json({ error: "not signed in" }, { status: 401 });
        const refused = this.limited(req);
        if (refused) return refused;
        if (!this.deps.cfg.plex.enabled) return json({ error: REFUSED }, { status: 404 });

        const clientId = newToken(16);
        try {
          const pin = await createPin(this.fetchImpl, {
            clientId,
            product: this.deps.cfg.plex.productName,
          });
          this.deps.auth.putPin({
            id: pin.id,
            clientId,
            inviteHash: null,
            expiresAt: isoIn(pin.expiresIn * 1000),
          });
          return json({
            pinId: pin.id,
            authUrl: plexAuthUrl({
              clientId,
              code: pin.code,
              product: this.deps.cfg.plex.productName,
              // Back to the account page rather than the login page: the caller never left
              // being signed in, and landing them on a sign-in screen would read as a
              // failure of the thing that just succeeded.
              forwardUrl: `${this.originFor(req)}/account?plex=${encodeURIComponent(pin.id)}`,
            }),
          });
        } catch (err) {
          return this.refuse(err);
        }
      },

      /**
       * Finish the link, if the user has approved the PIN yet.
       *
       * Three refusals, and each one is a different mistake:
       *
       * - The caller already has a Plex account attached. Silently replacing it would let
       *   somebody swap the identity on an account without ever seeing what they replaced.
       * - That Plex account is already attached to a DIFFERENT finderr user. Two users
       *   sharing one Plex id would make `getUserByPlexId` a coin flip at every sign-in.
       * - The account has no access to our Plex server, when we know which server we are.
       *   Same gate `/finish` applies, and for the same reason.
       */
      "/api/auth/plex/link/finish": async (req) => {
        const p = this.principal(req);
        if (!p?.user) return json({ error: "not signed in" }, { status: 401 });
        const refused = this.limited(req);
        if (refused) return refused;

        const b = await body(req);
        const pinId = str(b.pinId);
        if (!pinId) return json({ error: REFUSED }, { status: 400 });
        const pending = this.deps.auth.peekPin(pinId);
        if (!pending) return json({ error: REFUSED }, { status: 400 });

        try {
          const plexToken = await pollPin(this.fetchImpl, {
            id: pinId,
            clientId: pending.clientId,
            product: this.deps.cfg.plex.productName,
          });
          if (!plexToken) return json({ pending: true });

          const account = await plexAccount(this.fetchImpl, plexToken, this.deps.cfg.plex.productName);
          this.deps.auth.deletePin(pinId);

          const machineId = this.deps.cfg.plex.machineIdentifier;
          if (machineId) {
            const ok = await hasServerAccess(this.fetchImpl, {
              token: plexToken,
              product: this.deps.cfg.plex.productName,
              machineIdentifier: machineId,
            });
            if (!ok) {
              this.deps.log(`auth: plex account ${account.id} has no access to our server`);
              return json({ error: REFUSED }, { status: 403 });
            }
          }

          // Re-read rather than trusting the principal we captured before an await: the
          // ceremony can take a minute of the user typing a password, and an admin may have
          // linked or disabled this account in the meantime.
          const me = this.deps.auth.getUser(p.user.id);
          if (!me) return json({ error: REFUSED }, { status: 401 });
          if (me.plexId !== null) {
            return json({ error: "a Plex account is already connected" }, { status: 409 });
          }

          const owner = this.deps.auth.getUserByPlexId(account.id);
          if (owner && owner.id !== me.id) {
            this.deps.log(`auth: plex account ${account.id} is already linked to ${owner.id}`);
            // Deliberately vague. "Linked to somebody else" is a fact about another
            // account, and the caller can do nothing with it but learn it.
            return json({ error: "that Plex account cannot be connected" }, { status: 409 });
          }

          this.deps.auth.linkPlex(me.id, account.id, account.username);
          this.deps.log(`auth: linked plex account to ${me.id}`);
          return json({ ok: true, plexUsername: account.username });
        } catch (err) {
          return this.refuse(err);
        }
      },

      "/api/auth/plex": {
        /**
         * Disconnect Plex from your account.
         *
         * Refused when it is your only way back in -- the mirror of the rule on deleting a
         * last credential, and the same 409. The two together are the whole self-lockout
         * guard: a user must always keep at least one of "a passkey" or "a Plex account",
         * and neither endpoint may be the one that takes the last one away.
         *
         * It does NOT end any session. Unlinking is not a compromise, the caller is still
         * who they were, and signing somebody out of every device for a settings change
         * they made deliberately would be a punishment rather than a safeguard.
         */
        DELETE: (req) => {
          const p = this.principal(req);
          if (!p?.user) return json({ error: "not signed in" }, { status: 401 });
          const me = this.deps.auth.getUser(p.user.id);
          if (!me) return json({ error: REFUSED }, { status: 401 });
          if (me.plexId === null) return json({ ok: false }, { status: 404 });
          if (this.deps.auth.credentialsFor(me.id).length === 0) {
            return json({ error: "that is your only way to sign in" }, { status: 409 });
          }
          this.deps.auth.unlinkPlex(me.id);
          this.deps.log(`auth: unlinked plex account from ${me.id}`);
          return json({ ok: true });
        },
      },

      "/api/auth/credentials/:id": {
        /**
         * Name a passkey.
         *
         * The whole point of the account page is that a lost device can be revoked, and
         * "passkey · added 3 Aug" beside "passkey · added 11 Aug" is not something anybody
         * can act on. `registerPasskey` guesses a label from the user agent at creation
         * time; this is how a wrong guess gets corrected.
         *
         * A label is the one piece of user-authored text in this table, so it is capped and
         * trimmed. The cap is not a security control -- `maxRequestBodySize` is -- it is
         * what stops one row rendering as a wall of text on everybody's account page.
         */
        PATCH: async (req) => {
          const p = this.principal(req);
          if (!p?.user) return json({ error: "not signed in" }, { status: 401 });
          const id = (req as Bun.BunRequest<"/api/auth/credentials/:id">).params.id;
          const b = await body(req);
          const raw = b.label;
          if (raw !== null && typeof raw !== "string" && raw !== undefined) {
            return json({ error: "label must be a string or null" }, { status: 400 });
          }
          const label = typeof raw === "string" ? raw.slice(0, 60) : null;
          const ok = this.deps.auth.renameCredential(decodeURIComponent(id), p.user.id, label);
          return json({ ok }, { status: ok ? 200 : 404 });
        },

        DELETE: (req) => {
          const p = this.principal(req);
          if (!p?.user) return json({ error: "not signed in" }, { status: 401 });
          const id = (req as Bun.BunRequest<"/api/auth/credentials/:id">).params.id;
          const remaining = this.deps.auth.credentialsFor(p.user.id);
          // Removing your last passkey when it is also your only way in is a self-lockout
          // that only an admin can undo. Refuse it, and say why -- this is one of the few
          // refusals a signed-in user is allowed a real reason for.
          if (remaining.length <= 1 && p.user.plexId === null)
            return json({ error: "that is your only way to sign in" }, { status: 409 });
          const ok = this.deps.auth.deleteCredential(decodeURIComponent(id), p.user.id);
          return json({ ok }, { status: ok ? 200 : 404 });
        },
      },

      "/api/auth/sessions/:id": {
        DELETE: (req) => {
          const p = this.principal(req);
          if (!p?.user) return json({ error: "not signed in" }, { status: 401 });
          const id = (req as Bun.BunRequest<"/api/auth/sessions/:id">).params.id;
          // Scoped to the caller's own sessions: the id is a hash, so knowing one is not
          // authority to end it.
          const mine = this.deps.auth.sessionsFor(p.user.id).some((s) => s.idHash === id);
          if (!mine) return json({ error: "not found" }, { status: 404 });
          return json({ ok: this.deps.auth.deleteSessionByHash(id) });
        },
      },

      // --- admin -------------------------------------------------------------

      "/api/admin/invites": {
        GET: (req) =>
          this.asAdmin(req, () =>
            json({
              invites: this.deps.auth.listInvites().map((i) => ({
                // The HASH, never a token. A listing that returned live tokens would make
                // this endpoint a credential dispenser rather than a report.
                id: i.tokenHash,
                role: i.role,
                note: i.note,
                displayName: i.displayName,
                createdAt: i.createdAt,
                expiresAt: i.expiresAt,
                redeemedAt: i.redeemedAt,
                redeemedBy: i.redeemedBy,
              })),
            }),
          ),
        POST: async (req) =>
          this.asAdmin(req, async (p) => {
            const b = await body(req);
            const role: Role = isRole(b.role) ? b.role : "user";
            const hours =
              typeof b.hours === "number" && b.hours > 0 ? b.hours : this.deps.cfg.auth.inviteHours;
            const { token, invite } = this.deps.auth.createInvite({
              role,
              note: str(b.note),
              displayName: str(b.displayName),
              createdBy: p.user?.id ?? "api-key",
              expiresAt: isoIn(hours * 3_600_000),
            });
            this.deps.log(
              `invite minted (${role}) by ${p.kind === "api-key" ? "the system key" : p.user?.id}`,
            );
            return json({
              // The ONE time the token exists outside the invitee's link. It is not stored
              // and cannot be listed again -- a lost invite is re-minted, never recovered.
              token,
              url: `${this.originFor(req)}/invite/${token}`,
              id: invite.tokenHash,
              role: invite.role,
              expiresAt: invite.expiresAt,
            });
          }),
      },

      "/api/admin/invites/:id": {
        DELETE: (req) =>
          this.asAdmin(req, () => {
            const id = (req as Bun.BunRequest<"/api/admin/invites/:id">).params.id;
            return json({ ok: this.deps.auth.deleteInvite(id) });
          }),
      },

      "/api/admin/users": {
        GET: (req) =>
          this.asAdmin(req, () =>
            json({
              users: this.deps.auth.listUsers().map((u) => ({
                ...publicUser(u),
                credentials: this.deps.auth.credentialsFor(u.id).length,
                sessions: this.deps.auth.sessionsFor(u.id).length,
              })),
            }),
          ),
      },

      "/api/admin/users/:id": {
        PATCH: async (req) =>
          this.asAdmin(req, async () => {
            const id = (req as Bun.BunRequest<"/api/admin/users/:id">).params.id;
            const b = await body(req);
            const target = this.deps.auth.getUser(id);
            if (!target) return json({ error: "not found" }, { status: 404 });
            const wantsRole = isRole(b.role) ? b.role : undefined;
            const wantsDisabled = typeof b.disabled === "boolean" ? b.disabled : undefined;
            // Never let the last admin demote or disable themselves out of existence: the
            // recovery from that is editing SQLite by hand on the host.
            const losingAdmin = target.role === "admin" && (wantsRole === "user" || wantsDisabled === true);
            if (losingAdmin && this.deps.auth.adminCount() <= 1)
              return json({ error: "that is the last admin" }, { status: 409 });
            const updated = this.deps.auth.updateUser(id, {
              displayName: str(b.displayName) ?? undefined,
              role: wantsRole,
              disabled: wantsDisabled,
            });
            // A disabled account keeps no live sessions. Without this the ban takes effect
            // whenever their cookie happens to expire, which is up to 30 days later.
            if (wantsDisabled === true) this.deps.auth.deleteSessionsFor(id);
            return json({ user: updated ? publicUser(updated) : null });
          }),
        DELETE: (req) =>
          this.asAdmin(req, () => {
            const id = (req as Bun.BunRequest<"/api/admin/users/:id">).params.id;
            const target = this.deps.auth.getUser(id);
            if (!target) return json({ error: "not found" }, { status: 404 });
            if (target.role === "admin" && this.deps.auth.adminCount() <= 1)
              return json({ error: "that is the last admin" }, { status: 409 });
            this.deps.auth.deleteUser(id);
            // Their requests survive with a dangling `requested_by`. Deliberate: an admin
            // deleting a user is often doing it BECAUSE of what they requested.
            return json({ ok: true });
          }),
      },

      /**
       * The passkey equivalent of forcing a password reset.
       *
       * There are no passwords, so "reset" means: every credential revoked, every session
       * killed, any Plex link broken, and a fresh invite minted so they can enrol again.
       * That combination is also the decisive fix for a device carrying stranded passkeys
       * from a failed sign-up -- with no server-side credential left, every passkey in
       * their keychain is dead and there is no longer a right one to hunt for.
       */
      "/api/admin/users/:id/reset": {
        POST: async (req) =>
          this.asAdmin(req, async (p) => {
            const id = (req as Bun.BunRequest<"/api/admin/users/:id/reset">).params.id;
            const target = this.deps.auth.getUser(id);
            if (!target) return json({ error: "not found" }, { status: 404 });
            const b = await body(req);
            const credentials = this.deps.auth.deleteCredentialsFor(id);
            const sessions = this.deps.auth.deleteSessionsFor(id);
            this.deps.auth.unlinkPlex(id);
            const hours =
              typeof b.hours === "number" && b.hours > 0 ? b.hours : this.deps.cfg.auth.inviteHours;
            const { token, invite } = this.deps.auth.createInvite({
              role: target.role,
              note: `reset for ${target.displayName}`,
              displayName: target.displayName,
              createdBy: p.user?.id ?? "api-key",
              expiresAt: isoIn(hours * 3_600_000),
            });
            this.deps.log(`user ${id} reset: ${credentials} credential(s), ${sessions} session(s) revoked`);
            return json({
              ok: true,
              revoked: { credentials, sessions },
              token,
              url: `${this.originFor(req)}/invite/${token}`,
              expiresAt: invite.expiresAt,
            });
          }),
      },

      /**
       * The request log WITH attribution. Admin-only, and that is the whole point of it
       * being a separate route from anything a user can reach.
       */
      "/api/admin/requests": {
        GET: (req) =>
          this.asAdmin(req, () => {
            const users = new Map(this.deps.auth.listUsers().map((u) => [u.id, u.displayName]));
            return json({
              requests: this.deps.store.listRequests(undefined, 500).map((r) => ({
                ...r,
                requestedByName: r.requested_by ? (users.get(r.requested_by) ?? "(removed)") : null,
              })),
            });
          }),
      },
    };
  }

  /**
   * The key a per-IP limiter should count this request against.
   *
   * Public so routes OUTSIDE this table (the search limiter in `index.ts`) key on the
   * same address the auth limiter does. Two derivations would drift the day proxy
   * trust changes -- one would start reading `X-Forwarded-For` and the other would go
   * on counting the whole internet against the proxy's socket address.
   */
  clientIp(req: Request): string {
    return this.ip(req);
  }

  /**
   * Refuse a non-admin, or null to proceed. For app routes that are admin-only but
   * live outside this table. Same answers as `asAdmin`: anonymous gets 401, a
   * signed-in non-admin gets 404 -- the admin surface does not announce itself.
   */
  requireAdmin(req: Request): Response | null {
    const r = this.adminPrincipal(req);
    return r instanceof Response ? r : null;
  }

  /** The one owner of "is this caller an admin". A Response is the refusal to return. */
  private adminPrincipal(req: Request): Principal | Response {
    const p = this.principal(req);
    if (!p) return json({ error: "not signed in" }, { status: 401 });
    if (p.role !== "admin") {
      this.deps.log(`admin route refused for ${p.user?.id ?? "unknown"}`);
      return json({ error: "not found" }, { status: 404 });
    }
    return p;
  }

  /** Admin session or the system key. Anything else is a 401/403 and a log line. */
  private async asAdmin(req: Request, fn: (p: Principal) => Response | Promise<Response>): Promise<Response> {
    const r = this.adminPrincipal(req);
    if (r instanceof Response) return r;
    try {
      return await fn(r);
    } catch (err) {
      return this.refuse(err, 500);
    }
  }
}

/**
 * Close every route that is not on the allow-list.
 *
 * Wrapping the table rather than editing each handler is what makes "private" the DEFAULT:
 * a route added later is guarded by having been added, and making one public is a visible
 * edit to `publicPaths()`. The alternative -- a check at the top of each handler -- is a
 * rule with as many owners as there are routes.
 *
 * A refused API call gets a 401 with a JSON body, never a redirect: the caller is
 * JavaScript, and a 302 to an HTML page produces a parse error instead of a sign-in.
 */
export function withAuth<T extends Record<string, unknown>>(
  routes: T,
  opts: { authService: AuthService; publicPaths: readonly string[] },
): T {
  const open = new Set(opts.publicPaths);
  /*
    The wrapper is variadic and untyped INSIDE, and the function is generic OUTSIDE.

    That combination is what lets a guarded table stay exactly as typed as the one that
    went in -- Bun infers `req.params` from each path literal, and a `Record<string,
    Handler>` parameter would erase that for every route in the table. The arguments are
    passed straight through, so nothing here can change what a handler receives.
  */
  const wrap =
    (path: string, handler: (...args: never[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const req = args[0] as Request;
      if (open.has(path) || opts.authService.principal(req)) {
        return (handler as (...a: unknown[]) => unknown)(...args);
      }
      return json({ error: "not signed in" }, { status: 401 });
    };

  const out: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(routes)) {
    if (typeof entry === "function") {
      out[path] = wrap(path, entry as (...args: never[]) => unknown);
      continue;
    }
    if (entry && typeof entry === "object") {
      const methods: Record<string, unknown> = {};
      for (const [method, handler] of Object.entries(entry as Record<string, unknown>)) {
        methods[method] = wrap(path, handler as (...args: never[]) => unknown);
      }
      out[path] = methods;
      continue;
    }
    // A static Response or anything else Bun accepts as a route value: pass it through
    // rather than guessing at it. Nothing in this tree uses one today.
    out[path] = entry;
  }
  return out as T;
}
