/**
 * `/account` -- your devices and your open sessions.
 *
 * Everything here is scoped to the caller by the SERVER, not by this component: the
 * endpoints read the session and never take a user id, so there is no id to tamper with.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type CredentialSummary,
  deleteCredential,
  deleteSession,
  getAuthState,
  getMe,
  logout,
  type PublicUser,
  passkeysAvailable,
  plexLinkBegin,
  plexLinkFinish,
  registerPasskey,
  renameCredential,
  type SessionSummary,
  unlinkPlex,
} from "../lib/auth-api";
import { pollPlexPin } from "../lib/plex-poll";

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Enough of a user agent to tell a phone from a laptop, and no more. */
function device(ua: string | null): string {
  if (!ua) return "unknown device";
  if (/iPhone|Android.*Mobile/.test(ua)) return "phone";
  if (/iPad|Tablet/.test(ua)) return "tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "browser";
}

export function AccountRoute() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Is Plex configured at all? No point offering to connect to a server that is not there. */
  const [plexEnabled, setPlexEnabled] = useState(false);
  /** Set while the browser is waiting on plex.tv, so the button can say so. */
  const [linkingPlex, setLinkingPlex] = useState(false);
  /** Which passkey is being renamed, and to what. Null means nothing is being edited. */
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me.user);
      setCredentials(me.credentials);
      setSessions(me.sessions);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // `/api/auth/state` is what knows whether Plex is configured. It is a separate call
    // from `getMe` because it is the same question the sign-in screen asks, answered by the
    // same route -- a second copy on the account payload would be a second thing to keep true.
    void getAuthState()
      .then((s) => setPlexEnabled(Boolean((s as { plex?: boolean }).plex)))
      .catch(() => setPlexEnabled(false));
  }, [load]);

  /**
   * Finish a link we started before being sent to plex.tv.
   *
   * The pin id rides back in the query, exactly as it does on the sign-in screen. The param
   * is stripped once consumed so a refresh does not re-run a ceremony that is already done
   * -- and `replaceState` rather than a navigation, because this is cleaning up a URL, not
   * moving anywhere.
   */
  useEffect(() => {
    const pinId = new URLSearchParams(window.location.search).get("plex");
    if (!pinId) return;
    window.history.replaceState({}, "", window.location.pathname);

    let alive = true;
    setLinkingPlex(true);
    void (async () => {
      try {
        const res = await pollPlexPin(() => plexLinkFinish(pinId));
        if (!alive) return;
        if (!("done" in res)) setError("that took too long -- try again");
        else await load();
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLinkingPlex(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const addDevice = async () => {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey({ label: device(navigator.userAgent) });
      await load();
    } catch (e) {
      const msg = (e as Error).message;
      if (!/NotAllowedError|abort/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteCredential(id);
      await load();
    } catch (e) {
      // The server refuses to let you delete your only way in. That refusal is one of the
      // few a signed-in user is given a real reason for, so it is shown verbatim.
      setError((e as Error).message);
    }
  };

  const saveLabel = async () => {
    if (!editing) return;
    const { id, label } = editing;
    setEditing(null);
    setError(null);
    try {
      // An emptied field CLEARS the name rather than storing "": the server maps both to
      // NULL and the row falls back to its device type, so there is one spelling of "no
      // name" and no blank row to wonder about.
      await renameCredential(id, label.trim() || null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const connectPlex = async () => {
    setError(null);
    setLinkingPlex(true);
    try {
      const { authUrl } = await plexLinkBegin();
      // A full navigation rather than a popup: a popup is the thing every browser blocks
      // and every phone handles differently, and Plex sends us straight back here.
      window.location.href = authUrl;
    } catch (e) {
      setError((e as Error).message);
      setLinkingPlex(false);
    }
  };

  const disconnectPlex = async () => {
    setError(null);
    try {
      await unlinkPlex();
      await load();
    } catch (e) {
      // The 409 that says Plex is your only way in is shown verbatim -- same rule as the
      // last-passkey refusal, and the same reason: it is actionable.
      setError((e as Error).message);
    }
  };

  const endSession = async (id: string) => {
    await deleteSession(id).catch((e) => setError((e as Error).message));
    await load();
  };

  const signOut = async () => {
    await logout();
    window.location.href = "/";
  };

  if (!user) return <p className="text-sm text-muted">{error ?? "Loading…"}</p>;

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-xl font-semibold tracking-tight">{user.displayName}</h1>
        <p className="mt-1 text-sm text-muted">
          {user.role === "admin" ? "Administrator" : "Member"} · joined {when(user.createdAt)}
        </p>
      </section>

      {/*
        Plex was a fact in the subtitle line above and nothing more -- you could sign in
        with it and never see it again, and a broken link had no repair short of asking an
        admin to reset the whole account. It is a section because it is now something you
        can DO, and its two states carry different actions.
      */}
      {(plexEnabled || user.plexConnected) && (
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Plex</h2>
            {!user.plexConnected ? (
              <button
                type="button"
                onClick={connectPlex}
                disabled={linkingPlex || !plexEnabled}
                className={LINK_BUTTON}
              >
                {linkingPlex ? "Waiting for Plex…" : "Connect"}
              </button>
            ) : (
              <button type="button" onClick={disconnectPlex} className={LINK_BUTTON}>
                Disconnect
              </button>
            )}
          </div>
          <p className="mt-2 text-sm text-muted">
            {!user.plexConnected
              ? "Not connected. Connecting one lets you sign in with Plex as well as with a passkey."
              : `Connected as ${user.plexUsername ?? "your Plex account"}.`}
          </p>
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Passkeys</h2>
          {passkeysAvailable() && (
            <button type="button" onClick={addDevice} disabled={busy} className={LINK_BUTTON}>
              Add this device
            </button>
          )}
        </div>
        {/*
          One passkey per device is the point: a lost phone must not be a lockout, so the
          empty state here is worth flagging rather than leaving blank.
        */}
        {credentials.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No passkeys yet. Add one so you are not relying on a single way in.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {credentials.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2"
              >
                {editing?.id === c.id ? (
                  /*
                    A form, so Enter submits and Escape is the browser's own job. A bare
                    input with an onKeyDown would be a second, worse implementation of both.
                  */
                  <form
                    className="flex flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveLabel();
                    }}
                  >
                    <input
                      // The caret belongs in the field the click just opened.
                      autoFocus
                      value={editing.label}
                      maxLength={60}
                      onChange={(e) => setEditing({ id: c.id, label: e.target.value })}
                      // Blur saves rather than discarding: clicking away from a rename is
                      // far more often "done" than "cancel", and the value is one word.
                      onBlur={() => void saveLabel()}
                      aria-label="Passkey name"
                      className="min-w-0 flex-1 rounded border border-line bg-surface-2 px-2 py-1 text-sm outline-none focus:border-accent/60"
                    />
                    <button type="submit" className={LINK_BUTTON}>
                      Save
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 truncate text-sm">
                      {c.label ?? c.deviceType ?? "passkey"}
                      <span className="text-muted">
                        {" "}
                        · added {when(c.createdAt)} · last used {when(c.lastUsedAt)}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-3">
                      {/*
                        Renaming is what makes the Remove button next to it usable. Two rows
                        both reading "Mac · added 3 Aug" are two rows nobody can revoke with
                        any confidence, and the label is a guess from the user agent.
                      */}
                      <button
                        type="button"
                        onClick={() => setEditing({ id: c.id, label: c.label ?? "" })}
                        className={LINK_BUTTON}
                      >
                        Rename
                      </button>
                      <button type="button" onClick={() => remove(c.id)} className={LINK_BUTTON}>
                        Remove
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {!passkeysAvailable() && (
          <p className="mt-2 text-xs text-muted">
            Passkeys need a secure (https) connection, so one cannot be added from here.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium">Signed in on</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2"
            >
              <span className="text-sm">
                {device(s.userAgent)}
                <span className="text-muted">
                  {" "}
                  · since {when(s.createdAt)}
                  {s.current ? " · this device" : ""}
                </span>
              </span>
              {!s.current && (
                <button type="button" onClick={() => endSession(s.id)} className={LINK_BUTTON}>
                  End
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {error && <p className="text-sm text-muted">{error}</p>}

      <section>
        <button type="button" onClick={signOut} className={LINK_BUTTON}>
          Sign out
        </button>
      </section>
    </div>
  );
}

const LINK_BUTTON = "text-sm text-muted underline underline-offset-4 hover:text-ink";
