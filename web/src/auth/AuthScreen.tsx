/**
 * The only thing an anonymous visitor is ever served.
 *
 * > [!IMPORTANT] It is DELIBERATELY generic, and that is a requirement rather than a style
 * > aannarr, 2026-08-31: "must be invited! a generic page, don't disclose too much."
 * > So: no description of what this is, no library counts, no product screenshot, no
 * > mention of the stack behind it. A stranger who reaches this host learns that something
 * > lives here and that they need an invitation. Nothing else.
 *
 * The ONE thing it says beyond that is the first-run claim: on a server with no accounts at
 * all it offers to create one instead of asking for an invitation. That discloses "nobody
 * has signed up here", which the screen cannot avoid knowing if it is to offer the door --
 * and which stops being true, permanently, the moment somebody takes it.
 *
 * It ships in its OWN bundle (`web/login.html`), not as a route inside the app, so the
 * application's chunk -- which names every route and API shape it has -- is never handed
 * to somebody who is not signed in.
 *
 * There is no router here on purpose: one `location.pathname` read tells us whether this
 * is a sign-in or an invitation, and a router in the pre-auth bundle would be weight an
 * anonymous visitor pays for.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type AuthState,
  checkInvite,
  getAuthState,
  loginWithPasskey,
  passkeysAvailable,
  plexBegin,
  plexFinish,
  registerPasskey,
} from "../lib/auth-api";
import { pollPlexPin } from "../lib/plex-poll";

/**
 * `/invite/<token>` is the only path here that means anything.
 *
 * Anchored at both ends and refusing a slash inside the token: the value goes straight
 * into a request, and a loose pattern would let `/invite/a/b` present itself as the token
 * `a`. Exported so the rule can be tested without a DOM.
 */
export function inviteTokenFromPath(pathname: string): string | null {
  const m = /^\/invite\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * A caller-supplied destination, or `null` if it is not one of ours.
 *
 * > [!IMPORTANT] DELIBERATELY DUPLICATED from `safeReturnPath` in `src/lib/auth.ts`
 * > Same precedent and same reason as `decadeOf` and `personNameKey`: that module imports
 * > `node:crypto`, so a VALUE import would pull it into the pre-auth browser bundle. The
 * > two must stay identical -- the server validates what it stores against the PIN row and
 * > this validates what it acts on, and a divergence means one end accepts a destination
 * > the other refuses.
 *
 * `//evil.example` is the rejection that matters: no scheme, leading slash, passes any
 * naive `startsWith("/")` check, and a browser reads it as protocol-relative and leaves.
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length > 512) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\x00-\x20\x7f<>"'\\]/.test(value)) return null;
  return value;
}

/**
 * Where to go once the ceremony succeeds.
 *
 * > [!CAUTION] The screen's OWN paths must never be the answer, or sign-in loops
 * > The obvious fallback -- "go back to whatever is in the address bar" -- is right for a
 * > deep link and catastrophic for the two paths this screen legitimately owns. `/login`
 * > carries `?plex=<pin>` on the way back from plex.tv, so returning there re-enters the
 * > Plex wait with a spent pin; `/invite/<token>` would re-present a claimed invitation as
 * > a dead one. Both look like a broken sign-in to the person it happens to.
 *
 * Pure and exported so the loop cases are pinned by tests rather than by a browser.
 */
export function returnDestination(search: string, pathname: string): string {
  const asked = safeReturnPath(new URLSearchParams(search).get("next"));
  if (asked) return asked;
  // The address bar is the fallback, WITHOUT its query: a deep link's own path is what the
  // reader wanted, and anything in the query at this point belongs to the ceremony.
  if (pathname === "/login" || pathname.startsWith("/invite/")) return "/";
  return safeReturnPath(pathname) ?? "/";
}

/**
 * `setup` and `invite` are the SAME screen with a different first sentence and no token.
 *
 * They are two phases rather than one with an optional token because they are reached
 * differently -- one from `/invite/<token>`, one from a server that told us it has no
 * accounts -- and folding them together would put an "is the token there?" branch in the
 * one place a wrong answer creates an account under the wrong authority.
 */
type Phase =
  | { kind: "loading" }
  | { kind: "signin" }
  | { kind: "setup" }
  | { kind: "invite"; token: string; displayName: string }
  | { kind: "dead-invite" }
  | { kind: "waiting-for-plex" };

/**
 * How an anonymous visitor got here, decided from the URL and the one thing the server told
 * us. Everything that needs the network is left to the caller -- `check-invite` is "go and
 * ask about this token", not an answer about it.
 *
 * Pure and exported because the ORDER is the interesting part and it should be pinned by a
 * test rather than by reading an effect: a returning Plex tab first, then an explicit
 * invitation, and only then the first-run claim. Somebody who followed an invite link to a
 * brand-new server must redeem THAT link, not silently take the claim instead.
 */
export type EntryPoint =
  | { kind: "plex-return"; pinId: string }
  | { kind: "check-invite"; token: string }
  | { kind: "setup" }
  | { kind: "signin" };

export function entryPoint(opts: { setup: boolean; pathname: string; search: string }): EntryPoint {
  const pinId = new URLSearchParams(opts.search).get("plex");
  if (pinId) return { kind: "plex-return", pinId };
  const token = inviteTokenFromPath(opts.pathname);
  if (token) return { kind: "check-invite", token };
  return opts.setup ? { kind: "setup" } : { kind: "signin" };
}

export function AuthScreen() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plexEnabled, setPlexEnabled] = useState(false);

  const canPasskey = passkeysAvailable();

  /**
   * Signed in: leave this bundle entirely, so the server hands over the app shell.
   *
   * **To where the reader was ACTUALLY going**, which used to be a hardcoded `/`. Somebody
   * following a shared `/title/tt0096895` link was served this screen at that URL, signed
   * in, and landed on the front page -- the thing they were sent had been thrown away at
   * the last step. Harmless-looking while nothing linked in; the whole point of a link
   * preview once something does.
   *
   * Two sources, in order. `?next=` is what the preview page's sign-in button sets, and it
   * survives the Plex round trip because the server puts it back. `location.pathname` is
   * the fallback for a passkey sign-in, which never leaves this page -- so the address bar
   * still holds the deep link and no server involvement is needed at all.
   *
   * `safeReturnPath` is shared with the server rather than re-implemented, because both
   * ends must agree on what counts as ours; a client-only guard is one an attacker skips.
   */
  const enterApp = useCallback(() => {
    window.location.href = returnDestination(window.location.search, window.location.pathname);
  }, []);

  /**
   * Poll while the user is on plex.tv.
   *
   * Bounded rather than open-ended: a PIN that is never approved should stop costing
   * requests, and "that took too long" is the honest thing to say once it has.
   *
   * Declared BEFORE the mount effect that calls it, and listed in that effect's
   * dependencies. Both callbacks close over nothing that changes, so the effect still
   * runs exactly once -- which is a property of the dependencies being stable rather
   * than of a suppressed lint rule.
   */
  const pollPlex = useCallback(
    async (pinId: string) => {
      // The loop itself is in `../lib/plex-poll.ts` -- the account page runs the identical
      // wait for the LINK ceremony, and the cadence is a property of Plex's PIN flow rather
      // than of either screen. What stays here is what this screen does with the outcome.
      try {
        const res = await pollPlexPin(() => plexFinish(pinId));
        if ("done" in res) return enterApp();
        setError("that took too long -- try again");
      } catch (e) {
        setError((e as Error).message);
      }
      setPhase({ kind: "signin" });
    },
    [enterApp],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      // The failure fallback is typed as the real shape, so every optional field below is
      // read through the interface rather than through a cast that would go on compiling
      // after the server stopped sending it.
      const state = await getAuthState().catch((): AuthState => ({ authenticated: false }));
      if (!alive) return;
      if (state.authenticated) return enterApp();
      setPlexEnabled(Boolean(state.plex));

      const entry = entryPoint({
        setup: Boolean(state.setup),
        pathname: window.location.pathname,
        search: window.location.search,
      });

      // Coming back from plex.tv: the pin id rides in the query, and the browser polls
      // until the user has finished approving on Plex's own screen.
      if (entry.kind === "plex-return") {
        setPhase({ kind: "waiting-for-plex" });
        void pollPlex(entry.pinId);
        return;
      }
      // `setup` and `signin` are already the phase they name; only an invitation needs
      // asking about, and only that answer can arrive after the component is gone.
      if (entry.kind !== "check-invite") return setPhase(entry);

      const invite = await checkInvite(entry.token);
      if (!alive) return;
      if (!invite.ok) return setPhase({ kind: "dead-invite" });
      setName(invite.displayName ?? "");
      setPhase({ kind: "invite", token: entry.token, displayName: invite.displayName ?? "" });
    })();
    return () => {
      alive = false;
    };
  }, [enterApp, pollPlex]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      // A user CANCELLING the OS prompt throws too, and telling them "that did not work"
      // for a deliberate cancel is noise. The browser names that one specifically.
      const msg = (e as Error).message;
      setError(/NotAllowedError|abort/i.test(msg) ? null : msg);
    } finally {
      setBusy(false);
    }
  }, []);

  const signIn = () => run(async () => (await loginWithPasskey()) && enterApp());

  /**
   * Create an account. `token` redeems an invitation; without one this is the first-run
   * claim, and the server refuses it the instant this host has an account.
   */
  const signUp = (token?: string) =>
    run(async () => (await registerPasskey({ token, displayName: name.trim() || undefined })) && enterApp());

  const withPlex = (token?: string) =>
    run(async () => {
      // Computed BEFORE leaving: after the bounce this tab is at `/login?plex=...` and the
      // deep link the reader arrived on is no longer anywhere in the browser.
      const { authUrl } = await plexBegin(
        token,
        returnDestination(window.location.search, window.location.pathname),
      );
      window.location.href = authUrl;
    });

  // The invitation being redeemed, or undefined when this is the first-run claim. Hoisted
  // so the two buttons below cannot disagree about which of the two they are running.
  const claimToken = phase.kind === "invite" ? phase.token : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">finderr</h1>

      {phase.kind === "loading" && <p className="mt-6 text-sm text-muted">One moment…</p>}

      {phase.kind === "waiting-for-plex" && (
        <p className="mt-6 text-sm text-muted">Waiting for Plex to confirm…</p>
      )}

      {phase.kind === "signin" && (
        <>
          <p className="mt-2 text-sm text-muted">Sign in to continue.</p>
          <div className="mt-6 flex flex-col gap-3">
            {canPasskey && (
              <button type="button" onClick={signIn} disabled={busy} className={BUTTON}>
                Sign in with a passkey
              </button>
            )}
            {plexEnabled && (
              <button type="button" onClick={() => withPlex()} disabled={busy} className={SECONDARY}>
                Continue with Plex
              </button>
            )}
          </div>
          {!canPasskey && <InsecureContextNote />}
          <p className="mt-6 text-xs text-muted">Access is by invitation.</p>
        </>
      )}

      {phase.kind === "dead-invite" && (
        <>
          {/*
            One message for expired, already-used and never-existed. Telling them apart
            would turn this page into an oracle for guessing tokens, and the person who
            actually holds a dead link needs the same next step either way.
          */}
          <p className="mt-2 text-sm text-muted">That invitation is no longer valid.</p>
          <p className="mt-4 text-xs text-muted">Ask whoever sent it for a new one.</p>
        </>
      )}

      {(phase.kind === "invite" || phase.kind === "setup") && (
        <>
          {/*
            ONE form for both doors. An invitation and a first-run claim ask the reader for
            exactly the same thing -- a name and a way to sign in -- and a second copy of it
            would be the copy that stops matching when either changes.
          */}
          <p className="mt-2 text-sm text-muted">
            {phase.kind === "setup"
              ? "Nobody has an account here yet. Create the first one and it will be the administrator."
              : "You have been invited. Pick a name and set up sign-in."}
          </p>
          <label className="mt-6 block text-xs text-muted" htmlFor="displayName">
            Display name
          </label>
          <input
            id="displayName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should we call you?"
            className="mt-1 w-full rounded-xl border border-line bg-surface px-4 py-3 text-base outline-none
                       placeholder:text-muted focus:border-accent/60"
          />
          <div className="mt-4 flex flex-col gap-3">
            {canPasskey && (
              <button type="button" onClick={() => signUp(claimToken)} disabled={busy} className={BUTTON}>
                Create a passkey
              </button>
            )}
            {plexEnabled && (
              <button
                type="button"
                onClick={() => withPlex(claimToken)}
                disabled={busy}
                className={SECONDARY}
              >
                Continue with Plex
              </button>
            )}
          </div>
          {!canPasskey && <InsecureContextNote />}
        </>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">{error}</p>
      )}
    </main>
  );
}

/**
 * Why the passkey button is missing.
 *
 * The alternative -- drawing the button anyway -- produces an OS-level failure the user
 * reads as "this site is broken". Naming the cause costs one sentence and is the only
 * thing on this page that explains anything.
 */
function InsecureContextNote() {
  return (
    <p className="mt-4 text-xs text-muted">
      Passkeys need a secure (https) connection, so they are unavailable here.
    </p>
  );
}

const BUTTON = "w-full rounded-xl bg-accent px-4 py-3 text-base font-medium text-bg disabled:opacity-50";
const SECONDARY = "w-full rounded-xl border border-line bg-surface px-4 py-3 text-base disabled:opacity-50";
