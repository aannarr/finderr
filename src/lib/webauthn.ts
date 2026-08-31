/**
 * The passkey ceremonies.
 *
 * Four calls -- register begin/finish, login begin/finish -- over `@simplewebauthn/server`.
 * The library is not optional and must not be hand-rolled around: converting base64url to
 * ArrayBuffer by hand is the classic way to ship a flow that works in Chrome and fails in
 * Safari, and that conversion is most of what this dependency exists for.
 *
 * > [!IMPORTANT] The verifiers THROW, they do not return `{ verified: false }`
 * > Every mismatch -- wrong origin, wrong rpId, replayed challenge, bad signature -- comes
 * > out as an exception. An uncaught one in a route handler is a bare 500 with an empty
 * > body, which makes the route most likely to fail the one least able to say why. So
 * > everything here is wrapped and rethrown as `AuthError`, which carries a GENERIC message
 * > for the caller and the real detail for the log.
 *
 * > [!CAUTION] A failed registration strands a REAL passkey on the user's device
 * > The authenticator creates and saves its passkey BEFORE the server verifies anything, so
 * > every registration that dies server-side leaves a working credential in somebody's
 * > keychain that we have never heard of. It cannot be removed remotely. That is why
 * > `userDisplayName` is always set (it is one of the two fields the OS picker renders --
 * > without it the chooser is a column of identical blank rows) and why the login failure
 * > below names the innocent cause. Measured elsewhere: two failed registrations left THREE
 * > passkeys in Apple Passwords against ONE row in the database.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { hashToken, isoIn, newToken, type Role, type User } from "./auth";
import type { AuthStore } from "./auth-store";
import type { Config } from "./config";

/**
 * A refusal the caller may see, and a reason only the log may.
 *
 * The split is the whole point. finderr is destined for the public internet, so the
 * browser is told one thing for every failure -- "that did not work" -- while the log gets
 * the origin mismatch or the missing credential id that says which. Echoing verifier
 * messages to the caller is right for a single-tenant tool behind a LAN and wrong here.
 */
export class AuthError extends Error {
  constructor(
    readonly detail: string,
    message = "authentication failed",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** How long a ceremony may sit half-finished. Long enough to find a phone, short enough to matter. */
const CHALLENGE_TTL_MS = 5 * 60_000;

export interface BeginResult {
  /** Opaque handle the client returns with the finish call. The challenge stays server-side. */
  handle: string;
  options: unknown;
}

export class PasskeyService {
  constructor(
    private readonly auth: AuthStore,
    private readonly cfg: Config,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private get rpID(): string {
    return this.cfg.auth.rpId;
  }

  /**
   * Begin a registration.
   *
   * Two callers, and the difference is which of the two optional arguments is set: an
   * INVITE being redeemed (no user row yet -- the id is minted here and written only at
   * finish, so a browser that walks away leaves nothing behind), or an existing user adding
   * a second device.
   */
  async beginRegistration(input: {
    invite?: { tokenHash: string; role: Role; displayName: string | null };
    user?: User;
    displayName?: string;
  }): Promise<BeginResult> {
    const userId = input.user?.id ?? newToken(12);
    const displayName =
      input.user?.displayName ?? input.displayName?.trim() ?? input.invite?.displayName ?? "finderr user";

    const options = await generateRegistrationOptions({
      rpName: this.cfg.auth.rpName,
      rpID: this.rpID,
      userID: new TextEncoder().encode(userId),
      userName: displayName,
      // ALWAYS set. It is one of the two fields the OS picker shows, and the difference
      // between a readable chooser and three indistinguishable blank rows when a previous
      // attempt has stranded credentials on the device.
      userDisplayName: displayName,
      attestationType: "none",
      // So the authenticator replaces its own entry rather than adding a duplicate when a
      // user re-registers a device they already have.
      excludeCredentials: input.user
        ? this.auth.credentialsFor(input.user.id).map((c) => ({ id: c.id }))
        : [],
      authenticatorSelection: {
        // The phone or the laptop in the user's hand, not a roaming USB key.
        authenticatorAttachment: "platform",
        // Discoverable, which is what removes the username field from the sign-in screen
        // entirely -- and with it the input an attacker would enumerate accounts against.
        residentKey: "required",
        requireResidentKey: true,
        // `preferred`, not `required`: the invite is what gates access, biometric is a
        // bonus, and `required` hard-fails on a laptop with no Touch ID.
        userVerification: "preferred",
      },
    });

    const handle = this.auth.putChallenge({
      challenge: options.challenge,
      kind: "register",
      userId,
      inviteHash: input.invite?.tokenHash ?? null,
      displayName,
      expiresAt: isoIn(CHALLENGE_TTL_MS),
    });
    return { handle, options };
  }

  /**
   * Finish a registration, creating the user if this was an invite.
   *
   * ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE: claim the invite (one statement, no
   * foreign key touched), then create the user, then attribute. Writing `redeemed_by` in
   * the claim fails the foreign key because the user does not exist yet; creating the user
   * first leaves an orphan account every time the claim loses a race.
   */
  async finishRegistration(input: {
    handle: string;
    response: Record<string, unknown>;
    label?: string | null;
  }): Promise<{ user: User; credentialId: string }> {
    const challenge = this.auth.takeChallenge(input.handle);
    if (challenge?.kind !== "register")
      throw new AuthError(
        `no live registration challenge for handle ${input.handle}`,
        "that sign-up link expired",
      );

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        // The library's response type is a closed union of JSON shapes; the route has
        // already established this came in as an object and the verifier itself is the
        // real validator -- a bad shape throws, which is the path we want anyway.
        response: input.response as never,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.cfg.auth.origins,
        expectedRPID: this.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new AuthError(
        `registration verify threw: ${(err as Error).message}`,
        "that passkey could not be registered",
      );
    }
    if (!verification.verified || !verification.registrationInfo)
      throw new AuthError("registration verify returned unverified", "that passkey could not be registered");

    const info = verification.registrationInfo;
    const userId = challenge.userId ?? newToken(12);

    let user: User | null = null;
    if (challenge.inviteHash) {
      const invite = this.auth.claimInvite(challenge.inviteHash);
      if (!invite)
        throw new AuthError(
          `invite ${challenge.inviteHash.slice(0, 8)} was already redeemed or has expired`,
          "that invitation is no longer valid",
        );
      user = this.auth.createUser({
        id: userId,
        displayName: challenge.displayName ?? invite.displayName ?? "finderr user",
        role: invite.role,
      });
      // Step 3. Survivable if it fails: a working account is worth more than the receipt.
      try {
        this.auth.attributeInvite(challenge.inviteHash, user.id);
      } catch (err) {
        this.log(`invite attribution failed (account is fine): ${(err as Error).message}`);
      }
    } else {
      user = this.auth.getUser(userId);
      if (!user) throw new AuthError(`registration for unknown user ${userId}`, "that sign-up link expired");
    }

    this.auth.addCredential({
      id: info.credential.id,
      userId: user.id,
      // base64url TEXT. See the schema comment for why this is not a BLOB.
      publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType ?? null,
      backedUp: info.credentialBackedUp ?? false,
      label: input.label?.trim() || null,
    });

    return { user, credentialId: info.credential.id };
  }

  /**
   * Begin a login.
   *
   * `allowCredentials` is deliberately absent. With discoverable credentials the
   * authenticator offers whatever passkey it holds for this rpID, so the server is never
   * told who is signing in -- which means there is no username field to enumerate accounts
   * against and no way to learn which credential ids are real.
   */
  async beginLogin(): Promise<BeginResult> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "preferred",
    });
    const handle = this.auth.putChallenge({
      challenge: options.challenge,
      kind: "login",
      expiresAt: isoIn(CHALLENGE_TTL_MS),
    });
    return { handle, options };
  }

  /**
   * Finish a login.
   *
   * ONE ERROR for "no such credential" and "bad signature" alike -- telling them apart
   * tells an attacker which credential ids are real. The message still names the innocent
   * cause, because the common case is genuinely a leftover passkey from a sign-up that
   * failed part way, and a user who knows that can delete it and try the next one.
   */
  async finishLogin(input: { handle: string; response: Record<string, unknown> }): Promise<User> {
    const challenge = this.auth.takeChallenge(input.handle);
    if (challenge?.kind !== "login")
      throw new AuthError(`no live login challenge for handle ${input.handle}`, LOGIN_REFUSED);

    const credentialId = typeof input.response.id === "string" ? input.response.id : "";
    const credential = credentialId ? this.auth.getCredential(credentialId) : null;
    if (!credential) throw new AuthError(`unknown credential ${credentialId.slice(0, 12)}`, LOGIN_REFUSED);

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response as never,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.cfg.auth.origins,
        expectedRPID: this.rpID,
        credential: {
          id: credential.id,
          publicKey: unb64url(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports as never,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      throw new AuthError(`login verify threw: ${(err as Error).message}`, LOGIN_REFUSED);
    }
    if (!verification.verified) throw new AuthError("login verify returned unverified", LOGIN_REFUSED);

    const user = this.auth.getUser(credential.userId);
    if (!user) throw new AuthError(`credential ${credential.id.slice(0, 12)} has no user`, LOGIN_REFUSED);
    if (user.disabledAt !== null) throw new AuthError(`user ${user.id} is disabled`, LOGIN_REFUSED);

    // Recorded, never gated on. Most platform authenticators pin the counter at 0 forever,
    // so refusing a non-incrementing one locks out every Apple passkey.
    this.auth.markCredentialUsed(credential.id, verification.authenticationInfo.newCounter);
    return user;
  }
}

/**
 * The one thing a failed sign-in ever says.
 *
 * It names the innocent cause without confirming anything: a reader with three passkeys
 * saved for this site learns what to do, and an attacker learns nothing about which
 * credential ids exist.
 */
const LOGIN_REFUSED =
  "That passkey is not registered here. If you have more than one saved for this site, the extras are left over from a sign-up that failed part way -- delete them and try another.";

/**
 * base64url -> bytes, with the return type spelt out.
 *
 * TypeScript widens a bare `Uint8Array` to `Uint8Array<ArrayBufferLike>`, which
 * `@simplewebauthn`'s `publicKey` rejects -- a `SharedArrayBuffer` has no `resize`, so the
 * two are genuinely different types and the annotation is not decoration.
 */
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Hash an invite token the same way the store does, for callers holding the raw token. */
export const inviteHash = hashToken;
