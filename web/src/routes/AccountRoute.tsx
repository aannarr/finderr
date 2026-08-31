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
  getMe,
  logout,
  type PublicUser,
  passkeysAvailable,
  registerPasskey,
  type SessionSummary,
} from "../lib/auth-api";

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
          {user.role === "admin" ? "Administrator" : "Member"}
          {user.plexUsername ? ` · Plex: ${user.plexUsername}` : ""} · joined {when(user.createdAt)}
        </p>
      </section>

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
                className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className="text-sm">
                  {c.label ?? c.deviceType ?? "passkey"}
                  <span className="text-muted">
                    {" "}
                    · added {when(c.createdAt)} · last used {when(c.lastUsedAt)}
                  </span>
                </span>
                <button type="button" onClick={() => remove(c.id)} className={LINK_BUTTON}>
                  Remove
                </button>
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
