/**
 * Ask again for something that dead-ended.
 *
 * `POST /api/requests/:tconst/retry` has existed since requests did. It was first wired only
 * to the toast a failed POST raises, which is gone the moment the reader looks away; then to
 * `/requests`; and on 2026-09-15 aannarr found the title page still drawing "Request failed"
 * with nothing to press under it. One component, two surfaces: the difference between a row
 * on `/requests` and the title header is the `tone`, not a fork.
 *
 * NO CONFIRMATION, unlike `WithdrawControl`, and the asymmetry is the point: withdrawing
 * destroys an ask and cannot be undone, while retrying re-queues one and costs an indexer
 * search. A guard on a harmless verb teaches readers to click through guards.
 *
 * Offered on DEAD ENDS ONLY -- the tone, never a list of verdicts, so a verdict added to
 * `VERDICT_COPY` lands in the right place without this file being edited. A retry on
 * something already downloading would cancel and re-search a download in progress.
 */

import { useState } from "react";
import { type RequestVerdict, VERDICT_COPY } from "../../../src/lib/request-diagnostics";
import { patchTitleState, requestStatePatch, retryRequest } from "../lib/api";
import { LINK_BUTTON, PRIMARY_BUTTON } from "../lib/ui";

/**
 * `link` sits at the end of a `/requests` row beside Withdraw. `primary` is the title header's
 * one slot: on a dead end, asking again IS the thing to press, so it wears the same fill the
 * Request button it replaces would have.
 */
export type RetryTone = "link" | "primary";

export function RetryControl({
  request,
  onRetried,
  tone = "link",
}: {
  request: { tconst: string; requestVerdict: RequestVerdict | null };
  onRetried?: () => void;
  tone?: RetryTone;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request.requestVerdict || VERDICT_COPY[request.requestVerdict].tone !== "dead_end") return null;

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await retryRequest(request.tconst);
      // Every cached view of this title still shows the failure, so it is corrected through
      // the shared caches rather than by reloading each of them. On the title page this patch
      // IS the re-render: the row swaps to "Requested" and this control disappears with it.
      patchTitleState(request.tconst, requestStatePatch("queued"));
      onRetried?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = busy ? "Asking again…" : "Try again";

  if (tone === "primary") {
    return (
      <div className="mt-2">
        <button type="button" onClick={() => void retry()} disabled={busy} className={PRIMARY_BUTTON}>
          {label}
        </button>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <button type="button" onClick={() => void retry()} disabled={busy} className={LINK_BUTTON}>
        {label}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
