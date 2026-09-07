/**
 * `/account` -- you, and everything that acts as you.
 *
 * Everything here is scoped to the caller by the SERVER, not by this component: the
 * endpoints read the session and never take a user id, so there is no id to tamper with.
 *
 * > [!IMPORTANT] THE PAGE LEADS WITH FACTS ABOUT YOU, and before 2026-09-07 it had none
 * > It was five identical bordered cards -- Plex, passkeys, sessions, notifications, agent
 * > key -- each a heading over a grey sentence over a control. Uniform weight is the absence
 * > of a design (aannarr: *"generic, random slop"*), but the deeper problem was that it was a
 * > CREDENTIALS MANAGER wearing an account page's name. Not one line on it said anything
 * > about the person reading it. Your own request count and your own daily allowance lived
 * > only on the admin page ABOUT you, so the way to learn something about yourself was to
 * > ask an administrator.
 * >
 * > The stat strip is the fix, and the reason `/api/auth/me` grew `activity` and `quota`.
 *
 * ## THE SECTION ORDER, and it is why you opened the page
 *
 * 1. **Signing in** -- passkeys and Plex. New phone, lost phone: the reason people come.
 * 2. **Open sessions** -- pairs with 1. *What can get in*, then *what is in*. Splitting the
 *    two with a switch separates two halves of one question.
 * 3. **Notifications** -- one switch, and the rhythm between two list sections.
 * 4. **Automation** -- rare, but nobody arrives here by accident.
 * 5. **Sign out** -- the exit is always the last thing on a page.
 *
 * The three ACTION ZONES this page follows are stated once, in
 * `web/src/components/settings/Section.tsx`. Read them before adding a control here.
 */

import { Clapperboard, Download, Gauge, KeyRound, MonitorSmartphone, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentKeyPanel } from "../components/AgentKeyPanel";
import { ConfirmAction } from "../components/ConfirmAction";
import { PushToggle } from "../components/PushToggle";
import { ShelfArrangement } from "../components/ShelfArrangement";
import { UserAvatar, UserBadges } from "../components/settings/Identity";
import { ACTION_COL, Empty, Row, Rows, Section } from "../components/settings/Section";
import { quotaStat, Stat, StatStrip } from "../components/settings/StatStrip";
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
  type OwnActivity,
  type PublicUser,
  passkeysAvailable,
  plexLinkBegin,
  plexLinkFinish,
  type QuotaState,
  registerPasskey,
  renameCredential,
  type SessionSummary,
  unlinkPlex,
} from "../lib/auth-api";
import { device } from "../lib/device";
import { pollPlexPin } from "../lib/plex-poll";
import { formatStamp } from "../lib/timestamps";

/**
 * Plex's mark, as a glyph rather than an `<img>`.
 *
 * Every other icon here comes from lucide, which has no Plex; the alternative was a logo
 * file, and the no-upstream-URL rule means that would have to be served from our own origin
 * and kept in step with a brand nobody here controls. A chevron in a rounded square is Plex's
 * own shape and costs nothing.
 */
function PlexMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <title>Plex</title>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 7.5 13.5 12 9 16.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One passkey.
 *
 * Its own component because it holds the ASKING flag: `ConfirmAction`'s inline variant draws
 * only the two answers, and the row is what swaps its metadata line for the question. That is
 * the whole trick -- the row keeps its height, so the thing about to be destroyed does not
 * move out from under the cursor at the moment you are asked to confirm destroying it.
 */
function PasskeyRow({
  credential,
  onRename,
  onRemove,
}: {
  credential: CredentialSummary;
  onRename: () => void;
  onRemove: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <Row
      icon={<KeyRound aria-hidden="true" />}
      title={credential.label ?? credential.deviceType ?? "passkey"}
      meta={
        asking ? (
          // Full contrast, so the row reads as a question rather than as a row that grew
          // two buttons.
          <span className="text-ink">This device can no longer sign in.</span>
        ) : (
          `added ${formatStamp(credential.createdAt, "never")} · last used ${formatStamp(credential.lastUsedAt, "never")}`
        )
      }
      /*
        A passkey that is NOT backed up dies with its device, and that is the fact worth
        drawing: it turns "I have two passkeys" into "I have one that survives a lost phone".
        Said only when it is true, so the common case is quiet -- and dropped while asking,
        because a warning about a device you are removing is no longer the point.
      */
      note={!credential.backedUp ? "This device only — it will not survive being lost" : undefined}
      action={
        <>
          {/* Safe verb first. Gone while asking: two decisions in one column is one too many. */}
          {!asking && (
            <Button type="button" size="sm" variant="ghost" onClick={onRename}>
              Rename
            </Button>
          )}
          <ConfirmAction
            variant="inline"
            onAskingChange={setAsking}
            label="Remove"
            question="This device can no longer sign in."
            confirmLabel="Yes, remove"
            busyLabel="Removing…"
            onConfirm={onRemove}
          />
        </>
      }
    />
  );
}

/** One open session. `current` is the server's word for the cookie making this very request. */
function SessionRow({ session, onEnd }: { session: SessionSummary; onEnd: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  return (
    <Row
      icon={<MonitorSmartphone aria-hidden="true" />}
      title={
        <>
          {device(session.userAgent)}
          {session.current && <span className="ml-2 text-xs text-accent">this device</span>}
        </>
      }
      meta={
        asking ? (
          <span className="text-ink">That browser will have to sign in again.</span>
        ) : (
          `since ${formatStamp(session.createdAt, "never")}`
        )
      }
      action={
        // Your OWN session has no End: signing yourself out is zone 3, at the bottom, and a
        // second way to do it here would end the session you are reading the page with.
        session.current ? undefined : (
          <ConfirmAction
            variant="inline"
            onAskingChange={setAsking}
            label="End"
            question="That browser will have to sign in again."
            confirmLabel="Yes, end it"
            busyLabel="Ending…"
            onConfirm={onEnd}
          />
        )
      }
    />
  );
}

export function AccountRoute() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activity, setActivity] = useState<OwnActivity | null>(null);
  const [quota, setQuota] = useState<QuotaState | null>(null);
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
      setActivity(me.activity);
      setQuota(me.quota);
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

  const showPlex = plexEnabled || user.plexConnected;

  return (
    <div className="flex flex-col gap-2">
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
        Held back until the numbers land rather than drawn as four zeroes: a strip that says
        "0 requested" and then corrects itself to 6 has told the reader something false.
      */}
      {activity && quota && (
        <div className="mt-4">
          <StatStrip>
            <Stat to="/requests" icon={Clapperboard} label="Requested" value={String(activity.requested)} />
            <Stat to="/requests" icon={Download} label="Still coming" value={String(activity.inFlight)} />
            {/*
              The one cell worth acting on right now, so it is the one in the accent -- and
              only while there is something there. A permanent highlight is not a highlight.
            */}
            <Stat
              to="/requests"
              icon={Sparkles}
              label="Ready to watch"
              value={String(activity.ready)}
              live={activity.ready > 0}
            />
            <Stat to="/requests" icon={Gauge} {...quotaStat(quota)} />
          </StatStrip>
        </div>
      )}

      {/*
        FIRST among the sections, above the ways in.

        Everything below is administrative -- how you sign in, which browsers hold a session,
        what to revoke. This is the one section a reader opens `/account` to CHANGE rather
        than to audit, and it is the only place in the product that offers it. That is the
        same ordering rule this file states at the top, applied to the section that arrived
        from `main` while this page was being rebuilt: order by WHY you opened the page.

        It draws its own section and loads its own state, so nothing above it needs to know
        shelves exist.

        > [!NOTE] It does NOT yet use the `Section`/`Row` idiom the rest of this page follows
        > It landed on `main` in parallel with that idiom and predates it, so it carries its
        > own chrome. Restyling somebody else's new feature blind during a merge is worse than
        > leaving it consistent with itself for now -- but it is the one thing on this page
        > that does not follow `DESIGN.md`, and it should.
      */}
      <ShelfArrangement />

      <Section
        label="Signing in"
        add={
          passkeysAvailable() && (
            <Button type="button" size="sm" onClick={addDevice} disabled={busy}>
              Add this device
            </Button>
          )
        }
      >
        {credentials.length === 0 && !showPlex ? (
          <Empty>No passkeys yet. Add one so you are not relying on a single way in.</Empty>
        ) : (
          <Rows>
            {credentials.length === 0 && (
              <Empty>No passkeys yet. Add one so you are not relying on a single way in.</Empty>
            )}
            {credentials.map((c) =>
              editing?.id === c.id ? (
                /*
                  A form, so Enter submits and Escape is the browser's own job. A bare input
                  with an onKeyDown would be a second, worse implementation of both.
                */
                <li key={c.id} className="border-b border-line/60 py-3 last:border-0">
                  <form
                    className="flex items-center gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveLabel();
                    }}
                  >
                    <Input
                      // The caret belongs in the field the click just opened -- an explicit Rename
                      // press, never page load. Not a suppression: `noAutofocus` only analyses the
                      // DOM `input` element and never a component, so a `biome-ignore` here
                      // suppresses nothing and biome reports it as unused.
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
                    {/* Same column as every other row, so the field ends where they end. */}
                    <div className={ACTION_COL}>
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                    </div>
                  </form>
                </li>
              ) : (
                <PasskeyRow
                  key={c.id}
                  credential={c}
                  onRename={() => setEditing({ id: c.id, label: c.label ?? "" })}
                  onRemove={async () => {
                    // NOT caught: the inline confirm shows the server's refusal on the row
                    // that provoked it, and "that is your only way in" is the one refusal
                    // worth reading beside the thing it is about.
                    await deleteCredential(c.id);
                    await load();
                  }}
                />
              ),
            )}

            {/*
              PLEX IS A WAY IN, so it is a row in this section rather than a section of its
              own. It had its own card, which framed "how I sign in" as two unrelated
              concerns -- and an account with no passkey and a live Plex link is not locked
              out, which is only obvious when the two sit together.
            */}
            {showPlex && (
              <Row
                icon={<PlexMark />}
                title="Plex"
                meta={
                  user.plexConnected
                    ? `Connected as ${user.plexUsername ?? "your Plex account"}`
                    : "Not connected. Connecting one lets you sign in with Plex as well as with a passkey."
                }
                action={
                  user.plexConnected ? (
                    <ConfirmAction
                      variant="inline"
                      label="Disconnect"
                      question="Disconnect Plex?"
                      confirmLabel="Yes, disconnect"
                      busyLabel="Disconnecting…"
                      // The 409 saying Plex is your only way in is shown by the control that
                      // provoked it -- same rule as the last-passkey refusal.
                      onConfirm={async () => {
                        await unlinkPlex();
                        await load();
                      }}
                    />
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={connectPlex}
                      disabled={linkingPlex || !plexEnabled}
                    >
                      {linkingPlex ? "Waiting for Plex…" : "Connect"}
                    </Button>
                  )
                }
              />
            )}
          </Rows>
        )}

        {!passkeysAvailable() && (
          <p className="mt-3 text-xs text-muted">
            Passkeys need a secure (https) connection, so one cannot be added from here.
          </p>
        )}
      </Section>

      <Section label="Open sessions">
        {sessions.length === 0 ? (
          <Empty>No open sessions.</Empty>
        ) : (
          <Rows>
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onEnd={async () => {
                  await deleteSession(s.id);
                  await load();
                }}
              />
            ))}
          </Rows>
        )}
      </Section>

      <PushToggle />

      <AgentKeyPanel />

      {/*
        A refusal, drawn as one. It was `text-muted` -- the same grey as every explanatory
        line on the page -- so a server declining to do what you asked read as a footnote.
        Only what NO single control owns lands here; a row's refusal stays on its row.
      */}
      {error && (
        <p className="mt-6 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {/*
        ZONE 3: the whole page is its subject, so it is bottom, alone, with nothing under it.
        Not in a section -- a heading would give the way out the same weight as the things
        this page is actually for.
      */}
      <div className="mt-10 border-t border-line pt-6">
        <Button type="button" variant="outline" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
