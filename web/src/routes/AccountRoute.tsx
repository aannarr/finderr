/**
 * `/account` -- your devices and your open sessions.
 *
 * Everything here is scoped to the caller by the SERVER, not by this component: the
 * endpoints read the session and never take a user id, so there is no id to tamper with.
 */

import { useCallback, useEffect, useState } from "react";
import { AgentKeyPanel } from "../components/AgentKeyPanel";
import { AdminCard, Empty } from "../components/admin/AdminCard";
import { UserAvatar, UserBadges } from "../components/admin/UserIdentity";
import { ConfirmAction } from "../components/ConfirmAction";
import { PushToggle } from "../components/PushToggle";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { clearPersistedCaches } from "../lib/api";
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
import { device } from "../lib/device";
import { pollPlexPin } from "../lib/plex-poll";
import { formatStamp } from "../lib/timestamps";

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
    /*
      The session is gone; the CACHE ON DISK is not, and only this call ends it.

      Title rows record what the library holds and which of them this reader asked for, and
      a snapshot outlives the page load. On a shared iPad the next person to sign in would
      otherwise be handed the last one's front page for a frame. Awaited before navigating,
      because a reload mid-delete would leave it half-written.
    */
    await clearPersistedCaches();
    window.location.href = "/";
  };

  if (!user) return <p className="text-sm text-muted">{error ?? "Loading…"}</p>;

  return (
    <div className="flex flex-col gap-6">
      {/*
        THE SAME IDENTITY HEADER THE ADMIN PERSON PAGE DRAWS, from the same components.
        aannarr, 2026-09-07: *"the users own settings page MUST have same uplift as admin
        page"*. It is the same three facts about the same kind of subject -- a disc, a name,
        what they are -- and two spellings of that would drift the moment either is restyled.
      */}
      <section className="flex items-start gap-4">
        <UserAvatar user={user} size="lg" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{user.displayName}</h1>
            <UserBadges user={user} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {user.role === "admin" ? "" : "Member · "}joined {formatStamp(user.createdAt, "never")}
          </p>
        </div>
      </section>

      {/*
        Plex was a fact in the subtitle line above and nothing more -- you could sign in
        with it and never see it again, and a broken link had no repair short of asking an
        admin to reset the whole account. It is a card because it is now something you
        can DO, and its two states carry different actions.
      */}
      {(plexEnabled || user.plexConnected) && (
        <AdminCard
          title="Plex"
          action={
            !user.plexConnected ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={connectPlex}
                disabled={linkingPlex || !plexEnabled}
              >
                {linkingPlex ? "Waiting for Plex…" : "Connect"}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={disconnectPlex}>
                Disconnect
              </Button>
            )
          }
        >
          <p className="text-sm text-muted">
            {!user.plexConnected
              ? "Not connected. Connecting one lets you sign in with Plex as well as with a passkey."
              : `Connected as ${user.plexUsername ?? "your Plex account"}.`}
          </p>
        </AdminCard>
      )}

      <AdminCard
        title="Passkeys"
        description="One per device, so a lost phone is never a lockout."
        action={
          passkeysAvailable() && (
            <Button type="button" size="sm" onClick={addDevice} disabled={busy}>
              Add this device
            </Button>
          )
        }
      >
        {/*
          One passkey per device is the point: a lost phone must not be a lockout, so the
          empty state here is worth flagging rather than leaving blank.
        */}
        {credentials.length === 0 ? (
          <Empty>No passkeys yet. Add one so you are not relying on a single way in.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {credentials.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5"
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
                    <Input
                      // The caret belongs in the field the click just opened.
                      // biome-ignore lint/a11y/noAutofocus: it opens on an explicit Rename click
                      autoFocus
                      value={editing.label}
                      maxLength={60}
                      onChange={(e) => setEditing({ id: c.id, label: e.target.value })}
                      // Blur saves rather than discarding: clicking away from a rename is
                      // far more often "done" than "cancel", and the value is one word.
                      onBlur={() => void saveLabel()}
                      aria-label="Passkey name"
                      className="min-w-0 flex-1"
                    />
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 text-sm">
                      <span className="block truncate text-ink">{c.label ?? c.deviceType ?? "passkey"}</span>
                      <span className="text-xs text-muted">
                        added {formatStamp(c.createdAt, "never")} · last used{" "}
                        {formatStamp(c.lastUsedAt, "never")}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-2">
                      {/*
                        Renaming is what makes the Remove button next to it usable. Two rows
                        both reading "Mac · added 3 Aug" are two rows nobody can revoke with
                        any confidence, and the label is a guess from the user agent.
                      */}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ id: c.id, label: c.label ?? "" })}
                      >
                        Rename
                      </Button>
                      {/*
                        The one place on this page that asks first. Removing your own last
                        passkey is refused by the SERVER, but the ones it allows are still
                        gone for good and the device cannot be re-enrolled from anywhere but
                        that device.
                      */}
                      <ConfirmAction
                        label="Remove"
                        question="Remove this passkey? That device can no longer sign in."
                        confirmLabel="Yes, remove"
                        busyLabel="Removing…"
                        onConfirm={() => remove(c.id)}
                      />
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {!passkeysAvailable() && (
          <p className="mt-3 text-xs text-muted">
            Passkeys need a secure (https) connection, so one cannot be added from here.
          </p>
        )}
      </AdminCard>

      <AdminCard title="Signed in on" description="End any session that is not yours.">
        {sessions.length === 0 ? (
          <Empty>No open sessions.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5"
              >
                <span className="min-w-0 text-sm">
                  <span className="block truncate text-ink">
                    {device(s.userAgent)}
                    {s.current && <span className="text-accent"> · this device</span>}
                  </span>
                  <span className="text-xs text-muted">since {formatStamp(s.createdAt, "never")}</span>
                </span>
                {!s.current && (
                  <Button type="button" size="sm" variant="outline" onClick={() => endSession(s.id)}>
                    End
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </AdminCard>

      {/*
        A refusal, drawn as one. It was `text-muted` -- the same grey as every explanatory
        line on the page -- so "that is your only way in" read as a note rather than as the
        server having declined to do what you just asked.
      */}
      {error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {/*
        Below the devices it is about: a notification is delivered to ONE browser, so the
        switch belongs beside the list of browsers rather than in a settings page of its
        own. It draws nothing at all where push cannot work.
      */}
      <PushToggle />

      {/*
        After the devices and the notification switch, because it is the least common thing
        on this page and the one that hands out a credential. It draws its own section and
        loads its own state -- nothing above it needs to know an agent key exists.
      */}
      <AgentKeyPanel />

      {/*
        Last, and NOT in a card: it is not a setting, it is the way out. A card would give it
        the same weight as the things above it, and the things above it are what this page is
        for.
      */}
      <div>
        <Button type="button" variant="outline" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
