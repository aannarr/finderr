/**
 * `/admin/addons` -- what is installed, what each one needs, and where to put it.
 *
 * Until this screen existed the only way to configure an addon was `curl` with the system
 * key, which meant a household running finderr could not add a TMDB key without a shell on
 * the host. The server half has been complete since the declaration landed; nothing DREW it.
 *
 * A RENDERER over `GET /api/admin/addons`, like `ServerHealth` is over `/api/health`. The
 * order is the loader's, the fields are the addon's declaration, and this file knows the name
 * of no addon in particular -- see `AddonSettings`, which owns what one looks like.
 */

import { AddonSettings } from "../components/AddonSettings";
import { type AddonConfigValue, listAddons, patchAddonConfig } from "../lib/auth-api";
import { useAsyncData } from "../lib/use-async-data";

async function loadAddons() {
  return (await listAddons()).addons;
}

export function AdminAddonsRoute() {
  const { data, error, reload } = useAsyncData(loadAddons);

  /**
   * Save one field, then redraw from what the server NOW says.
   *
   * The rejection is re-raised rather than swallowed -- that is why this is `reload` and not
   * `useAsyncData`'s `act`, which keeps the failure at page level. A refused save belongs on
   * the control that provoked it, and the control is what tells a secret's box to empty
   * itself once the write has actually landed.
   */
  const save = (pluginId: string) => async (key: string, value: AddonConfigValue | null) => {
    await patchAddonConfig(pluginId, { [key]: value });
    await reload();
  };

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-sm font-medium">Addons</h2>
        <p className="mt-1 text-xs text-muted">
          {/*
            Stated up front rather than as a message after each save, because it is a property
            of the surface and not of any one write: an addon reads its configuration once, in
            `init`, so a value saved here reaches it when it next loads. The exception is
            worth nobody's attention -- core re-reads the TMDB key on every sync -- and saying
            "sometimes sooner" would only invite a reader to guess which case they are in.
          */}
          An addon reads its settings when it loads, so restart finderr for a change here to reach it.
          Clearing a setting also stops any environment variable that was seeding it.
        </p>
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}
      {!data && !error && <p className="text-sm text-muted">Loading…</p>}
      {data?.length === 0 && <p className="text-sm text-muted">No addons are installed.</p>}

      {data?.map((addon) => (
        <AddonSettings key={addon.pluginId} addon={addon} save={save(addon.pluginId)} />
      ))}
    </div>
  );
}
