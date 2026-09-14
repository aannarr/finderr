import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFS,
  hlsTrackPreferences,
  loadPrefs,
  PREFS_KEY,
  type PrefsStorage,
  parsePrefs,
  savePrefs,
  trackLanguage,
} from "./player-prefs";
import { SUBTITLES_OFF, type TrackChoices } from "./player-tracks";

function memory(initial: Record<string, string> = {}): PrefsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const choices: TrackChoices = {
  audio: [
    { index: 0, name: "Português", lang: "por" },
    { index: 1, name: "English", lang: "eng" },
  ],
  audioAt: 0,
  subtitles: [
    { index: 0, name: "Portuguese", lang: "por" },
    { index: 1, name: "English", lang: "eng" },
  ],
  subtitlesAt: SUBTITLES_OFF,
};

describe("round trip", () => {
  test("what is saved is what is loaded, merged a field at a time", () => {
    const store = memory();
    savePrefs(store, { volume: 0.4, rate: 1.25 });
    savePrefs(store, { subtitleLanguage: "eng", muted: true });
    expect(loadPrefs(store)).toEqual({
      volume: 0.4,
      muted: true,
      rate: 1.25,
      subtitleLanguage: "eng",
      audioLanguage: null,
    });
  });

  test("nothing stored is the defaults", () => {
    expect(loadPrefs(memory())).toEqual({ ...DEFAULT_PREFS });
  });
});

describe("a stored value is untrusted", () => {
  test("corrupt JSON falls back to the defaults, silently", () => {
    expect(loadPrefs(memory({ [PREFS_KEY]: "{not json" }))).toEqual({ ...DEFAULT_PREFS });
    expect(parsePrefs("[1,2,3]")).toEqual({ ...DEFAULT_PREFS });
    expect(parsePrefs("null")).toEqual({ ...DEFAULT_PREFS });
  });

  test("an out-of-range volume or speed costs that field and not the rest", () => {
    expect(parsePrefs(JSON.stringify({ volume: 7, rate: 1.5, muted: true }))).toEqual({
      ...DEFAULT_PREFS,
      rate: 1.5,
      muted: true,
    });
    expect(parsePrefs(JSON.stringify({ volume: -0.2, rate: 99 })).volume).toBe(1);
    expect(parsePrefs(JSON.stringify({ volume: "0.5" })).volume).toBe(1);
  });

  test("a language that is not a language code is no preference", () => {
    expect(parsePrefs(JSON.stringify({ subtitleLanguage: "<script>", audioLanguage: "../../x" }))).toEqual({
      ...DEFAULT_PREFS,
    });
    expect(parsePrefs(JSON.stringify({ subtitleLanguage: "off", audioLanguage: "off" }))).toMatchObject({
      subtitleLanguage: "off",
      audioLanguage: null,
    });
  });

  test("a store that throws does not take the player down", () => {
    const hostile: PrefsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadPrefs(hostile)).toEqual({ ...DEFAULT_PREFS });
    expect(savePrefs(hostile, { volume: 0.3 }).volume).toBe(0.3);
  });
});

describe("languages go to hls.js as preferences, never as a forced track", () => {
  test("a remembered language becomes hls.js's own preference option", () => {
    expect(hlsTrackPreferences({ ...DEFAULT_PREFS, subtitleLanguage: "eng", audioLanguage: "jpn" })).toEqual({
      subtitlePreference: { lang: "eng" },
      audioPreference: { lang: "jpn" },
    });
  });

  test("off and no preference hand hls.js nothing, so the server's DEFAULT=NO keeps subtitles off", () => {
    expect(hlsTrackPreferences({ ...DEFAULT_PREFS, subtitleLanguage: "off" })).toEqual({});
    expect(hlsTrackPreferences({ ...DEFAULT_PREFS })).toEqual({});
  });

  test("the language of a chosen track is what gets remembered", () => {
    expect(trackLanguage(choices.subtitles, 1)).toBe("eng");
    expect(trackLanguage(choices.subtitles, 9)).toBeNull();
  });
});
