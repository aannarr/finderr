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
  attributedRequest,
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
  safeReturnPath,
  secretEquals,
  sessionCookie,
  type User,
} from "../lib/auth";
import type { AuthStore } from "../lib/auth-store";
import type { Config } from "../lib/config";
import { cookieIsSecure } from "../lib/config";
import { FirstRun } from "../lib/first-run";
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
import { AGENT_KEY_PATH, type AgentBucket, bootstrapSnippet } from "./agent-api";
import { ARR_WEBHOOK_PATH } from "./arr-webhook";
import { INDEX_GATE_PUBLIC_PATHS } from "./index-build";
import { json } from "./json-response";
import { PREVIEW_IMAGE_PATH } from "./preview-resolver";
import { wrapRoutes } from "./route-wrap";

type Handler = (req: Request, server?: unknown) => Response | Promise<Response>;
type RouteEntry = Handler | Record<string, Handler>;

/**
 * Every refusal an anonymous caller can provoke says the same thing.
 *
 * Not politeness -- disclosure control. "no such invite" and "invite already redeemed" are
 * two different facts about our database, and answering them separately turns the endpoint
 * into an oracle. The log gets the real reason; the caller gets this.
 */
const REFUSED = "that did not work";

/**
 * Who everybody is while `FINDERR_NO_AUTH` is set. A CONSTANT, deliberately not an env.
 *
 * aannarr, 2026-09-01: "one flag, one constant" -- a mode whose job is that a dev server
 * comes up working at short notice must not also ask you which name you used last time.
 */
export const NO_AUTH_USER = "the_user";

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
  /**
   * The first-run admin claim. PUBLIC because the boot banner asks whether the door is
   * open, and asking is also what arms the latch on a server that already has users --
   * see `FirstRun.open`.
   */
  readonly firstRun: FirstRun;
  private readonly authLimiter: RateLimiter;
  readonly searchLimiter: RateLimiter;
  /**
   * One limiter per agent bucket, held HERE beside the other two so every limiter in the
   * product has one owner and one lifetime. `withAgentApi` and the manifest both read them
   * through `agentLimiter`, which is what keeps the document's numbers and the wall's
   * numbers the same numbers.
   */
  private readonly agentLimiters: Record<AgentBucket, RateLimiter>;
  private readonly fetchImpl: FetchLike;
  /** Set once by `ensureDevUser`, so the lookup is not repeated on every request. */
  private devUserId: string | null = null;

  constructor(private readonly deps: AuthServiceDeps) {
    this.passkeys = new PasskeyService(deps.auth, deps.cfg, deps.log);
    this.firstRun = new FirstRun({ auth: deps.auth, kv: deps.store, log: deps.log });
    this.authLimiter = new RateLimiter(deps.cfg.auth.authRatePerMinute);
    this.searchLimiter = new RateLimiter(deps.cfg.auth.searchRatePerMinute);
    this.agentLimiters = {
      cheap: new RateLimiter(deps.cfg.auth.agentCheapRatePerMinute),
      expensive: new RateLimiter(deps.cfg.auth.agentExpensiveRatePerMinute),
    };
    this.fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  agentLimiter(bucket: AgentBucket): RateLimiter {
    return this.agentLimiters[bucket];
  }

  private get secureCookie(): boolean {
    return cookieIsSecure(this.deps.cfg);
  }

  // --- who is calling ------------------------------------------------------

  /**
   * Resolve a request to a principal, or null.
   *
   * Three credentials, checked in this order: the `Authorization: Bearer` system key (the
   * operator's own key), a bearer AGENT key (one person's automation), and the session
   * cookie (a person in a browser). The system key is compared in constant time because it
   * is a literal secret in config and `a === b` leaks the length and then the first
   * differing byte; the agent key is looked up by HASH, so there is nothing to compare in
   * the first place.
   */
  principal(req: Request): Principal | null {
    const bearer = req.headers.get("authorization");
    const key = this.deps.cfg.auth.adminApiKey;
    if (bearer) {
      const offered = bearer.replace(/^Bearer\s+/i, "");
      if (key && secretEquals(offered, key)) return { kind: "api-key", user: null, role: "admin" };
      const agent = this.agentPrincipal(offered);
      if (agent) return agent;
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
   * The owner of a presented agent key, as a principal, or null.
   *
   * > [!CAUTION] The role is `user`, ALWAYS, even when the owner is an admin
   * > A leaked admin agent key mints invites, changes roles and deletes accounts; a leaked
   * > ordinary one asks for films. The blast radius difference is enormous and the
   * > convenience gain is nil. Every role-gated surface in the product -- `adminPrincipal`,
   * > `visibleRequest`, `arrLink`, the per-request arr overrides, the daily quota -- reads
   * > this one field, so the rule is enforced in each of them without any of them carrying a
   * > check for it. `withAgentApi` closes the admin PATHS as well; the two are different
   * > statements ("no admin authority" and "not that surface") and both are wanted.
   *
   * A disabled owner has no principal, exactly as a disabled owner's session does not: the
   * key is a way in, and an account that may not sign in may not be reached through one.
   */
  private agentPrincipal(offered: string): Principal | null {
    const key = this.deps.auth.getAgentKeyByHash(hashToken(offered));
    if (!key) return null;
    const user = this.deps.auth.getUser(key.userId);
    if (!user || user.disabledAt !== null) return null;
    this.deps.auth.touchAgentKey(key.userId);
    return { kind: "agent", user, role: "user", agent: { readOnly: key.readOnly } };
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
    if (!this.deps.cfg.auth.noAuth) return null;
    const user = this.ensureDevUser();
    if (!user || user.disabledAt !== null) return null;
    return { kind: "dev", user, role: user.role };
  }

  /**
   * Find or create the `NO_AUTH_USER` account. Null unless `FINDERR_NO_AUTH` is set.
   *
   * ONE CONSTANT, no env to feed it -- see `auth.noAuth` in config.ts for why the name is
   * not configurable. Public because the boot banner reports the account it will be signing
   * people in as, and a banner naming an account that did not exist yet would be a second
   * owner of "who is the no-auth user".
   *
   * Matching is on the display name, trimmed and case-insensitive, so an account somebody
   * already made by hand under that name is ADOPTED rather than duplicated.
   */
  ensureDevUser(): User | null {
    if (!this.deps.cfg.auth.noAuth) return null;
    if (this.devUserId) return this.deps.auth.getUser(this.devUserId);

    const key = NO_AUTH_USER.toLowerCase();
    const existing = this.deps.auth.listUsers().find((u) => u.displayName.trim().toLowerCase() === key);
    const user = existing ?? this.deps.auth.createUser({ displayName: NO_AUTH_USER, role: "admin" });
    if (!existing) this.deps.log(`no-auth: created admin account ${JSON.stringify(NO_AUTH_USER)}`);
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
      /*
        The Open Graph image -- a poster for a `tt`, a headshot for an `nm` -- and the ONE
        image route an anonymous caller may reach.

        It serves only what the artwork cache and `person_image` already hold, and never
        resolves upstream -- see the route itself in `./index.ts`, where the distinction
        from `/img/t/:tconst` is the whole reason two routes exist. Both id spaces go
        through that one route precisely so this stays ONE line: a second pattern here is
        a second thing to forget, and forgetting it serves a card whose image 401s.

        Listed as the route PATTERN because `withAuth` matches on the table's key, not on
        the request path -- so this string must track the key in `./index.ts` exactly.
      */
      `${PREVIEW_IMAGE_PATH}/:id`,
      /*
        The Radarr and Sonarr callback, and the ONE public route that CHANGES state.

        It cannot be anything else: an arr has no cookie, no Plex account and no way to be
        given one. So it is authenticated by its own basic-auth password instead -- see
        `config.webhook` and `../server/arr-webhook.ts`, which refuses every caller when no
        password is configured. Listing it here is the deliberate, visible edit the guard is
        designed to require; leaving it out would answer 401 to the arrs and look exactly
        like a broken integration from their side.
      */
      ARR_WEBHOOK_PATH,
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
       *
       * `setup: true` is the ONE exception, and it is ABSENT rather than false the rest of
       * the time. It says "this server has no accounts", which is a real disclosure -- but
       * the screen cannot offer the claim without knowing, the claim is the feature, and
       * the fact stops being true the moment anybody signs up and never becomes true again.
       * A `setup: false` on every other server would leak nothing extra and would still be
       * one more field an anonymous caller learns to read.
       */
      "/api/auth/state": (req) => {
        const p = this.principal(req);
        if (!p?.user) {
          const setup = this.firstRun.open();
          return json({
            authenticated: false,
            plex: this.deps.cfg.plex.enabled && !!this.deps.cfg.plex.token,
            ...(setup ? { setup: true } : {}),
          });
        }
        /*
          No `devLogin` field. It briefly existed so the app could draw a banner saying
          authentication was off; aannarr removed the banner (2026-09-01, "no need for it
          ever") and the field went with it rather than lingering as a fact nobody reads.
          `auth.noAuth` in `/api/health` is the one place the mode is reported, and it
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
       * Three ways in, told apart by what the caller has and never by a mode flag: a live
       * session (an existing user adding a second device), an INVITE token (a new account),
       * or NEITHER on a server that has no accounts at all -- the first-run claim, which
       * `FirstRun` authorises by minting the admin invite the rest of this handler then
       * treats as any other. A request with none of the three is refused.
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
          const tokenHash = token ? hashToken(token) : this.firstRun.claimHash();
          if (!tokenHash) return json({ error: REFUSED }, { status: 400 });
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
       *
       * A tokenless begin is a plain sign-in for a Plex account we already know -- unless
       * the server has no accounts at all, in which case the first-run claim supplies the
       * invite and this becomes the sign-up that creates the admin. There is nothing to
       * disambiguate: a server with no users has no Plex account to sign in as either.
       */
      "/api/auth/plex/begin": async (req) => {
        const refused = this.limited(req);
        if (refused) return refused;
        if (!this.deps.cfg.plex.enabled) return json({ error: REFUSED }, { status: 404 });
        const b = await body(req);
        const token = str(b.token);
        const inviteHash = token ? hashToken(token) : this.firstRun.claimHash();
        const next = safeReturnPath(str(b.next));
        const clientId = newToken(16);
        try {
          const pin = await createPin(this.fetchImpl, {
            clientId,
            product: this.deps.cfg.plex.productName,
          });
          this.deps.auth.putPin({
            id: pin.id,
            clientId,
            inviteHash,
            expiresAt: isoIn(pin.expiresIn * 1000),
          });
          return json({
            pinId: pin.id,
            authUrl: plexAuthUrl({
              clientId,
              code: pin.code,
              product: this.deps.cfg.plex.productName,
              /*
                WHERE THE READER ENDS UP, carried across a round trip through plex.tv.

                The path used to be hardcoded, so somebody following a shared
                `/title/tt0096895` link left for Plex, came back to `/login`, signed in and
                landed on the front page -- the destination was gone from the browser
                before the ceremony finished, and no client-side fix can recover it.

                It rides in OUR OWN forward URL rather than being bound to the PIN row, and
                the distinction from the invite token beside it is deliberate. An invite is
                a CAPABILITY, so which one is being redeemed must not be editable mid-flow;
                a landing path is not, and a reader who edited it would arrive somewhere
                they could have navigated to anyway. Binding it would have cost a schema
                migration on a live table to buy nothing.

                `safeReturnPath` runs HERE, before the value reaches a URL we hand to a
                third party -- unvalidated it would make this an open redirect with Plex as
                the bouncer, which is the exact failure `originFor` exists to prevent one
                line up. The client validates again on the way back in.
            */
              forwardUrl:
                `${this.originFor(req)}/login?plex=${encodeURIComponent(pin.id)}` +
                (next ? `&next=${encodeURIComponent(next)}` : ""),
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

      /**
       * Your ONE agent key: look at it, replace it, or take it away.
       *
       * > [!IMPORTANT] There is no list and no id, because there is no collection
       * > `agent_key.user_id` is the primary key, so "one per user" is the schema rather
       * > than a rule somebody has to enforce. `POST` is therefore both creation and
       * > rotation -- it overwrites the row, which kills the previous token in the same
       * > statement that mints its replacement. There is no window in which both work and
       * > nothing left over to revoke by id.
       *
       * **A PERSON ONLY.** An agent key cannot reach this route, so it cannot rotate or
       * revoke itself -- a credential that can renew itself is one that survives its owner
       * noticing it leaked. `withAgentApi` closes the whole `/api/auth/` prefix to agent
       * keys and owns that rule; the check below is this route stating what it needs on its
       * own account, because it is the one route that mints a credential and it must be
       * correct even when read alone.
       */
      [AGENT_KEY_PATH]: {
        GET: (req) => {
          const p = this.personalPrincipal(req);
          if (p instanceof Response) return p;
          const key = this.deps.auth.agentKeyFor(p.id);
          // Never the hash either. It is not a secret, but it is not anything a person can
          // act on, and a field nobody uses is a field somebody eventually renders.
          return json({
            key: key
              ? { createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, readOnly: key.readOnly }
              : null,
          });
        },

        POST: async (req) => {
          const p = this.personalPrincipal(req);
          if (p instanceof Response) return p;
          const b = await body(req);
          if (b.readOnly !== undefined && typeof b.readOnly !== "boolean") {
            return json({ error: "readOnly must be a boolean" }, { status: 400 });
          }
          const readOnly = b.readOnly === true;
          const existed = this.deps.auth.agentKeyFor(p.id) !== null;
          const { token, key } = this.deps.auth.putAgentKey({ userId: p.id, readOnly });
          this.deps.log(`agent key ${existed ? "rotated" : "created"} for ${p.id}`);
          return json({
            /*
              THE ONE TIME THE PLAINTEXT EXISTS OUTSIDE THE HOLDER'S HANDS. Only the sha256
              is stored, so this is not recoverable -- a lost snippet is rotated, never
              looked up.

              The SNIPPET is the deliverable rather than the bare token: it is what a person
              hands to an agent, and building it here means the origin comes from the live
              request. A constant would render the wrong host on exactly one of the two
              addresses this app answers on.
            */
            token,
            snippet: bootstrapSnippet(this.originFor(req), token),
            rotated: existed,
            key: { createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, readOnly: key.readOnly },
          });
        },

        DELETE: (req) => {
          const p = this.personalPrincipal(req);
          if (p instanceof Response) return p;
          const ok = this.deps.auth.deleteAgentKey(p.id);
          if (ok) this.deps.log(`agent key revoked for ${p.id}`);
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
          this.asAdmin(req, (p) => {
            const users = new Map(this.deps.auth.listUsers().map((u) => [u.id, u.displayName]));
            return json({
              /*
                Through `attributedRequest` like `/api/requests`, rather than spreading the
                raw row.

                It is admin-only either way, so the strip changes nothing about what this
                route sends -- what it buys is that there is ONE resolver of a requester's
                name. The inline join that used to live here worded a deleted account its
                own way, and a second reader of the log would have had to copy it.
              */
              requests: this.deps.store
                .listRequests(undefined, 500)
                .map((r) => attributedRequest(r, p.role, (id) => users.get(id) ?? null)),
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
   * The key a limiter on an APPLICATION route should count against: the account when we
   * know one, the address otherwise.
   *
   * > [!IMPORTANT] An address is the wrong bucket for a caller we can actually name
   * > aannarr, 2026-09-02: *"no one should be able to fuck around"*. Keying a signed-in
   * > caller on their IP is wrong in both directions. A household behind one NAT shares a
   * > bucket, so one person's tab storm throttles everybody else in the house; and one
   * > account holding several sessions across several addresses gets a fresh budget per
   * > address, which is the exact hole a limiter exists to close. An account id collapses
   * > every session that account has into ONE bucket and is not something the caller can
   * > mint -- unlike an address, and unlike `X-Forwarded-For`.
   *
   * The prefixes matter: without them a user whose id happened to look like an address
   * would share a bucket with that address. They are cheap and the collision is silent.
   *
   * **The auth routes deliberately do NOT use this.** Their caller is anonymous by
   * definition -- that is what they are for -- so the address is the only thing there is,
   * and `limited()` keys on `ip()` directly. An `api-key` principal has no user and falls
   * through to the address for the same reason.
   */
  limitKey(req: Request): string {
    const p = this.principal(req);
    return p?.user ? `u:${p.user.id}` : `ip:${this.ip(req)}`;
  }

  /**
   * The USER behind a request, when the caller is a person rather than a credential acting
   * on its own. A Response is the refusal to return.
   *
   * Three callers are refused and each for its own reason: an anonymous one has no account,
   * the system API key is not a person and owns nothing, and an AGENT KEY must not be able
   * to manage credentials -- its own least of all. It answers 401 for all three, because
   * the distinction is not one the caller can act on.
   */
  private personalPrincipal(req: Request): User | Response {
    const p = this.principal(req);
    if (!p?.user || p.kind === "agent") return json({ error: "not signed in" }, { status: 401 });
    return p.user;
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

  /**
   * Admin session or the system key. Anything else is a 401/403 and a log line.
   *
   * PUBLIC so an admin route can live beside the thing it administers. `/api/admin/index/refresh`
   * is declared in `./index.ts` next to the refresher it drives, rather than being wired
   * back through this file as a callback -- the alternative was an `onIndexRefresh` dep
   * that would make the identity module import the index builder's vocabulary. The rule it
   * enforces stays owned here, which is the part that must not be duplicated.
   */
  async asAdmin(req: Request, fn: (p: Principal) => Response | Promise<Response>): Promise<Response> {
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
    `wrapRoutes` owns the variadic-inside/generic-outside shape this discovered, and the
    three kinds of table entry. That combination is what lets a guarded table stay exactly
    as typed as the one that went in -- Bun infers `req.params` from each path literal, and
    a `Record<string, Handler>` parameter would erase that for every route in the table. The
    arguments are passed straight through, so nothing here can change what a handler
    receives.
  */
  return wrapRoutes(routes, (path, handler) => (...args: unknown[]) => {
    const req = args[0] as Request;
    if (open.has(path) || opts.authService.principal(req)) {
      return (handler as (...a: unknown[]) => unknown)(...args);
    }
    return json({ error: "not signed in" }, { status: 401 });
  });
}
