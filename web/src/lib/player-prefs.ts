/**
 * What the player remembers between plays: volume, mute, speed, and which languages to pick.
 *
 * PURE apart from the storage handed in, so every rule here is tested with an object literal.
 * `localStorage` rather than the server because these are properties of a DEVICE -- the volume
 * that is right on a laptop is wrong on a television -- and the server-side watch state is the
 * per-USER half (resume position lives there, not here).
 *
 * > [!IMPORTANT] A STORED VALUE IS UNTRUSTED INPUT, and it fails to the defaults, silently
 * > The key is versioned, but a value from an older build, a hand edit, or a browser extension
 * > can still hold anything. Every field is validated on its own, so one bad field costs that
 * > field and not the rest -- and nothing here ever throws into the player.
 *
 * A language preference NEVER FORCES a track the title does not have. A stored `eng` against a
 * title with only Portuguese subtitles changes nothing: subtitles stay off rather than switching
 * on in a language nobody chose.
 */

import { SUBTITLES_OFF, type TrackChoices, type TrackOption } from "./player-tracks";

/** Versioned, so a future shape can be read side by side with this one rather than misread. */
export const PREFS_KEY = "finderr.player.prefs.v1";

export interface PlayerPrefs {
  /** 0-1. */
  volume: number;
  muted: boolean;
  rate: number;
  /** A language code, `"off"` for subtitles deliberately turned off, or null for no preference. */
  subtitleLanguage: string | null;
  audioLanguage: string | null;
}

export const DEFAULT_PREFS: Readonly<PlayerPrefs> = {
  volume: 1,
  muted: false,
  rate: 1,
  subtitleLanguage: null,
  audioLanguage: null,
};

/** The speed menu offers 0.5-2x; a little wider is accepted so a browser's own menu is not refused. */
const RATE_MIN = 0.25;
const RATE_MAX = 4;

/** ISO 639 and BCP 47-ish: `en`, `eng`, `pt-br`. Nothing that could be markup or a path. */
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

const languageOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const folded = value.trim().toLowerCase();
  // "off" is three letters and would pass the pattern; it is a subtitle STATE, handled by the
  // caller that allows it, and never a language.
  return folded !== "off" && LANGUAGE.test(folded) ? folded : null;
};

/** A stored string as prefs, every field checked on its own. Never throws. */
export function parsePrefs(raw: string | null | undefined): PlayerPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_PREFS };
  const o = parsed as Record<string, unknown>;
  const within = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  return {
    volume: within(o.volume, 0, 1, DEFAULT_PREFS.volume),
    muted: typeof o.muted === "boolean" ? o.muted : DEFAULT_PREFS.muted,
    rate: within(o.rate, RATE_MIN, RATE_MAX, DEFAULT_PREFS.rate),
    subtitleLanguage: o.subtitleLanguage === "off" ? "off" : languageOf(o.subtitleLanguage),
    audioLanguage: languageOf(o.audioLanguage),
  };
}

export type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The browser's storage, or null where there is none.
 *
 * Reading `localStorage` itself can THROW -- Safari with storage blocked, a sandboxed frame -- so
 * even the lookup is guarded. Null means "remember nothing", and the player plays at defaults.
 */
export function safeStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPrefs(storage: PrefsStorage | null = safeStorage()): PlayerPrefs {
  try {
    return parsePrefs(storage?.getItem(PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Merge a change into what is stored and write it back. Returns what is now in effect. */
export function savePrefs(storage: PrefsStorage | null, patch: Partial<PlayerPrefs>): PlayerPrefs {
  // Through `parsePrefs`, so a bad value handed in is refused exactly as a bad value read back would be.
  const next = parsePrefs(JSON.stringify({ ...loadPrefs(storage), ...patch }));
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Quota or a blocked store. The preference simply is not remembered.
  }
  return next;
}

/** The language of the option at `index`, if the manifest named one. */
export function trackLanguage(options: readonly TrackOption[] | undefined, index: number): string | null {
  return languageOf(options?.find((o) => o.index === index)?.lang);
}

/**
 * The subtitle track the preference asks for, or null to leave the player as it is.
 *
 * `"off"` asks for off. A language with no matching track answers null -- never "the first one".
 */
export function preferredSubtitle(choices: TrackChoices, language: string | null): number | null {
  if (language === null) return null;
  if (language === "off") return SUBTITLES_OFF;
  return choices.subtitles.find((o) => languageOf(o.lang) === language)?.index ?? null;
}

/** The audio track the preference asks for, or null to leave the player on its default. */
export function preferredAudio(choices: TrackChoices, language: string | null): number | null {
  if (language === null) return null;
  return choices.audio.find((o) => languageOf(o.lang) === language)?.index ?? null;
}
