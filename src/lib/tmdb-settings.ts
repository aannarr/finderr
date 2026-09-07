/**
 * The TMDB key and image base THIS INSTANCE uses, with exactly one owner.
 *
 * > [!IMPORTANT] TWO READERS, ONE VALUE, AND THIS FILE IS WHERE IT LIVES
 * > The `tmdb` addon wants the key for its six facets. Core wants the same key for the
 * > upcoming-and-trending sync, and the same image base for the poster proxy. Before this
 * > file they were two readers of one environment variable: the addon resolved it through
 * > `AddonConfigStore`, so a value saved on the admin page won for the addon, while core
 * > read `cfg.tmdb.apiKey` and stayed on whatever the container was started with. Rotating
 * > the key rotated half the product, silently, with nothing on any screen saying so.
 *
 * So the declarations below are CORE's, and both readers resolve them from the same `kv`
 * row under the same rule -- `addon_config:tmdb:*`, stored beats env seed beats default, the
 * one rule `./addon-config.ts` owns. The addon spreads them into its own `meta.config`
 * rather than restating them, which is what makes "one owner" a fact about the code instead
 * of a promise in a comment.
 *
 * THE DIRECTION MATTERS. Core asks `AddonConfigStore` for a field it declared itself, never
 * the plugin registry for what an addon declared: deleting `src/plugins/tmdb.ts` removes
 * that addon's facts and must not also stop the trending sync or the poster proxy, both of
 * which are core features that predate the addon.
 */

import type { AddonConfigDeclaration, AddonConfigField, AddonConfigStore } from "./addon-config";

/**
 * The config namespace both readers use, which is the `tmdb` addon's plugin id.
 *
 * Shared DELIBERATELY: `/api/admin/addons/tmdb` is the one screen an operator sets a TMDB
 * key on, and a core-only namespace beside it would put the second setting back -- the exact
 * drift this file exists to remove.
 */
export const TMDB_ADDON_ID = "tmdb";

/** Where a TMDB image path becomes a URL when nobody has said otherwise. */
export const TMDB_DEFAULT_IMAGE_BASE = "https://image.tmdb.org/t/p";

/**
 * The key, `secret` so the admin API never reads it back and no log line can carry it.
 *
 * It keeps `FINDERR_TMDB_API_KEY` as its env seed, so every deployment configured by
 * environment variable behaves exactly as it did before any of this existed.
 *
 * > [!IMPORTANT] The DESCRIPTION says "the whole instance" on purpose, and it is not padding
 * > These two fields are drawn on `/admin/addons` under the `tmdb` addon's heading, because
 * > that is the namespace they are stored in -- so a description reading "this configures the
 * > tmdb addon" would put the drift this file exists to remove straight back, relocated into
 * > prose. Whoever changes this key changes the upcoming and trending shelves too, and the
 * > form is where they find that out. `watchProviderRegions` in `src/plugins/tmdb.ts` is the
 * > contrast: it genuinely is the addon's alone, and it reads that way.
 */
export const TMDB_API_KEY_FIELD = {
  key: "apiKey",
  type: "secret",
  required: true,
  label: "API key",
  description:
    "A TMDB v3 API key, used by this whole instance rather than by the tmdb addon alone -- the upcoming and trending shelves read the same one. Without it those shelves stay empty and the addon answers nothing.",
  env: "FINDERR_TMDB_API_KEY",
} as const satisfies AddonConfigField;

export const TMDB_IMAGE_BASE_FIELD = {
  key: "imageBase",
  type: "string",
  label: "Image base URL",
  description:
    "Where a TMDB image path becomes a URL. Instance-wide as well: the poster proxy resolves every cached image through it, addon or no addon. Change it only for a TMDB mirror.",
  env: "FINDERR_TMDB_IMAGE_BASE",
  default: TMDB_DEFAULT_IMAGE_BASE,
} as const satisfies AddonConfigField;

/**
 * The fields core and the `tmdb` addon share, in the order an admin form should show them.
 *
 * Spread into `src/plugins/tmdb.ts`'s `meta.config`, which then adds the one field only that
 * addon uses. An addon of your own declares all of its fields inline -- this spread exists
 * because core happens to read two of these, not because it is the shape to copy.
 */
export const TMDB_SHARED_CONFIG = [
  TMDB_API_KEY_FIELD,
  TMDB_IMAGE_BASE_FIELD,
] as const satisfies AddonConfigDeclaration;

/** What core needs from TMDB's configuration. `apiKey` absent means the syncs stay quiet. */
export interface TmdbSettings {
  apiKey?: string;
  imageBase: string;
}

/**
 * The narrow read side, which is all a consumer needs.
 *
 * `ImageCache` depends on THIS rather than on the store, so a test hands it an object
 * literal and nothing has to stand up a database to assert an upstream URL. Same shape, and
 * same reason, as `SiteSettingsReader` in `./site-settings.ts`.
 */
export interface TmdbSettingsReader {
  read(): TmdbSettings;
}

/** A field whose declared kind is text, or undefined -- never a coerced number or boolean. */
function text(config: AddonConfigStore, field: AddonConfigField): string | undefined {
  const value = config.sharedValue(TMDB_ADDON_ID, field);
  return typeof value === "string" ? value : undefined;
}

export class TmdbSettingsStore implements TmdbSettingsReader {
  constructor(private readonly config: AddonConfigStore) {}

  /**
   * The settings in effect, resolved fresh every call.
   *
   * NOT memoised, for the reason `AddonConfigStore.values()` and `SiteSettingsStore.read()`
   * both give: a key saved on the admin page must reach the next six-hourly sync and the
   * next poster miss, rather than the next restart.
   */
  read(): TmdbSettings {
    return {
      apiKey: text(this.config, TMDB_API_KEY_FIELD),
      // `TMDB_IMAGE_BASE_FIELD` carries the default, so this only fires if a stored row is
      // somehow not text -- treated as absent, the judgement `parseValue` already makes.
      imageBase: text(this.config, TMDB_IMAGE_BASE_FIELD) ?? TMDB_DEFAULT_IMAGE_BASE,
    };
  }
}
