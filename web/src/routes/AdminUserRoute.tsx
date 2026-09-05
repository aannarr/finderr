/**
 * `/admin/users/:id` -- one person, whole.
 *
 * Three blocks, and they are the three questions an operator has about somebody: who are
 * they, how do they get in, and what have they been doing. All of it from ONE call --
 * `GET /api/admin/users/:id`, the admin-scoped twin of `/api/auth/me` -- so the page renders
 * in one step rather than four, and there is one endpoint to keep authorised.
 *
 * > [!IMPORTANT] READ ONLY, DELIBERATELY, AND NOT AS AN OVERSIGHT
 * > There is no promote, no disable, no reset, no remove, and no button beside a passkey or
 * > a session. Every one of those is destructive or destructive-adjacent, every one of them
 * > needs a confirmation, and they arrive together in
 * > `admin-user-actions-per-user-quota-and-the-assistant-toggle` so that all five get the
 * > same treatment once. One of them landing early would be the unconfirmed click this
 * > redesign exists to remove.
 */

import { Link, useParams } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import {
  type AdminUserDetail,
  type AttributedRequest,
  type CredentialSummary,
  getAdminUser,
  type QuotaState,
  type SessionSummary,
} from "../lib/auth-api";
import { device } from "../lib/device";
import { logOrder, seasonLine } from "../lib/request-log";
import { formatAge, formatStamp } from "../lib/timestamps";
import { useAsyncData } from "../lib/use-async-data";

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

function Passkey({ credential }: { credential: CredentialSummary }) {
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
    </li>
  );
}

function Session({ session }: { session: SessionSummary }) {
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
    </li>
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

/** The whole page from props alone, so it can be asserted without a fetch. */
export function AdminUserView({ detail }: { detail: AdminUserDetail }) {
  return (
    <div className="flex flex-col gap-8">
      <Identity user={detail.user} />

      <Block title="Passkeys">
        <Rows empty="No passkeys. They sign in another way, or not at all.">
          {detail.credentials.map((c) => (
            <Passkey key={c.id} credential={c} />
          ))}
        </Rows>
      </Block>

      <Block title="Signed in on">
        <Rows empty="No open sessions.">
          {detail.sessions.map((s) => (
            <Session key={s.id} session={s} />
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
  // Keyed on `id`, so walking from one person to the next refetches rather than redrawing
  // the one before.
  const load = useCallback(() => getAdminUser(id), [id]);
  const { data, error } = useAsyncData(load);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
  return <AdminUserView detail={data} />;
}
