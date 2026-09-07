/**
 * `/admin/users/:id` -- one person, whole, and everything an operator may do to them.
 *
 * Six blocks answering the questions an operator has about somebody: who are they, what may
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
 *
 * > [!NOTE] THE LAYOUT IS TWO COLUMNS AND THE SPLIT IS BY WHO ASKS, not by size
 * > The wide column is what an operator came to CHANGE -- the actions and the two settings --
 * > and the rail is what they came to CHECK: how this person gets in, and what they have been
 * > doing. The single scrolling column this replaced put "Remove this account" and "they have
 * > one passkey, on a device that will not survive being lost" nine hundred pixels apart, and
 * > the second is the fact that should stop the first.
 */

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AdminCard, Empty } from "../components/admin/AdminCard";
import { UserAvatar, UserBadges } from "../components/admin/UserIdentity";
import { ConfirmAction } from "../components/ConfirmAction";
import { QuotaField, ToggleSetting } from "../components/SettingControls";
import { ShowOnceSecret } from "../components/ShowOnceSecret";
import { Separator } from "../components/ui/separator";
import {
  type AdminQuotaState,
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
import { count } from "../lib/units";
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

/**
 * A row inside a card -- a passkey, a session.
 *
 * The FACT is on the left and its verb on the right, which is what makes a stack of them
 * scannable: one column of names, one column of controls. They were one baseline before, so
 * "Revoke" landed at a different x on every row depending on how long the device name was.
 */
function Row({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
      <div className="min-w-0 text-sm">{children}</div>
      {action}
    </li>
  );
}

function Rows({ empty, children }: { empty: string; children: React.ReactNode[] }) {
  if (children.length === 0) return <Empty>{empty}</Empty>;
  return <ul className="flex flex-col gap-2">{children}</ul>;
}

/**
 * The header: who this is, at a size that answers "am I on the right person" from across the
 * room.
 *
 * It carries the DISC as well as the name, and that is the whole reason the disc exists -- an
 * operator arrives here from a list of thirteen and the next thing they do is destructive.
 */
function Identity({ user }: Pick<AdminUserDetail, "user">) {
  return (
    <section className="flex items-start gap-4">
      <UserAvatar user={user} size="lg" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{user.displayName}</h1>
          <UserBadges user={user} />
        </div>
        {/*
          The ROLE is only in this line for a member, because an administrator already wears
          the badge beside their name -- printing "Administrator · Administrator" one line
          apart was the first thing a browser showed. A member has no badge (a pill reading
          "Member" on every ordinary account is noise), so the word has to live somewhere and
          this is it.
        */}
        <p className="mt-1 text-sm text-muted">
          {user.role === "admin" ? "" : "Member · "}joined {formatStamp(user.createdAt, "never")} · last seen{" "}
          {formatStamp(user.lastSeenAt, "never")}
        </p>
        {/*
          Plex is a way IN as much as a way to watch, so it belongs in the identity line rather
          than under access: an account with a broken passkey and a live Plex link is not
          locked out, and an operator reading this needs to know that before resetting anything.
        */}
        <p className="mt-0.5 text-sm text-muted">
          {user.plexConnected
            ? `Plex connected as ${user.plexUsername ?? "an unnamed account"}.`
            : "No Plex account connected."}
        </p>
      </div>
    </section>
  );
}

function Passkey({ credential, acting }: { credential: CredentialSummary; acting: Acting }) {
  return (
    <Row
      action={
        /*
          NO "that is their last way in" GUARD, unlike the self-service route on the account
          page. Somebody removing their own last passkey has locked themselves out by accident;
          an admin revoking one is doing it BECAUSE the device is gone, and the way back in is
          the invite "Reset access" mints.
        */
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
      }
    >
      <span className="block truncate text-ink">
        {credential.label ?? credential.deviceType ?? "passkey"}
      </span>
      <span className="text-xs text-muted">
        added {formatStamp(credential.createdAt, "never")} · last used{" "}
        {formatStamp(credential.lastUsedAt, "never")}
        {/*
          A passkey that is NOT backed up dies with its device, and that is the fact worth
          drawing: it is what turns "they have three passkeys" into "they have one that
          survives a lost phone". Said only when it is true, so the common case is quiet.
        */}
        {!credential.backedUp && <span className="text-warn"> · this device only</span>}
      </span>
    </Row>
  );
}

function Session({ session, acting }: { session: SessionSummary; acting: Acting }) {
  return (
    <Row
      action={
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
      }
    >
      <span className="block truncate text-ink">
        {device(session.userAgent)}
        {/* True only when an admin is reading their OWN page. The server decides which. */}
        {session.current && <span className="text-accent"> · this device</span>}
      </span>
      <span className="text-xs text-muted">
        since {formatStamp(session.createdAt, "never")} · last seen {formatStamp(session.lastSeenAt, "never")}
      </span>
    </Row>
  );
}

/**
 * The four things an operator may DO to somebody, each behind its own confirmation.
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
 *
 * > [!NOTE] They are NOT in a `⋯` menu, and that was considered
 * > A dropdown is what this shape usually gets, and it is wrong here for one reason: a menu
 * > renders nothing until it is opened, so the page cannot be READ -- by an operator scanning
 * > it or by the test that pins every verb's resting state -- without driving it. Four
 * > buttons an operator can see is worth more than four they have to go looking for, on the
 * > one screen where knowing what is possible matters before choosing.
 */
function Actions({ acting }: { acting: Acting }) {
  const { user, reload } = acting;
  const [invite, setInvite] = useState<string | null>(null);
  const admin = user.role === "admin";

  return (
    <AdminCard
      title="Actions"
      description="Every one of these asks before it happens. Removing an account cannot be undone."
    >
      <div className="flex flex-col gap-2.5">
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

        {/* The one that destroys something is separated, so it is never the button under the
            cursor after the one above it settles. */}
        <Separator className="my-1" />

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
    </AdminCard>
  );
}

/**
 * What has been DECIDED for this person, as opposed to what is true about them.
 *
 * Two settings today and neither is destructive, so neither asks: turning the assistant off
 * is undone by pressing the same button again, and a quota is a number you retype. The
 * confirmations are for the block above.
 */
function Settings({ acting, quota }: { acting: Acting; quota: AdminQuotaState }) {
  return (
    <AdminCard title="Settings" description="What this one person is allowed, whatever the site says.">
      <div className="flex flex-col gap-5">
        <QuotaSetting acting={acting} quota={quota} />
        <Separator />
        <AssistantSetting acting={acting} />
      </div>
    </AdminCard>
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
 *
 * The FIELD is `QuotaField`, shared with the site-wide default on `/admin`. What is here is
 * what makes this one about a PERSON: the draft starts at their effective limit, and clearing
 * the override is offered only while they have one.
 */
function QuotaSetting({ acting, quota }: { acting: Acting; quota: AdminQuotaState }) {
  const { user, reload } = acting;

  return (
    <QuotaField
      id="quota"
      label="Daily request limit"
      value={user.quotaPerDay}
      // The site's own answer, RESOLVED into words rather than shown as a number the reader
      // has to interpret -- "Follow the site default (0)" is the magic-value problem back
      // again, one level up.
      inheritLabel={`Follow the site default (${quota.siteLimitPerDay === 0 ? "no limit" : `${quota.siteLimitPerDay} a day`})`}
      save={async (quotaPerDay) => {
        await patchUser(user.id, { quotaPerDay });
        await reload();
      }}
    >
      Administrators are never limited, whatever this says.
    </QuotaField>
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

  return (
    <ToggleSetting
      label="Assistant"
      on={user.assistantAllowed}
      action={(on) => (on ? "Turn off for this person" : "Turn on for this person")}
      save={async (assistantAllowed) => {
        await patchUser(user.id, { assistantAllowed });
        await reload();
      }}
    >
      {user.assistantAllowed
        ? "They can ask the assistant, which sends their question to a model outside this house."
        : "Off. They see no assistant at all, as if this instance had none."}
    </ToggleSetting>
  );
}

function Request({ request }: { request: AttributedRequest }) {
  const seasons = seasonLine(request);
  return (
    <Row
      action={
        <span className="text-xs text-muted tabular-nums" title={formatStamp(request.created_at)}>
          {request.status} · {formatAge(request.created_at)}
        </span>
      }
    >
      {/* The way back to the thing itself -- same rule as `/log`: a row that only reported a
          state would be a dead end. */}
      <Link to="/title/$tconst" params={{ tconst: request.tconst }} className="text-ink hover:underline">
        {request.title}
      </Link>
      {request.year !== null && <span className="ml-2 text-xs text-muted">{request.year}</span>}
      {seasons && <span className="ml-2 text-xs text-muted">{seasons}</span>}
    </Row>
  );
}

/**
 * Where this person stands against the daily limit, in one sentence.
 *
 * `applies` comes from the SERVER, because the exemptions -- an admin, and a limit of zero --
 * belong to the request rule (`src/lib/request-quota.ts`) and not to a screen. Which of the
 * two exemptions fired is deliberately not spelled out here: it would be this page
 * re-deriving the rule it was just handed the answer to.
 *
 * A SIBLING OF `quotaSummary`, not a duplicate of it. That one is what a reader is told about
 * THEMSELVES above their own downloads, so it is a compact chip and says nothing at all when
 * no limit applies. This is one administrator reading about somebody else, where "no daily
 * limit applies to this account" is exactly the fact they came for. Both read `QuotaState`, so
 * the two sentences can never describe different allowances.
 */
function quotaLine(quota: QuotaState): string {
  const used = `${count(quota.usedToday, "title")} today`;
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
    <div className="flex flex-col gap-6">
      <Identity user={detail.user} />

      {/*
        THE COLUMNS ARE SPLIT ON HOW MUCH WIDTH THE CONTENT NEEDS, and the first version of
        this had it backwards (aannarr, 2026-09-07: *"actions is the SMALLEST .. and should
        live on the right, in a small panel"*).

        It was split on WHO ASKS -- change on the left, check on the right -- which is a
        sound idea and the wrong axis, because the two do not correlate with width. Actions
        is four stacked buttons and the widest thing in it is "Remove this account", so a
        full-width card left two thirds of a row empty on every screen. Meanwhile passkey
        rows (a device name, two stamps and a Revoke) and request rows (a title, a year, a
        status and an age) were truncating in a 22rem rail.

        So: the RAIL is the narrow panel and holds Actions alone, and everything with rows
        in it gets the wide column. `lg` rather than `md` still, for the same reason as
        before -- at md both columns are too narrow and one column that reads beats two
        that do not.

        Order down the wide column is what an operator reads in order: how they get in (the
        access state, which is what should stop a destructive action), then what they are
        allowed, then what they have actually done.
      */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] lg:items-start">
        <div className="flex flex-col gap-4">
          <AdminCard title="How they get in">
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="mb-2 text-[0.7rem] font-medium uppercase tracking-wider text-muted">
                  Passkeys
                </h3>
                <Rows empty="No passkeys. They sign in another way, or not at all.">
                  {detail.credentials.map((c) => (
                    <Passkey key={c.id} credential={c} acting={acting} />
                  ))}
                </Rows>
              </div>

              <div>
                <h3 className="mb-2 text-[0.7rem] font-medium uppercase tracking-wider text-muted">
                  Signed in on
                </h3>
                <Rows empty="No open sessions.">
                  {detail.sessions.map((s) => (
                    <Session key={s.id} session={s} acting={acting} />
                  ))}
                </Rows>
              </div>

              {/*
                The agent key is the one credential on this page that is not a browser, and an
                operator wants to know it exists before wondering why requests arrive at 04:00.
                Present or absent only -- the token itself is stored as a sha256 and does not
                exist to be shown, to an admin least of all.
              */}
              <div>
                <h3 className="mb-2 text-[0.7rem] font-medium uppercase tracking-wider text-muted">
                  Agent key
                </h3>
                <p className="text-sm text-muted">
                  {detail.agentKey
                    ? `A ${detail.agentKey.readOnly ? "read-only" : "read and write"} key exists, made ${formatStamp(detail.agentKey.createdAt, "never")}, last used ${formatStamp(detail.agentKey.lastUsedAt, "never")}.`
                    : "No agent key. Nothing is acting on this account's behalf."}
                </p>
              </div>
            </div>
          </AdminCard>

          <Settings acting={acting} quota={detail.quota} />

          <AdminCard title="Requests" description={quotaLine(detail.quota)}>
            <Rows empty="They have not asked for anything yet.">
              {logOrder(detail.requests).map((r) => (
                <Request key={r.tconst} request={r} />
              ))}
            </Rows>
          </AdminCard>
        </div>

        {/*
          The rail. One card, and it stays with the reader on a long page -- an operator
          scrolling a hundred requests should not have to come back up to act on what they
          just read. `top-4` clears nothing in particular; it is the page's own gap.
        */}
        <div className="lg:sticky lg:top-4">
          <Actions acting={acting} />
        </div>
      </div>
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
