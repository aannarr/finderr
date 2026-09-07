/**
 * What `/api/health` knows, drawn for a person instead of for `jq`.
 *
 * NOTHING HERE IS NEW REPORTING. Every number below was already collected, already returned
 * to an admin, and already impossible to see without a shell and the system key -- which is
 * why a refused index swap or a prefault that never ran could sit unnoticed for days. This
 * file is a renderer and must stay one: a fact worth showing that health does not carry
 * belongs in `src/server/health.ts`, next to the rule that says every field there is a count
 * or a read and never a query.
 *
 * ORDERED BY WHAT BREAKS FIRST, not by what is interesting. The index answers every query in
 * the product, so it leads; the prefault decides whether those queries touch the disk;
 * connections decide whether a request can be fulfilled at all; addons and the slow log are
 * where you go once you know the basics are fine.
 *
 * Each block states the ALARMING reading in its own hint rather than colouring a number red
 * and leaving the reader to guess the threshold. A dashboard that knows which value is bad
 * should say so in words.
 */

import type { IndexReload, IndexWarm, ServerHealthPayload, SlowRequest } from "../lib/health-api";
import { formatAge, formatStamp } from "../lib/timestamps";
import { count, formatBytes } from "../lib/units";
import { Panel } from "./settings/Panel";

/**
 * How many slow requests to draw.
 *
 * The ring behind this keeps 64 and the card asked for the last 20, which is the right number
 * for the same reason the ring is small: this is read by somebody triaging a complaint about
 * "just now", and a long tail of the same route with the same argument is one fact repeated.
 */
const SLOW_SHOWN = 20;

/**
 * How long this process has been up, to one unit.
 *
 * Its own function rather than `formatAge` on a derived instant: that reads "Up 2 hours ago",
 * which is a different and slightly wrong sentence. One unit because the question is "has it
 * restarted recently", and "2 days, 4 hours and 11 minutes" answers it no better.
 */
function uptime(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) return count(Math.floor(seconds / size), name);
  }
  return count(Math.round(seconds), "second");
}

/** A titled block, matching the card `/admin/users/:id` uses for its sections. */
function Block(props: { title: string; children: React.ReactNode }) {
  return <Panel title={props.title}>{props.children}</Panel>;
}

/**
 * One fact: its name on the left, its value on the right, both on one baseline.
 *
 * > [!IMPORTANT] THE COLUMN IS THE POINT, and it is why this is not a sentence
 * > These read `Rows 1,276,669` / `Built Sep 6, 2026` as running prose, label and value in
 * > the same size a word apart, so a screen of twenty of them had no shape at all -- the eye
 * > had to read every line to find the one it wanted. Ruled onto two columns with the values
 * > right-aligned and tabular, a reader scans ONE column and stops at the row they came for.
 * >
 * > **MOST hints name a reading that is WRONG, so they are drawn as alarms.** A refused swap,
 * > a reclaimed prefault, a Plex walk that matched nothing. As a third line of grey they
 * > looked exactly like the two facts above them, which is how a refused index swap sits
 * > unnoticed on a page whose entire job is to report it.
 * >
 * > **`tone: "info"` is for the two that are NOT.** "The daily refresh has not run in this
 * > process yet" says so and adds *"ordinary for most of a container's life"* -- painting
 * > that yellow puts an alarm on a perfectly healthy server every time it restarts, and an
 * > alarm that is usually nothing is an alarm nobody reads. Which of the two a hint is
 * > belongs to the function that WRITES it, so it travels with the words.
 */
function Fact(props: { label: string; value: string; hint?: string; tone?: "alarm" | "info" }) {
  return (
    <li className="flex flex-col gap-1 py-1.5 not-last:border-b not-last:border-line/60">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
        <span className="text-muted">{props.label}</span>
        <span className="tabular-nums text-ink">{props.value}</span>
      </div>
      {props.hint &&
        ((props.tone ?? "alarm") === "info" ? (
          <p className="text-xs text-muted">{props.hint}</p>
        ) : (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">
            {props.hint}
          </p>
        ))}
    </li>
  );
}

function Facts(props: { children: React.ReactNode }) {
  return <ul className="flex flex-col">{props.children}</ul>;
}

/**
 * The last in-place swap, in one sentence.
 *
 * `ok: false` is the one line on this page worth acting on: a rebuilt index FAILED its canary
 * and we are deliberately still serving the previous one, so the library is quietly a day
 * older than it looks and nothing else says so.
 */
function reloadLine(reload: IndexReload | null): {
  value: string;
  hint?: string;
  tone?: "alarm" | "info";
} {
  if (!reload) {
    return {
      value: "not since this container started",
      hint: "The daily refresh has not run in this process yet. Ordinary for most of a container's life.",
      // Says "ordinary" in its own words, so it must not be painted as a fault.
      tone: "info",
    };
  }
  const when = formatAge(new Date(reload.at).toISOString()) ?? formatStamp(reload.at);
  const canary = reload.canary ? `, canary ${reload.canary.passed}/${reload.canary.total}` : "";
  if (!reload.ok) {
    return {
      value: `REFUSED ${when}${canary}`,
      hint: `${reload.reason ?? "The rebuilt index did not answer."} The previous index is still being served, so searches work and the library is stale. Rebuild from the host.`,
    };
  }
  return {
    value: `${reload.swapped ? "swapped" : "checked"} ${when}${canary}, in ${(reload.ms / 1000).toFixed(1)}s`,
  };
}

/**
 * Whether the page-cache prefault ran, and whether what it read survived.
 *
 * Three numbers because three things fail independently: it can be off, it can run and be
 * reclaimed by the container's memory cap, or it can be told to map more than the box has.
 * `residentMb` well below `readMb` is the deployment that looks healthy and is serving half
 * its index off the disk -- worth 224x on the NAS array, and invisible before this page.
 */
function Warm({ warm }: { warm: IndexWarm | null }) {
  if (!warm) {
    return (
      <Facts>
        <Fact
          label="Prefault"
          value="unknown"
          hint="No index is open to ask -- a build is probably running."
          tone="info"
        />
      </Facts>
    );
  }
  if (!warm.prefault) {
    return (
      <Facts>
        <Fact
          label="Prefault"
          value="off"
          hint="Nothing warms the page cache at boot, so the first reads after a restart come off the disk."
        />
      </Facts>
    );
  }
  const last = warm.last;
  const kept = last?.residentMb ?? null;
  // Two thirds is a judgement, not a measurement: below it, enough of the index was taken
  // back that first reads are hitting the disk again, which is the condition worth naming.
  const reclaimed = last !== null && kept !== null && kept < last.readMb * 0.67;
  return (
    <Facts>
      <Fact
        label="Prefault"
        value={
          last
            ? `read ${last.readMb} MB in ${(last.ms / 1000).toFixed(1)}s, ${kept === null ? "resident unknown" : `${kept} MB resident`}`
            : "on, but it has not finished in this process"
        }
        hint={
          reclaimed
            ? "Most of what was read has been reclaimed -- the container's memory cap is below the index, so queries are going back to the disk."
            : undefined
        }
      />
      {warm.tuning && (
        <Fact
          label="Tuning"
          value={`${warm.tuning.budgetMb} MB budget (${warm.tuning.budgetSource}), ${warm.tuning.mmapMb} MB mapped, ${warm.tuning.cacheMb} MB cache`}
        />
      )}
    </Facts>
  );
}

/** Which upstreams this instance is configured to talk to. Configured, never probed. */
function services(s: ServerHealthPayload["services"]): string {
  const on = Object.entries(s)
    .filter(([, configured]) => configured)
    .map(([name]) => name);
  return on.length === 0 ? "none" : on.join(", ");
}

function Slow({ slow }: { slow: SlowRequest[] }) {
  if (slow.length === 0) {
    return <p className="text-sm text-muted">Nothing has been slow enough to record.</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {slow.slice(0, SLOW_SHOWN).map((entry) => (
        // Newest first, which is the order the server keeps them in and the order somebody
        // triaging "it was slow a minute ago" wants. The key is the pair, because the same
        // route and argument can breach twice.
        <li key={`${entry.at}-${entry.label}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="tabular-nums">{(entry.ms / 1000).toFixed(1)}s</span>
          <span>{entry.label}</span>
          {/* The arguments are what a distribution cannot tell you: on this API `?genre=Comedy`
              and `?kind=series` differ by 400x under one route pattern. */}
          {entry.detail && <span className="text-xs text-muted">{entry.detail}</span>}
          <span className="ml-auto text-xs text-muted">
            {formatAge(new Date(entry.at).toISOString()) ?? ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The whole panel from a payload alone, so it can be asserted without a fetch. */
export function ServerHealth({ health }: { health: ServerHealthPayload }) {
  const reload = reloadLine(health.index.reload);
  const cgroup = health.runtime.cgroup;

  /*
    A GRID, because these five cards are five INDEPENDENT questions and a column of them is a
    scroll. Index and Memory are the pair read together -- how big is it, and is it in RAM --
    so they lead the first row; the slow log spans both columns because its rows carry a route
    and its arguments, which is the one block here that wants the width.
  */
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Block title="Index">
        <Facts>
          <Fact label="Rows" value={health.index.rows.toLocaleString()} />
          <Fact label="Built" value={formatStamp(health.index.builtAt, "never")} />
          <Fact label="Last swap" value={reload.value} hint={reload.hint} tone={reload.tone} />
        </Facts>
      </Block>

      <Block title="Memory">
        <Warm warm={health.index.warm} />
        <Facts>
          <Fact
            label="Resident"
            value={
              cgroup?.limit
                ? `${formatBytes(cgroup.current)} of ${formatBytes(cgroup.limit)}`
                : formatBytes(health.runtime.rss)
            }
            hint={
              cgroup?.ratio !== null && cgroup?.ratio !== undefined && cgroup.ratio > 0.9
                ? "Close to the container's cap. Page cache is being reclaimed to stay under it."
                : undefined
            }
          />
          <Fact label="Up" value={uptime(health.runtime.uptimeSeconds)} />
        </Facts>
      </Block>

      <Block title="Connections">
        <Facts>
          <Fact label="Configured" value={services(health.services)} />
          <Fact
            label="Library"
            value={`${count(health.library.radarr, "film")}, ${count(health.library.sonarr, "series", "series")}, ${count(health.library.episodes, "episode")}`}
            hint={
              health.library.sonarr > 0 && health.library.episodes === 0
                ? "No episodes mirrored beside a non-empty series library: the episode walk ran and every fetch failed, so series pages show nothing as owned."
                : undefined
            }
          />
          <Fact
            label="Plex"
            value={
              health.plex.machineId === null
                ? "never synced"
                : `${count(health.plex.items, "title")} playable`
            }
            hint={
              health.plex.machineId !== null && health.plex.items === 0
                ? "The walk ran and matched nothing, which is what a library scanned by a legacy Plex agent looks like."
                : undefined
            }
          />
        </Facts>
      </Block>

      <Block title="Addons">
        {health.plugins.loaded.length === 0 ? (
          <p className="text-sm text-muted">No addons are loaded.</p>
        ) : (
          <Facts>
            {health.plugins.loaded.map((plugin) => (
              <Fact
                key={plugin.id}
                label={plugin.id}
                // The hosts core will let it fetch, which IS its outbound surface -- anything
                // else is refused. An addon that names none reaches nothing off this machine.
                value={plugin.hosts.length === 0 ? "reaches nothing outside" : plugin.hosts.join(", ")}
              />
            ))}
          </Facts>
        )}
        <Facts>
          <Fact
            label="Facts held"
            value={`${health.facets.rows.toLocaleString()} rows, ${count(health.facets.images, "image")}`}
            hint={
              health.facets.rows > 0 && health.facets.images === 0
                ? "Facts are landing but no image has been given a proxy key, so cast and season art will not render."
                : undefined
            }
          />
        </Facts>
      </Block>

      <div className="md:col-span-2">
        <Block title="Slowest requests">
          <Slow slow={health.timings.slow} />
        </Block>
      </div>
    </div>
  );
}
