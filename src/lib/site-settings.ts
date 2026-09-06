/**
 * The settings an OPERATOR changes, as opposed to the ones a deployment fixes.
 *
 * > [!IMPORTANT] ENV IS THE SEED, THE DATABASE IS THE TRUTH, AND THAT RULE HAS ONE OWNER
 * > Every value here is readable from two places, and two readers that each pick a winner is
 * > exactly how a setting starts behaving differently depending on which screen asked. So
 * > `read()` below is the only thing in the tree that resolves it: a key PRESENT in `kv` wins
 * > outright, and the env-derived seed applies only while nobody has ever set it. Nothing
 * > else may spell `dbValue ?? cfg.something` -- ask this.
 *
 * The consequence worth stating: once an operator saves a value, editing the env var stops
 * doing anything. That is the intended trade -- a setting you can change from the admin page
 * cannot also be one a container restart silently overrules -- and it is why the admin page
 * says so beside each control.
 *
 * Backed by the existing `kv` table rather than a table of its own. These are a handful of
 * scalars about the SERVER, which is the same shape as the first-run latch and the Plex
 * machine id already stored there; a two-column table holding two rows would be a migration
 * and a second store for no gain.
 */

import type { Config } from "./config";
import { isQuotaValue } from "./request-quota";
import type { KeyValueStore } from "./store";

/**
 * What an operator may set for the whole deployment.
 *
 * Deliberately small and deliberately flat: every field is a scalar with a default that
 * keeps today's behaviour, so a deployment that never opens the admin page is unaffected by
 * this file existing.
 */
export interface SiteSettings {
  /**
   * Titles per UTC day for somebody with no override of their own. Zero is unlimited.
   *
   * The FALLBACK, never the effective limit: `quotaLimitFor` in `./request-quota.ts` resolves
   * a person's own override against this one, and it stays the only place that does.
   */
  requestQuotaPerDay: number;
  /**
   * What a NEW account's assistant switch starts at.
   *
   * > [!NOTE] It is a CREATION default and not a fallback, which is the one place this field
   * > differs from the quota above
   * > `app_user.assistant_allowed` is `not null default 1` -- it has no "no opinion" state
   * > for a site value to fall back into, and giving it one means rebuilding the table, which
   * > this codebase's migration mechanism (`addMissingColumns`) deliberately does not do. So
   * > turning this off stops NEW invitees from getting the assistant and leaves everybody who
   * > already has it alone. The admin page says exactly that beside the control, because it
   * > is the surprising half.
   */
  assistantAllowedByDefault: boolean;
}

/**
 * The `kv` keys. `site_` prefixed so the family is legible in a `select * from kv`, and
 * snake_case to match `first_run_closed_at` and `plex_machine_identifier` beside them.
 */
const KEYS = {
  requestQuotaPerDay: "site_request_quota_per_day",
  assistantAllowedByDefault: "site_assistant_allowed_by_default",
} as const;

/**
 * What a deployment that has never saved a setting behaves like.
 *
 * `requestQuotaPerDay` is seeded from `FINDERR_REQUEST_QUOTA_PER_DAY`, which is where it
 * lived before this file. `assistantAllowedByDefault` has no env var and gains none: it
 * restates `app_user.assistant_allowed`'s column default, and inventing a second spelling of
 * a value nothing reads from the environment would be a config key that is a lie.
 */
export function siteSettingsSeed(cfg: Config): SiteSettings {
  return { requestQuotaPerDay: cfg.requests.quotaPerDay, assistantAllowedByDefault: true };
}

/**
 * The narrow read side, which is all any consumer of a setting needs.
 *
 * Every reader in the request path -- the quota check, the admin user page, the assistant's
 * request tool -- depends on THIS rather than on the store, so a test hands them an object
 * literal and nothing has to stand up a database to assert a limit.
 */
export interface SiteSettingsReader {
  read(): SiteSettings;
}

/** `"1"`/`"0"` on the way to `kv`, matching how SQLite stores every other boolean here. */
function readBool(raw: string | null): boolean | null {
  if (raw === null) return null;
  return raw === "1";
}

function readInt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  // A row that is not a number is treated as absent rather than as zero: zero is UNLIMITED
  // here, so coercing a corrupt value into it would silently remove the operator's limit.
  return Number.isInteger(n) ? n : null;
}

export class SiteSettingsStore implements SiteSettingsReader {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly seed: SiteSettings,
  ) {}

  /**
   * The effective settings, resolved fresh every call.
   *
   * NOT memoised, and that is the point: an operator saving on `/admin` must take effect on
   * the next request rather than on the next restart, and two `kv` lookups against an open
   * SQLite handle is not a cost worth caching around.
   */
  read(): SiteSettings {
    return {
      requestQuotaPerDay: readInt(this.kv.getKv(KEYS.requestQuotaPerDay)) ?? this.seed.requestQuotaPerDay,
      assistantAllowedByDefault:
        readBool(this.kv.getKv(KEYS.assistantAllowedByDefault)) ?? this.seed.assistantAllowedByDefault,
    };
  }

  /** Save the fields present in `patch` and answer with the settings as they now stand. */
  write(patch: Partial<SiteSettings>): SiteSettings {
    if (patch.requestQuotaPerDay !== undefined) {
      this.kv.setKv(KEYS.requestQuotaPerDay, String(patch.requestQuotaPerDay));
    }
    if (patch.assistantAllowedByDefault !== undefined) {
      this.kv.setKv(KEYS.assistantAllowedByDefault, patch.assistantAllowedByDefault ? "1" : "0");
    }
    return this.read();
  }
}

/**
 * A settings patch off the wire, validated once.
 *
 * Pure, and it returns a REASON rather than a Response: HTTP belongs to the route, and a
 * rule that built its own 400 could not be reused by anything that is not a route. An absent
 * field is left alone -- there is no "clear back to the env" verb, because a setting that
 * could be un-set would put the env back in charge of a value the operator had deliberately
 * taken over, which is the two-owners problem this module exists to prevent.
 */
export function parseSiteSettingsPatch(
  raw: Record<string, unknown>,
): { patch: Partial<SiteSettings> } | { error: string } {
  const patch: Partial<SiteSettings> = {};
  if (raw.requestQuotaPerDay !== undefined) {
    // The same rule the per-user override is held to, from the same owner -- an operator who
    // may type 2.5 into one field and not the other is reading two different products.
    if (!isQuotaValue(raw.requestQuotaPerDay)) {
      return { error: "requestQuotaPerDay must be a whole number of 0 or more" };
    }
    patch.requestQuotaPerDay = raw.requestQuotaPerDay;
  }
  if (raw.assistantAllowedByDefault !== undefined) {
    if (typeof raw.assistantAllowedByDefault !== "boolean") {
      return { error: "assistantAllowedByDefault must be true or false" };
    }
    patch.assistantAllowedByDefault = raw.assistantAllowedByDefault;
  }
  return { patch };
}
