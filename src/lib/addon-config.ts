/**
 * Per-addon configuration: what an addon DECLARES it needs, where the value lives, and the
 * one rule that decides which of the two sources wins.
 *
 * > [!IMPORTANT] ENV IS THE SEED, THE DATABASE IS THE TRUTH, AND THAT RULE HAS ONE OWNER
 * > `AddonConfigStore.resolve()` below is the only thing in the tree that resolves one of
 * > these settings -- `values()`, `reader()`, `report()`, `secrets()` and `sharedValue()` are
 * > all views of it: a key PRESENT in `kv` wins outright, an env var named by the declaration
 * > seeds it while nobody has ever set it, and the declaration's own `default` is the floor.
 * > Nothing else may spell `dbValue ?? something` for one of these -- ask this.
 *
 * That is deliberately the same rule `./site-settings.ts` established for the operator's own
 * settings, down to the consequence: once a value is saved, editing the env var stops doing
 * anything. Two files, one rule, because a setting whose winner depends on which screen asked
 * is the failure both of them exist to prevent.
 *
 * > [!CAUTION] A SECRET IS NOT A SETTING
 * > A field declared `secret` is WRITE-ONLY. `report()` says whether one is set and where it
 * > came from and never what it is, so no admin GET, no `/api/health` and no error body can
 * > carry it. `redactingLog` closes the other half: a plugin that puts its own key into a log
 * > line or throws it inside an error message gets `[redacted]` instead, because
 * > `FacetResolver` logs `err.message` on every provider failure and an addon author cannot
 * > be relied on to have thought about that.
 *
 * Stored in the app DB's `kv` table beside accounts and the first-run latch, rather than in
 * the index (rebuilt nightly and swapped in place) or a file the read-only container cannot
 * write. `addon_config:` prefixed rather than `plugin:`, which is a plugin's OWN scratch
 * space -- so an addon cannot write its own configuration through `c.kv`.
 */

import type { KeyValueStore } from "./store";

/**
 * What KIND of value a field holds, and `secret` is the one that is not a kind.
 *
 * It is a string whose HANDLING differs: write-only in the API, redacted out of logs. One
 * field rather than `type` plus a `secret` flag because there is no such thing as a secret
 * number here, and an author reading the declaration should see the whole story in one word.
 */
export type AddonConfigType = "string" | "secret" | "number" | "boolean";

/** Scalars only, the same trade `SiteSettings` makes: a form can render every one of them. */
export type AddonConfigValue = string | number | boolean;

/**
 * One value an addon needs from whoever runs it.
 *
 * DECLARED IN `meta`, so the surface is readable without executing the plugin and an admin
 * form is generated from it rather than hand-written per addon. Same argument that made the
 * provider surface declarative.
 */
export interface AddonConfigField {
  /** Namespaced by the plugin id in storage, so two addons can never collide. */
  key: string;
  type: AddonConfigType;
  /** What the admin form calls it. */
  label: string;
  /** One sentence under the control: what it is for, and where to get one. */
  description?: string;
  /**
   * Environment variable that SEEDS this field. Absent means the field has no env spelling.
   *
   * Named by the declaration rather than derived from `<PLUGIN>_<KEY>`, so an addon can keep
   * the variable a deployment already sets -- `tmdb` keeps `FINDERR_TMDB_API_KEY`, and a
   * convention would have renamed it and taken the key away from every running instance at
   * the next restart, silently, because an addon with no key goes quiet rather than failing.
   */
  env?: string;
  /** What the addon uses when nobody has configured anything. */
  default?: AddonConfigValue;
  /** Reported by `report()` as `configured: false` while it has no value. */
  required?: boolean;
}

export type AddonConfigDeclaration = readonly AddonConfigField[];

/**
 * The narrow read side an addon is handed, one accessor per kind.
 *
 * Three methods rather than one returning a union, so a provider gets a typed value without
 * an `as` cast. A key the addon never declared, or one declared as another kind, reads
 * `undefined` -- the same shape as "not configured", because to a provider it is one.
 */
export interface AddonConfig {
  /** A `string` or `secret` field. */
  string(key: string): string | undefined;
  number(key: string): number | undefined;
  boolean(key: string): boolean | undefined;
}

/** Values already in effect, keyed by the field they belong to. Absent means unconfigured. */
export type AddonConfigValues = Record<string, AddonConfigValue | undefined>;

/** Where the value in effect came from. `unset` means the addon is running without one. */
export type AddonConfigSource = "store" | "env" | "default" | "unset";

/** One field as an admin is allowed to see it. A `secret` carries no `value`, ever. */
export interface AddonConfigFieldReport {
  key: string;
  type: AddonConfigType;
  label: string;
  description?: string;
  required: boolean;
  /** Omitted for a `secret`, which is write-only. */
  value?: AddonConfigValue;
  /** Whether anything is in effect. The only thing a secret discloses about its value. */
  set: boolean;
  source: AddonConfigSource;
}

export interface AddonConfigReport {
  pluginId: string;
  fields: AddonConfigFieldReport[];
  /** Every `required` field has a value, so the addon is not running half-configured. */
  configured: boolean;
}

/**
 * A secret shorter than this is not redacted, and is refused on the way in.
 *
 * Replacing a two-character run would rewrite every log line the server ever prints, so
 * redaction has a floor -- and a floor that let an unredactable value be stored would be a
 * hole. `parseAddonConfigPatch` refuses one instead. An env-seeded secret this short is the
 * operator's own doing and is the one case that stays unredactable.
 */
export const MIN_REDACTABLE_SECRET = 4;

/** What a secret is replaced with wherever it would otherwise be printed. */
export const REDACTED = "[redacted]";

/** `addon_config:<pluginId>:<field>` -- never `plugin:`, which is the addon's own scratch. */
function keyFor(pluginId: string, field: string): string {
  return `addon_config:${pluginId}:${field}`;
}

/**
 * One stored string back into the kind its field declares, or undefined if it does not fit.
 *
 * A row that will not parse is treated as ABSENT rather than coerced, for the reason
 * `site-settings.ts` states about a corrupt quota: a coerced value is a setting nobody chose
 * and nothing on screen would explain it.
 */
function parseValue(raw: string, type: AddonConfigType): AddonConfigValue | undefined {
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "boolean") {
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return undefined;
  }
  return raw;
}

/** `"1"`/`"0"` for a boolean, matching how SQLite stores every other boolean here. */
function encodeValue(value: AddonConfigValue): string {
  return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}

/** The environment as this module reads it. Injected so a test never touches `process.env`. */
export type AddonEnv = Record<string, string | undefined>;

/**
 * Every addon's declaration and every addon's values, with one rule resolving the two.
 *
 * The declarations arrive through `declare()` as each plugin loads rather than in the
 * constructor, because the loader needs this store to BUILD a plugin's context and cannot
 * therefore hand it the declarations first. `secrets()` is the reason it keeps them: the
 * redactor has to know every configured secret in the process, not one addon's.
 */
export class AddonConfigStore {
  private readonly declarations = new Map<string, AddonConfigDeclaration>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly env: AddonEnv = process.env,
  ) {}

  /** Record what an addon says it needs. Last declaration for an id wins, as reloads do. */
  declare(pluginId: string, fields: AddonConfigDeclaration): void {
    this.declarations.set(pluginId, fields);
  }

  declarationOf(pluginId: string): AddonConfigDeclaration {
    return this.declarations.get(pluginId) ?? [];
  }

  /**
   * The values in effect for one addon, resolved fresh.
   *
   * NOT memoised, for the reason `SiteSettingsStore.read()` gives: a save must take effect
   * on the next read rather than on the next restart, and a handful of `kv` lookups against
   * an open SQLite handle is not a cost worth caching around.
   */
  values(pluginId: string): AddonConfigValues {
    const out: AddonConfigValues = {};
    for (const field of this.declarationOf(pluginId)) out[field.key] = this.resolve(pluginId, field).value;
    return out;
  }

  /**
   * One field resolved by the same rule, for a setting CORE owns and an addon SHARES.
   *
   * Everything else on this class resolves what an addon DECLARED, which is right for a
   * setting only that addon uses. The TMDB key is not one of those: the upcoming-and-trending
   * sync and the poster proxy read the same value, so core hands its own declaration in and
   * gets the same answer from the same row `c.config` reads. It asks nothing of the plugin
   * registry, which is the point -- deleting an addon file must not stop a core feature. See
   * `./tmdb-settings.ts`, the one caller and the one owner of those declarations.
   */
  sharedValue(pluginId: string, field: AddonConfigField): AddonConfigValue | undefined {
    return this.resolve(pluginId, field).value;
  }

  /** The reader handed to a plugin as `c.config`. */
  reader(pluginId: string): AddonConfig {
    const of = (key: string, kinds: readonly AddonConfigType[]) => {
      const field = this.declarationOf(pluginId).find((f) => f.key === key);
      if (!field || !kinds.includes(field.type)) return undefined;
      return this.resolve(pluginId, field).value;
    };
    return {
      string: (key) => of(key, ["string", "secret"]) as string | undefined,
      number: (key) => of(key, ["number"]) as number | undefined,
      boolean: (key) => of(key, ["boolean"]) as boolean | undefined,
    };
  }

  /**
   * Save one field, or CLEAR it with `null`.
   *
   * Clearing writes an empty row rather than deleting one, and that is the deliberate half:
   * a deleted row would put the env var back in charge of a value the operator had just
   * taken away, which is the two-owners problem this module exists to prevent. So a cleared
   * field falls back to the declaration's `default` and to nothing else.
   */
  write(pluginId: string, field: string, value: AddonConfigValue | null): void {
    this.kv.setKv(keyFor(pluginId, field), value === null ? "" : encodeValue(value));
  }

  /**
   * Every configured secret in the process, longest first, for the redactor.
   *
   * Longest first so a secret that contains another is replaced before its substring, which
   * would otherwise leave the tail of the longer one in the log.
   */
  secrets(): string[] {
    const found: string[] = [];
    for (const [pluginId, fields] of this.declarations) {
      for (const field of fields) {
        if (field.type !== "secret") continue;
        const { value } = this.resolve(pluginId, field);
        if (typeof value === "string" && value.length >= MIN_REDACTABLE_SECRET) found.push(value);
      }
    }
    return found.sort((a, b) => b.length - a.length);
  }

  /** One addon as an admin may see it. Secrets report `set` and `source`, never a value. */
  report(pluginId: string): AddonConfigReport {
    const fields = this.declarationOf(pluginId).map((field): AddonConfigFieldReport => {
      const { value, source } = this.resolve(pluginId, field);
      return {
        key: field.key,
        type: field.type,
        label: field.label,
        ...(field.description === undefined ? {} : { description: field.description }),
        required: field.required === true,
        ...(field.type === "secret" || value === undefined ? {} : { value }),
        set: value !== undefined,
        source,
      };
    });
    return {
      pluginId,
      fields,
      configured: fields.every((f) => !f.required || f.set),
    };
  }

  /** The one resolution rule. Everything public above is a view of this. */
  private resolve(
    pluginId: string,
    field: AddonConfigField,
  ): { value: AddonConfigValue | undefined; source: AddonConfigSource } {
    const stored = this.kv.getKv(keyFor(pluginId, field.key));
    // Empty means EXPLICITLY CLEARED -- present in the store, so the env seed stays out and
    // the declaration's own default is all that is left.
    if (stored === "") return this.fallback(field);
    if (stored !== null) {
      const parsed = parseValue(stored, field.type);
      if (parsed !== undefined) return { value: parsed, source: "store" };
      // A row that will not parse is treated as ABSENT, so the seed still applies -- the same
      // judgement `site-settings.ts` makes about a corrupt quota row.
    }
    const raw = field.env ? this.env[field.env] : undefined;
    if (raw !== undefined && raw !== "") {
      const parsed = parseValue(raw, field.type);
      if (parsed !== undefined) return { value: parsed, source: "env" };
    }
    return this.fallback(field);
  }

  private fallback(field: AddonConfigField): {
    value: AddonConfigValue | undefined;
    source: AddonConfigSource;
  } {
    return field.default === undefined
      ? { value: undefined, source: "unset" }
      : { value: field.default, source: "default" };
  }
}

/**
 * A stable string standing for an addon's whole configuration, for its `configVersion`.
 *
 * THIS IS THE CACHE-INVALIDATION DECISION, and it is made here rather than at write time on
 * purpose: a config change invalidates that addon's cached contributions, but only at the
 * next LOAD, never on an admin keystroke. A new API key may well return different data, so
 * the rows have to go; re-buying every row from an upstream on each character typed into a
 * form would be the cure being worse. `init` reads its config once anyway, so "takes effect
 * at the next load" is already the truth about a config change -- the version follows it.
 */
export function configFingerprint(values: AddonConfigValues): string {
  return Object.entries(values)
    .filter((entry): entry is [string, AddonConfigValue] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${encodeValue(value)}`)
    .join("\n");
}

/** Replace every known secret wherever it appears. `secrets` must be longest-first. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

/**
 * A log sink that cannot print a configured secret.
 *
 * Wrapped around the log handed to the plugin loader and to `FacetResolver`, which are the
 * two sinks an addon's own text reaches -- its `c.log` calls, and the `err.message` the
 * resolver prints when a provider throws. The secrets are read at CALL time so a key saved
 * while the server is running is redacted from the next line onwards.
 */
export function redactingLog(
  log: (message: string) => void,
  secrets: () => readonly string[],
): (message: string) => void {
  return (message) => log(redactSecrets(message, secrets()));
}

/**
 * A patch off the wire, validated once against a declaration.
 *
 * Pure, and it returns a REASON rather than a Response, the same shape as
 * `parseSiteSettingsPatch`: HTTP belongs to the route, and a rule that built its own 400
 * could not be reused by anything that is not a route. `null` clears a field; an absent key
 * leaves it alone, so a stale form cannot revert what somebody else just changed.
 */
export function parseAddonConfigPatch(
  declaration: AddonConfigDeclaration,
  raw: Record<string, unknown>,
): { patch: Map<string, AddonConfigValue | null> } | { error: string } {
  const patch = new Map<string, AddonConfigValue | null>();
  for (const [key, value] of Object.entries(raw)) {
    const field = declaration.find((f) => f.key === key);
    if (!field) return { error: `${key} is not a setting this addon declares` };
    if (value === null) {
      patch.set(key, null);
      continue;
    }
    const problem = fieldProblem(field, value);
    if (problem) return { error: problem };
    patch.set(key, value as AddonConfigValue);
  }
  return { patch };
}

/** Why this value cannot be stored in this field, or null if it can. */
function fieldProblem(field: AddonConfigField, value: unknown): string | null {
  if (field.type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? null : `${field.key} must be a number`;
  }
  if (field.type === "boolean") {
    return typeof value === "boolean" ? null : `${field.key} must be true or false`;
  }
  if (typeof value !== "string") return `${field.key} must be text`;
  // See MIN_REDACTABLE_SECRET: storing a secret we could not redact would be a hole in the
  // one promise this module makes about secrets.
  if (field.type === "secret" && value.length < MIN_REDACTABLE_SECRET) {
    return `${field.key} must be at least ${MIN_REDACTABLE_SECRET} characters`;
  }
  return null;
}
