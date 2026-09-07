/**
 * The admin API for per-addon configuration: read what every addon declares, save a value,
 * clear one.
 *
 * ITS OWN MODULE rather than a pair of entries in `auth-routes.ts`, because that file is
 * identity and this needs the plugin registry -- wiring a registry into `AuthService` would
 * make every auth test stand one up. It takes `asAdmin` as a function for the same reason:
 * who is allowed in stays `AuthService`'s single answer, and this module never learns what a
 * principal is.
 *
 * The FORM that drives these is a separate card. What is here is the whole server side of
 * it, which is also what an operator can drive with `curl` and an admin key.
 *
 * > [!CAUTION] A secret is write-only through this surface
 * > GET reports whether a `secret` is set and where the value came from, never the value.
 * > `AddonConfigStore.report()` owns that rule; this file must not add a second way out.
 */

import type { AddonConfigStore } from "../lib/addon-config";
import { parseAddonConfigPatch } from "../lib/addon-config";
import type { PluginRegistry } from "../lib/plugins";
import { json } from "./json-response";

type Handler = (req: Request, server?: unknown) => Response | Promise<Response>;

export const ADDON_CONFIG_PATH = "/api/admin/addons";

export interface AddonConfigRoutesDeps {
  /** The authority on which addons exist and what each one declares. */
  registry: PluginRegistry;
  config: AddonConfigStore;
  /** `AuthService.asAdmin` -- 401 for anonymous, 403 for a signed-in non-admin. */
  asAdmin: (req: Request, fn: () => Response | Promise<Response>) => Promise<Response>;
  log: (message: string) => void;
}

/** The parsed body of a PATCH, or `{}` for anything that is not a JSON object. */
async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function addonConfigRoutes(deps: AddonConfigRoutesDeps): Record<string, Record<string, Handler>> {
  return {
    /**
     * Every loaded addon and what it needs, in load order.
     *
     * Addons with NO settings are listed too, with an empty `fields`. The question this
     * answers is "what is installed and is any of it waiting on you", and an addon that
     * needs nothing is a real answer to the second half.
     */
    [ADDON_CONFIG_PATH]: {
      GET: (req) =>
        deps.asAdmin(req, () =>
          json({ addons: deps.registry.list().map((p) => deps.config.report(p.meta.id)) }),
        ),
    },

    /**
     * Save the fields named in the body and leave the rest alone.
     *
     * PATCH rather than PUT, the same shape as `/api/admin/settings` and for the same
     * reason: a whole-object write from a stale form silently reverts whatever changed
     * since it loaded. `null` clears a field -- which is the only way to un-set a secret,
     * since nothing can read one back to send it again.
     *
     * A CHANGE TAKES EFFECT AT THE NEXT RESTART for anything an addon read in `init`, which
     * is most of it: `init` runs once and closes over what it found. That is also when the
     * addon's `configVersion` moves and its stale contributions are pruned -- see
     * `configFingerprint`. The response says so rather than pretending otherwise.
     */
    [`${ADDON_CONFIG_PATH}/:id`]: {
      PATCH: async (req) =>
        deps.asAdmin(req, async () => {
          const id = (req as Bun.BunRequest<"/api/admin/addons/:id">).params.id;
          if (!deps.registry.has(id)) return json({ error: "no such addon" }, { status: 404 });

          const declaration = deps.config.declarationOf(id);
          const parsed = parseAddonConfigPatch(declaration, await body(req));
          if ("error" in parsed) return json({ error: parsed.error }, { status: 400 });

          for (const [key, value] of parsed.patch) deps.config.write(id, key, value);
          // The KEYS, never the values: one of them may be a credential, and this line is the
          // reason an operator can tell later that somebody changed the addon's behaviour.
          deps.log(`addon ${id} configured -- ${[...parsed.patch.keys()].join(", ") || "nothing"}`);
          return json({ addon: deps.config.report(id), restartRequired: parsed.patch.size > 0 });
        }),
    },
  };
}
