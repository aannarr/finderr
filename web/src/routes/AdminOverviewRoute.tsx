/**
 * `/admin` -- the shape of the household in four numbers, what an operator may set for
 * everybody, and how the server itself is doing.
 *
 * Every tile is a WAY IN rather than a readout: an operator who opens this page is on the way
 * to a person, an invitation or the log, so each figure is the link to the screen that answers
 * it. A dashboard whose numbers cannot be clicked makes the reader find the same page again by
 * hand.
 *
 * > [!IMPORTANT] Three fetches, three independent failures, and that is deliberate
 * > The tiles, the settings and `/api/health` load separately and each block renders its own
 * > error. One combined load would mean an unreachable Radarr -- which health reports on and
 * > has nothing to do with the people list -- taking the whole page down. `useAsyncData` per
 * > block is what keeps a partial answer a partial answer.
 *
 * The server half is a RENDERER over `/api/health` and must stay one. Everything it draws was
 * already collected and already returned to an admin; it was reachable only by curling the
 * endpoint with the system key, which is how a refused index swap could sit unnoticed for
 * days. A fact worth showing that health does not carry belongs in `src/server/health.ts`.
 */

import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronRight, Clapperboard, type LucideIcon, MailPlus, Users } from "lucide-react";
import { ServerHealth } from "../components/ServerHealth";
import { SiteDefaults } from "../components/SiteDefaults";
import {
  type AdminInvite,
  type AdminUser,
  adminRequests,
  getSiteSettings,
  listInvites,
  listUsers,
  patchSiteSettings,
  type SiteSettings,
} from "../lib/auth-api";
import { getServerHealth } from "../lib/health-api";
import { count } from "../lib/units";
import { useAsyncData } from "../lib/use-async-data";

interface Overview {
  users: AdminUser[];
  invites: AdminInvite[];
  requests: number;
}

async function loadOverview(): Promise<Overview> {
  const [u, i, r] = await Promise.all([listUsers(), listInvites(), adminRequests()]);
  return { users: u.users, invites: i.invites, requests: r.requests.length };
}

/**
 * One figure and the page it leads to. `detail` is the second line, or nothing.
 *
 * THE LABEL IS ABOVE THE NUMBER, which is the inversion worth explaining. A tile reading
 * `13` then `People` makes the reader hold a number until they learn what it counts; the
 * other way round they read the noun, then the figure that answers it. The icon is the same
 * argument one step earlier -- it says which tile this is before either line is read.
 *
 * The arrow appears on hover rather than always, because three tiles each wearing a
 * permanent arrow is three arrows competing with the numbers they point away from.
 */
function Tile(props: {
  to: LinkProps["to"];
  label: string;
  value: number;
  detail?: string;
  icon: LucideIcon;
}) {
  const Icon = props.icon;
  return (
    <Link
      to={props.to}
      className="group flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3.5 transition-colors hover:border-accent/60"
    >
      <span className="flex items-center gap-2 text-sm text-muted">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {props.label}
        <ChevronRight
          className="ml-auto size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        />
      </span>
      <span className="text-3xl font-semibold tabular-nums text-ink">{props.value}</span>
      {props.detail && <span className="text-xs text-muted">{props.detail}</span>}
    </Link>
  );
}

/** "2 administrators · 1 disabled", with the parts that are zero left out entirely. */
function peopleDetail(users: AdminUser[]): string {
  const admins = users.filter((u) => u.role === "admin").length;
  const disabled = users.filter((u) => u.disabled).length;
  return [count(admins, "administrator"), ...(disabled > 0 ? [`${disabled} disabled`] : [])].join(" · ");
}

/**
 * A block that loads its own data and renders its own failure.
 *
 * Three of them on this page and each can fail alone -- see the note at the top of the file.
 * The wrapper exists so "Loading…" and the error line are worded identically in all three
 * rather than three times over.
 */
function Section<T>(props: {
  title?: string;
  load: () => Promise<T>;
  children: (data: T, reload: () => Promise<void>) => React.ReactNode;
}) {
  const { data, error, reload } = useAsyncData(props.load);
  return (
    <section className="flex flex-col gap-2">
      {props.title && <h2 className="text-sm font-medium">{props.title}</h2>}
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : data ? (
        props.children(data, reload)
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </section>
  );
}

function Tiles({ data }: { data: Overview }) {
  const outstanding = data.invites.filter((i) => !i.redeemedAt);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Tile
        to="/admin/users"
        icon={Users}
        label="People"
        value={data.users.length}
        detail={peopleDetail(data.users)}
      />
      <Tile
        to="/admin/invites"
        icon={MailPlus}
        label="Outstanding invitations"
        value={outstanding.length}
        detail={outstanding.length === 0 ? "Nobody is waiting to join." : undefined}
      />
      <Tile
        to="/log"
        icon={Clapperboard}
        label="Requests"
        value={data.requests}
        detail="Who asked is shown to administrators only."
      />
    </div>
  );
}

export function AdminOverviewRoute() {
  // All three loaders are module-level or stable, so none needs a `useCallback`.
  return (
    <div className="flex flex-col gap-8">
      <Section load={loadOverview}>{(data) => <Tiles data={data} />}</Section>

      <Section load={getSiteSettings}>
        {(data, reload) => (
          <SiteDefaults
            settings={data.settings}
            save={async (changes: Partial<SiteSettings>) => {
              await patchSiteSettings(changes);
              // Redraw from the SERVER's answer rather than from what was sent: a refused
              // field must not leave the form showing a value nothing saved.
              await reload();
            }}
          />
        )}
      </Section>

      <Section title="Server" load={getServerHealth}>
        {(health) => <ServerHealth health={health} />}
      </Section>
    </div>
  );
}
