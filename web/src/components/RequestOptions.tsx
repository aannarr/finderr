/**
 * Quality profile and root folder, for the one reader allowed to choose them.
 *
 * > [!IMPORTANT] ADMIN ONLY, and the server is what enforces it
 * > aannarr, 2026-08-31. Quality profile and root folder decide what gets downloaded and
 * > onto which disk, so they are a library-management decision rather than a request. An
 * > ordinary user asks for a title; an admin decides how it arrives.
 * >
 * > `isAdmin` from `useApp()` gates whether this is DRAWN. It is not the rule -- the rule is
 * > `auth.requireAdmin` on `/api/arr/options` and the 403 on `POST /api/requests`. A flag
 * > flipped in devtools renders the panel and then buys two refusals, which is exactly what
 * > a display gate should be worth.
 *
 * Two properties are worth knowing before changing it:
 *
 * - **It fetches on FIRST OPEN, never on mount.** The governing rule of this product is
 *   that nothing a reader waits on touches the network, and `/api/arr/options` is the one
 *   route in the tree that calls Radarr and Sonarr. Loading it with the page would put that
 *   call on every admin's title view, for a control most of them will not touch. Collapsed
 *   by default is what makes that honest rather than merely lazy.
 * - **It reserves its own height while loading.** It sits under the Request button and above
 *   the reading column, so a list arriving late must not shove the page. Same rule as the
 *   facet panes, applied by hand because this is not facet-driven.
 * - **The load policy is NOT in the effect** -- `makeArrOptionsLoader`
 *   (`../lib/arr-options-load.ts`) owns it, and the caution at the top of that file is the
 *   one thing to read before touching this component. The effect here does two things
 *   only: start the loader when the panel first opens, and dispose it on unmount.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { type ArrOptions, getArrOptions, type RequestOverrides } from "../lib/api";
import { makeArrOptionsLoader, type OptionsState } from "../lib/arr-options-load";

export interface RequestOptionsProps {
  /** Which arr will serve this title. Decides which lists are offered. */
  service: "radarr" | "sonarr" | string;
  value: RequestOverrides;
  onChange: (next: RequestOverrides) => void;
  /** Injected by tests. Defaults to the real endpoint. */
  load?: () => Promise<{ radarr: ArrOptions | null; sonarr: ArrOptions | null }>;
}

export function RequestOptions({ service, value, onChange, load }: RequestOptionsProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<OptionsState>({ phase: "idle" });
  const fieldId = useId();

  const fetcher = load ?? getArrOptions;

  const loader = useMemo(() => makeArrOptionsLoader(fetcher, setState), [fetcher]);
  // Unmount ONLY. Collapsing the panel or changing a prop must not cancel a call already
  // in flight -- cancelling on anything narrower than this is the bug the loader exists
  // to make unrepeatable.
  useEffect(() => () => loader.dispose(), [loader]);
  useEffect(() => {
    if (open) loader.start();
  }, [open, loader]);

  const set = useCallback((patch: RequestOverrides) => onChange({ ...value, ...patch }), [onChange, value]);

  const arrName = service === "sonarr" ? "Sonarr" : "Radarr";
  // Picked at RENDER, not at fetch: one answer carries both arrs, so `service` never needs
  // to be a dependency of anything asynchronous.
  const options =
    state.phase === "ready" ? (service === "sonarr" ? state.options.sonarr : state.options.radarr) : null;

  return (
    <details
      className="mt-2 rounded-lg border border-line text-sm"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer px-3 py-2 text-muted select-none hover:text-ink">
        Request settings
      </summary>

      {/* min-height so opening does not jolt when the lists land a moment later. */}
      <div className="space-y-3 px-3 pt-1 pb-3" style={{ minHeight: "9rem" }}>
        {state.phase === "loading" && <p className="text-muted">Asking {arrName}…</p>}

        {state.phase === "error" && (
          <p className="text-muted">
            Could not read {arrName}'s profiles. The request will use the configured defaults.
          </p>
        )}

        {state.phase === "ready" && options === null && (
          <p className="text-muted">{arrName} is not configured.</p>
        )}

        {options !== null && (
          <>
            <div>
              {/* `htmlFor`/`id` rather than wrapping the control: a label whose control
                  arrives through a prop is one an accessibility tree cannot follow, and
                  Biome's `noLabelWithoutControl` refuses it for exactly that reason. */}
              <label htmlFor={`${fieldId}-profile`} className="mb-1 block text-xs text-muted">
                Quality profile
              </label>
              <select
                id={`${fieldId}-profile`}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1"
                value={value.qualityProfileId ?? ""}
                onChange={(e) =>
                  set({ qualityProfileId: e.target.value === "" ? null : Number(e.target.value) })
                }
              >
                {/* The empty option is not a blank -- it is the ONLY way back to "whatever
                    the service is configured for", and it must stay reachable after a
                    choice is made. */}
                <option value="">Service default</option>
                {options.qualityProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={`${fieldId}-folder`} className="mb-1 block text-xs text-muted">
                Root folder
              </label>
              <select
                id={`${fieldId}-folder`}
                className="w-full rounded border border-line bg-surface-2 px-2 py-1"
                value={value.rootFolderPath ?? ""}
                onChange={(e) => set({ rootFolderPath: e.target.value === "" ? null : e.target.value })}
              >
                <option value="">Service default</option>
                {options.rootFolders.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                    {f.freeSpace !== undefined && ` — ${formatBytes(f.freeSpace)} free`}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-muted">
              <input
                type="checkbox"
                // `!== false` and not `?? true`: unset and true are different facts about
                // the request (see `search_on_add` in store.ts) and both mean "yes" here.
                checked={value.searchOnAdd !== false}
                onChange={(e) => set({ searchOnAdd: e.target.checked ? null : false })}
              />
              Start searching immediately
            </label>
          </>
        )}
      </div>
    </details>
  );
}

/**
 * Free space, rounded hard.
 *
 * An arr reports bytes and an admin choosing a disk wants to know "is there room", not the
 * exact figure -- so one decimal at TB and none below is the whole requirement.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const tb = bytes / 1e12;
  if (tb >= 1) return `${tb.toFixed(1)} TB`;
  return `${Math.round(bytes / 1e9)} GB`;
}
