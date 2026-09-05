/**
 * `/admin/users/:id` -- one person, whole, and everything an operator may do to them.
 *
 * Five blocks answering the questions an operator has about somebody: who are they, what may
 * we do about them, what have we decided for them, how do they get in, and what have they
 * been doing. The READ half arrives from ONE call -- `GET /api/admin/users/:id`, the
 * admin-scoped twin of `/api/auth/me` -- so the page renders in one step rather than four,
 * and there is one endpoint to keep authorised.
 *
 * > [!IMPORTANT] EVERY DESTRUCTIVE VERB HERE ASKS FIRST, THROUGH ONE COMPONENT
 * > `ConfirmAction` owns the two-click guard, and it is not `window.confirm` -- see its own
 * > docstring. What this page replaced put "Make admin", "Disable", "Reset access" and
 * > "Remove" inline on every row of the USER LIST, four identical-looking buttons wide with
 * > the destructive one last and unconfirmed. Doing something to somebody is a decision taken
 * > while looking at them, which is why it is here and not there.
 *
 * A refusal lands ON the control that provoked it, never at the top of the page: "that is the
 * last admin" is an answer to one button, and this page has seven.
 */

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import { ConfirmAction } from "../components/ConfirmAction";
import { ShowOnceSecret } from "../components/ShowOnceSecret";
import {
  type AdminUserDetail,
  type AttributedRequest,
  type CredentialSummary,
  deleteUser,
  getAdminUser,
  type PublicUser,
  patchUser,
  type QuotaState,
  resetUser,
  revokeUserCredential,
  revokeUserSession,
  type SessionSummary,
} from "../lib/auth-api";
import { device } from "../lib/device";
import { logOrder, seasonLine } from "../lib/request-log";
import { formatAge, formatStamp } from "../lib/timestamps";
import { LINK_BUTTON } from "../lib/ui";
import { useAsyncData } from "../lib/use-async-data";

/**
 * What every control on this page needs: who it acts on, and how to redraw afterwards.
 *
 * `reload` is awaited INSIDE each `onConfirm`, so a failure propagates to the control that
 * caused it rather than to a page-level banner. The alternative -- routing every action
 * through one `act()` -- puts "that is the last admin" at the top of the page, a screen away
 * from the button that earned it.
 */
interface Acting {
  user: PublicUser;
  reload: () => Promise<void>;
  /**
   * Delete the account and leave -- the one action with nothing to redraw afterwards.
   *
   * It is a callback rather than `deleteUser` inline because where "away" IS belongs to the
   * route: this component knows nothing about the router, and a view that navigated would
   * need one to be rendered at all.
   */
  remove: () => Promise<void>;
}

/** A titled block. Every section of this page is one, so the heading style has one owner. */
function Block(props: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium">{props.title}</h2>
      {props.children}
    </section>
  );
}

/** The rows inside a block: a bordered list, or a sentence saying why there are none. */
function Rows(props: { empty: string; children: ReactNode[] }) {
  if (props.children.length === 0) return <p className="mt-2 text-sm text-muted">{props.empty}</p>;
  return <ul className="mt-2 flex flex-col gap-2">{props.children}</ul>;
}

const ROW = "rounded-lg border border-line bg-surface px-3 py-2 text-sm";

function Identity({ user }: Pick<AdminUserDetail, "user">) {
  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">
        {user.displayName}
        {user.disabled && <span className="ml-3 align-middle text-sm text-danger">disabled</span>}
      </h1>
      <p className="mt-1 text-sm text-muted">
        {user.role === "admin" ? "Administrator" : "Member"} · joined {formatStamp(user.createdAt, "never")} ·
        last seen {formatStamp(user.lastSeenAt, "never")}
      </p>
      {/*
        Plex is a way IN as much as a way to watch, so it belongs in the identity line rather
        than under access: an account with a broken passkey and a live Plex link is not
        locked out, and an operator reading this needs to know that before resetting anything.
      */}
      <p className="mt-1 text-sm text-muted">
        {user.plexConnected
          ? `Plex connected as ${user.plexUsername ?? "an unnamed account"}.`
          : "No Plex account connected."}
      </p>
    </section>
  );
}

function Passkey({ credential, acting }: { credential: CredentialSummary; acting: Acting }) {
  return (
    <li className={ROW}>
      {credential.label ?? credential.deviceType ?? "passkey"}
      <span className="text-muted">
        {" "}
        · added {formatStamp(credential.createdAt, "never")} · last used{" "}
        {formatStamp(credential.lastUsedAt, "never")}
        {/*
          A passkey that is NOT backed up dies with its device, and that is the fact worth
          drawing: it is what turns "they have three passkeys" into "they have one that
          survives a lost phone". Said only when it is true, so the common case is quiet.
        */}
        {!credential.backedUp && " · this device only"}
      </span>
      {/*
        NO "that is their last way in" GUARD, unlike the self-service route on the account
        page. Somebody removing their own last passkey has locked themselves out by accident;
        an admin revoking one is doing it BECAUSE the device is gone, and the way back in is
        the invite "Reset access" mints.
      */}
      <ConfirmAction
        label="Revoke"
        question="Revoke this passkey? That device can never sign in again."
        confirmLabel="Yes, revoke"
        busyLabel="Revoking…"
        onConfirm={async () => {
          await revokeUserCredential(acting.user.id, credential.id);
          await acting.reload();
        }}
      />
    </li>
  );
}

function Session({ session, acting }: { session: SessionSummary; acting: Acting }) {
  return (
    <li className={ROW}>
      {device(session.userAgent)}
      <span className="text-muted">
        {" "}
        · since {formatStamp(session.createdAt, "never")} · last seen{" "}
        {formatStamp(session.lastSeenAt, "never")}
        {/* True only when an admin is reading their OWN page. The server decides which. */}
        {session.current && " · this device"}
      </span>
      <ConfirmAction
        label="Sign out"
        question="Sign this device out?"
        confirmLabel="Yes, sign it out"
        busyLabel="Signing out…"
        onConfirm={async () => {
          await revokeUserSession(acting.user.id, session.id);
          await acting.reload();
        }}
      />
    </li>
  );
}

/**
 * The five things an operator may DO to somebody, each behind its own confirmation.
 *
 * Ordered by how far they go: change what they may do, shut them out, hand them a new way
 * in, and finally take the account away. Only the last is drawn in the danger colour -- a row
 * of red would make none of them stand out, which is the wall of identical buttons the
 * confirmations exist to break up.
 *
 * The last-admin refusals are the SERVER's ("that is the last admin", 409) and are shown
 * verbatim on the control. This page deliberately does not try to predict them: it would need
 * a count of admins it was never sent, and a button that hides itself for the wrong reason is
 * worse than one that explains a refusal.
 */
function Actions({ acting }: { acting: Acting }) {
  const { user, reload } = acting;
  const [invite, setInvite] = useState<string | null>(null);
  const admin = user.role === "admin";

  return (
    <Block title="Actions">
      <div className="mt-2 flex flex-col gap-2">
        <ConfirmAction
          label={admin ? "Demote to member" : "Make administrator"}
          question={
            admin
              ? "Take administrator rights away? They will no longer see who requested what."
              : "Make them an administrator? They will be able to see who requested what, invite people, and remove accounts."
          }
          confirmLabel={admin ? "Yes, demote" : "Yes, make admin"}
          busyLabel="Saving…"
          onConfirm={async () => {
            await patchUser(user.id, { role: admin ? "user" : "admin" });
            await reload();
          }}
        />

        <ConfirmAction
          label={user.disabled ? "Enable this account" : "Disable this account"}
          question={
            user.disabled
              ? "Let them sign in again?"
              : "Disable this account? Every open session ends immediately and their passkeys stop working."
          }
          confirmLabel={user.disabled ? "Yes, enable" : "Yes, disable"}
          busyLabel="Saving…"
          onConfirm={async () => {
            await patchUser(user.id, { disabled: !user.disabled });
            await reload();
          }}
        />

        {/*
          The passkey answer to forcing a password reset, and the decisive fix for a device
          littered with stranded passkeys: with no server-side credential left, every passkey
          in their keychain is dead and there is no longer a right one to hunt for.
        */}
        <ConfirmAction
          label="Reset access"
          question="Revoke every passkey and session, break their Plex link, and mint a fresh invite?"
          confirmLabel="Yes, reset"
          busyLabel="Resetting…"
          onConfirm={async () => {
            const { url } = await resetUser(user.id);
            setInvite(url);
            await reload();
          }}
        />

        <ConfirmAction
          label="Remove this account"
          question="Remove this account for good? What they asked for stays in the log, attributed to a removed account."
          confirmLabel="Yes, remove"
          busyLabel="Removing…"
          danger
          onConfirm={() => acting.remove()}
        />
      </div>

      {/*
        The invite is shown ONCE, here, because the server does not store the token and
        cannot show it again. It outlives the confirmation on purpose: an admin who dismissed
        it before copying has to reset the account a second time.
      */}
      {invite && <ShowOnceSecret note="Their new invite link. It is not shown again." value={invite} />}
    </Block>
  );
}

/**
 * What has been DECIDED for this person, as opposed to what is true about them.
 *
 * Two settings today and neither is destructive, so neither asks: turning the assistant off
 * is undone by pressing the same button again, and a quota is a number you retype. The
 * confirmations are for the block above.
 */
function Settings({ acting, quota }: { acting: Acting; quota: QuotaState }) {
  return (
    <Block title="Settings">
      <QuotaSetting acting={acting} quota={quota} />
      <AssistantSetting acting={acting} />
    </Block>
  );
}

/**
 * Their own daily allowance, or the site's.
 *
 * A form rather than a pair of buttons because the value is a NUMBER an operator types, and
 * "follow the site default" is a separate control rather than an empty field: a blank input
 * cannot be told from one somebody has not finished typing in, and clearing the override is
 * the more common of the two edits.
 *
 * Zero is offered and explained rather than being rejected as empty -- it is what exempts one
 * person from a site-wide limit, which is the whole reason the override is nullable AND
 * allowed to be zero.
 */
function QuotaSetting({ acting, quota }: { acting: Acting; quota: QuotaState }) {
  const { user, reload } = acting;
  const [draft, setDraft] = useState(String(user.quotaPerDay ?? quota.siteLimitPerDay));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (quotaPerDay: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await patchUser(user.id, { quotaPerDay });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <form
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(draft);
          if (!Number.isInteger(n) || n < 0) {
            setError("a whole number of titles, 0 or more");
            return;
          }
          void save(n);
        }}
      >
        <label htmlFor="quota" className="text-sm">
          Titles a day
        </label>
        <input
          id="quota"
          name="quota"
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-20 rounded-lg border border-line bg-surface px-2 py-1 text-sm tabular-nums"
        />
        <button type="submit" disabled={busy} className={LINK_BUTTON}>
          {busy ? "Saving…" : "Save"}
        </button>
        {user.quotaPerDay !== null && (
          <button type="button" disabled={busy} onClick={() => void save(null)} className={LINK_BUTTON}>
            Follow the site default ({quota.siteLimitPerDay === 0 ? "unlimited" : quota.siteLimitPerDay})
          </button>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </form>
      <p className="mt-1 text-xs text-muted">
        {user.quotaPerDay === null
          ? `Following the site default${quota.siteLimitPerDay === 0 ? ", which is unlimited" : ""}.`
          : `Their own allowance${user.quotaPerDay === 0 ? ", which is unlimited" : ""}, whatever the site does.`}{" "}
        0 means no limit. Administrators are never limited.
      </p>
    </div>
  );
}

/**
 * Whether this person may use the assistant at all.
 *
 * A question typed into finderr is sent to a third party, so what somebody searches for
 * leaves the house. The deployment key says the feature EXISTS; this says whose words may
 * go. Turning it off hides the launcher rather than leaving a button that refuses.
 */
function AssistantSetting({ acting }: { acting: Acting }) {
  const { user, reload } = acting;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await patchUser(user.id, { assistantAllowed: !user.assistantAllowed });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm">Assistant</span>
        <button type="button" disabled={busy} onClick={() => void toggle()} className={LINK_BUTTON}>
          {busy ? "Saving…" : user.assistantAllowed ? "Turn off for this person" : "Turn on for this person"}
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      <p className="mt-1 text-xs text-muted">
        {user.assistantAllowed
          ? "They can ask the assistant, which sends their question to a model outside this house."
          : "Off. They see no assistant at all, as if this instance had none."}
      </p>
    </div>
  );
}

function Request({ request }: { request: AttributedRequest }) {
  const seasons = seasonLine(request);
  return (
    <li className={`${ROW} flex flex-wrap items-baseline gap-x-2 gap-y-1`}>
      {/* The way back to the thing itself -- same rule as `/log`: a row that only reported a
          state would be a dead end. */}
      <Link to="/title/$tconst" params={{ tconst: request.tconst }} className="hover:underline">
        {request.title}
      </Link>
      {request.year !== null && <span className="text-xs text-muted">{request.year}</span>}
      {seasons && <span className="text-xs text-muted">{seasons}</span>}
      <span className="ml-auto text-xs text-muted" title={formatStamp(request.created_at)}>
        {request.status} · {formatAge(request.created_at)}
      </span>
    </li>
  );
}

/**
 * Where this person stands against the daily limit, in one sentence.
 *
 * `applies` comes from the SERVER, because the exemptions -- an admin, and a limit of zero --
 * belong to the request rule (`src/lib/request-quota.ts`) and not to a screen. Which of the
 * two exemptions fired is deliberately not spelled out here: it would be this page
 * re-deriving the rule it was just handed the answer to.
 */
function quotaLine(quota: QuotaState): string {
  const used = `${quota.usedToday} title${quota.usedToday === 1 ? "" : "s"} today`;
  return quota.applies
    ? `${used}, of ${quota.limitPerDay} allowed. The allowance is replenished ${formatAge(quota.resetsAt) ?? "at midnight UTC"}.`
    : `${used}. No daily limit applies to this account.`;
}

/**
 * The whole page from props alone, so it can be asserted without a fetch.
 *
 * `acting` carries the two things the route owns and this view must not know: how to redraw
 * after a change, and where "away" is once the account is gone.
 */
export function AdminUserView({ detail, acting }: { detail: AdminUserDetail; acting: Acting }) {
  return (
    <div className="flex flex-col gap-8">
      <Identity user={detail.user} />

      <Actions acting={acting} />

      <Settings acting={acting} quota={detail.quota} />

      <Block title="Passkeys">
        <Rows empty="No passkeys. They sign in another way, or not at all.">
          {detail.credentials.map((c) => (
            <Passkey key={c.id} credential={c} acting={acting} />
          ))}
        </Rows>
      </Block>

      <Block title="Signed in on">
        <Rows empty="No open sessions.">
          {detail.sessions.map((s) => (
            <Session key={s.id} session={s} acting={acting} />
          ))}
        </Rows>
      </Block>

      <Block title="Requests">
        <p className="mt-1 text-xs text-muted">{quotaLine(detail.quota)}</p>
        <Rows empty="They have not asked for anything yet.">
          {logOrder(detail.requests).map((r) => (
            <Request key={r.tconst} request={r} />
          ))}
        </Rows>
      </Block>

      {/*
        The agent key is the one credential on this page that is not a browser, and an
        operator wants to know it exists before wondering why requests arrive at 04:00.
        Present or absent only -- the token itself is stored as a sha256 and does not exist
        to be shown, to an admin least of all.
      */}
      <Block title="Agent key">
        <p className="mt-2 text-sm text-muted">
          {detail.agentKey
            ? `A ${detail.agentKey.readOnly ? "read-only" : "read and write"} key exists, made ${formatStamp(detail.agentKey.createdAt, "never")}, last used ${formatStamp(detail.agentKey.lastUsedAt, "never")}.`
            : "No agent key. Nothing is acting on this account's behalf."}
        </p>
      </Block>
    </div>
  );
}

export function AdminUserRoute() {
  const { id } = useParams({ from: "/admin/users/$id" });
  const navigate = useNavigate();
  // Keyed on `id`, so walking from one person to the next refetches rather than redrawing
  // the one before.
  const load = useCallback(() => getAdminUser(id), [id]);
  const { data, error, reload } = useAsyncData(load);

  const remove = useCallback(async () => {
    await deleteUser(id);
    // Back to the list rather than reloading: the page this is on no longer has a subject,
    // and `getAdminUser` would answer 404 for the account we just removed.
    await navigate({ to: "/admin/users" });
  }, [id, navigate]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
  return <AdminUserView detail={data} acting={{ user: data.user, reload, remove }} />;
}
