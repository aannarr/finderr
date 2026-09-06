/**
 * The top of `/requests`: what state everything is in, what today's allowance is, and the one
 * offer worth making while a download is moving.
 *
 * A COMPONENT AND NOT THREE LINES IN THE ROUTE, because three separate facts wanted the same
 * strip of screen and each of them arriving on its own would have bolted a second line above
 * the first. The page had no header at all before this -- an `h1` and a `ul` -- so whoever
 * went first was going to decide the shape for the other two by accident.
 *
 * It DERIVES nothing. The buckets are `groupByState`'s and the quota sentence is
 * `quotaLine`'s; what this file owns is where they sit and how quiet they are. A header that
 * re-counted the rows it is describing would be the second reader of a partition, free to
 * disagree with the headings below it about how many things are downloading.
 */

import { formatRemaining } from "../../../src/lib/request-diagnostics";
import { type QuotaState, quotaSummary } from "../../../src/lib/request-quota";
import { BUCKET_LABEL, type RequestGroup } from "../lib/request-log";
import { PushOffer } from "./PushOffer";

export function RequestsHeader({
  groups,
  quota,
  /** Is anything actually moving? Decides whether the push offer is made at all. See `PushOffer`. */
  working,
}: {
  groups: readonly RequestGroup[];
  quota: QuotaState | null;
  working: boolean;
}) {
  // Read once per render rather than per group, so every relative time in this header is
  // relative to the same instant. Nothing here needs a ticking clock: the quota reset is
  // hours away and the page repaints on the shell's poll anyway.
  const line = quota ? quotaSummary(quota, Date.now(), formatRemaining) : null;

  return (
    <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
      <h1 className="text-xl font-semibold tracking-tight">Your requests</h1>

      {/*
        THE COUNTS ARE A SUMMARY AND NOT A CONTROL. They do not filter, and they are not links:
        the groups themselves are a few hundred pixels below with the same words on them, so a
        chip that scrolled to a heading already on screen would be chrome pretending to be
        navigation. What they buy is the glance -- "two downloading, one needs attention" --
        which is the whole difference between a dashboard and a receipt.
      */}
      <ul className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
        {groups.map(({ bucket, rows }) => (
          <li key={bucket}>
            <span className="tabular-nums font-medium text-ink">{rows.length}</span>{" "}
            {BUCKET_LABEL[bucket].toLowerCase()}
          </li>
        ))}
      </ul>

      <div className="ml-auto flex items-center gap-3">
        {/*
          The allowance, on the one page where spending it is the subject. It was configurable
          from the day quotas landed and no screen had ever drawn it, so the only way to find
          out you had a limit was to hit it. Null when it does not bind this reader -- see
          `quotaLine`.
        */}
        {line && <span className="text-xs tabular-nums text-muted">{line}</span>}
        <PushOffer when={working} />
      </div>
    </header>
  );
}
