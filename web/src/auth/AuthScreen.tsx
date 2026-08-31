/**
 * The only thing an anonymous visitor is ever served.
 *
 * > [!IMPORTANT] It is DELIBERATELY generic, and that is a requirement rather than a style
 * > aannarr, 2026-08-31: "must be invited! a generic page, don't disclose too much."
 * > So: no description of what this is, no library counts, no product screenshot, no
 * > mention of the stack behind it. A stranger who reaches this host learns that something
 * > lives here and that they need an invitation. Nothing else.
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
  checkInvite,
  getAuthState,
  loginWithPasskey,
  passkeysAvailable,
  plexBegin,
  plexFinish,
  registerPasskey,
} from "../lib/auth-api";

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

type Phase =
  | { kind: "loading" }
  | { kind: "signin" }
  | { kind: "invite"; token: string; displayName: string }
  | { kind: "dead-invite" }
  | { kind: "waiting-for-plex" };

export function AuthScreen() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plexEnabled, setPlexEnabled] = useState(false);

  const canPasskey = passkeysAvailable();

  /** Signed in: leave this bundle entirely, so the server hands over the app shell. */
  const enterApp = useCallback(() => {
    window.location.href = "/";
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
      for (let i = 0; i < 150; i++) {
        try {
          const res = await plexFinish(pinId);
          if (!res.pending) return enterApp();
        } catch (e) {
          setError((e as Error).message);
          setPhase({ kind: "signin" });
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setError("that took too long -- try again");
      setPhase({ kind: "signin" });
    },
    [enterApp],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      const state = await getAuthState().catch(() => ({ authenticated: false }));
      if (!alive) return;
      if (state.authenticated) return enterApp();
      setPlexEnabled(Boolean((state as { plex?: boolean }).plex));

      // Coming back from plex.tv: the pin id rides in the query, and the browser polls
      // until the user has finished approving on Plex's own screen.
      const pinId = new URLSearchParams(window.location.search).get("plex");
      if (pinId) {
        setPhase({ kind: "waiting-for-plex" });
        void pollPlex(pinId);
        return;
      }

      const token = inviteTokenFromPath(window.location.pathname);
      if (!token) return setPhase({ kind: "signin" });

      const invite = await checkInvite(token);
      if (!alive) return;
      if (!invite.ok) return setPhase({ kind: "dead-invite" });
      setName(invite.displayName ?? "");
      setPhase({ kind: "invite", token, displayName: invite.displayName ?? "" });
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

  const signUp = (token: string) =>
    run(async () => (await registerPasskey({ token, displayName: name.trim() || undefined })) && enterApp());

  const withPlex = (token?: string) =>
    run(async () => {
      const { authUrl } = await plexBegin(token);
      window.location.href = authUrl;
    });

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

      {phase.kind === "invite" && (
        <>
          <p className="mt-2 text-sm text-muted">You have been invited. Pick a name and set up sign-in.</p>
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
              <button type="button" onClick={() => signUp(phase.token)} disabled={busy} className={BUTTON}>
                Create a passkey
              </button>
            )}
            {plexEnabled && (
              <button
                type="button"
                onClick={() => withPlex(phase.token)}
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
