/**
 * `/admin/playback` -- what playback is costing this box, over time and by session.
 *
 * Its own tab rather than a block on `/admin` for the reason that page's own note gives: the
 * overview is four questions about the HOUSEHOLD, and "is the Celeron keeping up" is a fifth
 * about the machine. Folding it in would put two 240-bar charts under a people count.
 *
 * Thin on purpose. `PlaybackCost` renders and `playback-cost-api.ts` fetches; what lives here is
 * the load-error-data ladder every other admin screen uses, so the wording of "Loading…" and of
 * a refusal is the same on all six.
 */

import { PlaybackCost } from "../components/PlaybackCost";
import { getPlaybackCost } from "../lib/playback-cost-api";
import { useAsyncData } from "../lib/use-async-data";

export function AdminPlaybackRoute() {
  // Module-level and therefore stable, so it needs no `useCallback` -- see `useAsyncData`.
  const { data, error, reload } = useAsyncData(getPlaybackCost);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
  return <PlaybackCost report={data} refresh={() => void reload()} />;
}
