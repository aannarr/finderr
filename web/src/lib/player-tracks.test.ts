/**
 * Reading the player's offer, against the shapes hls.js actually reports.
 *
 * No hls.js here, deliberately: `TrackReader` is a structural slice, so the whole point of
 * the split is that this suite -- and the component's -- never load the 200 KB library to
 * assert what a menu should say.
 */

import { describe, expect, test } from "bun:test";
import { readTrackChoices, SUBTITLES_OFF } from "./player-tracks";

/** What hls.js reports for a film with an English default and a Japanese alternate. */
const DUBBED = {
  audioTracks: [
    { name: "English", lang: "eng" },
    { name: "Japanese", lang: "jpn" },
  ],
  audioTrack: 0,
  subtitleTracks: [
    { name: "English (forced)", lang: "eng" },
    { name: "German", lang: "ger" },
  ],
  subtitleTrack: SUBTITLES_OFF,
};

describe("what the player is offering", () => {
  test("every rendition becomes an entry, numbered as the player numbers them", () => {
    const choices = readTrackChoices(DUBBED);
    expect(choices.audio).toEqual([
      { index: 0, name: "English" },
      { index: 1, name: "Japanese" },
    ]);
    expect(choices.subtitles).toEqual([
      { index: 0, name: "English (forced)" },
      { index: 1, name: "German" },
    ]);
  });

  /** The index is what gets assigned back, so a menu that lost it could not switch anything. */
  test("it reports what the player is currently on", () => {
    expect(readTrackChoices({ ...DUBBED, audioTrack: 1 }).audioAt).toBe(1);
    expect(readTrackChoices(DUBBED).subtitlesAt).toBe(SUBTITLES_OFF);
    expect(readTrackChoices({ ...DUBBED, subtitleTrack: 1 }).subtitlesAt).toBe(1);
  });

  test("a film with one of each still reports one of each", () => {
    const choices = readTrackChoices({
      audioTracks: [{ name: "Audio" }],
      audioTrack: 0,
      subtitleTracks: [],
      subtitleTrack: SUBTITLES_OFF,
    });
    expect(choices.audio).toHaveLength(1);
    expect(choices.subtitles).toEqual([]);
  });

  /**
   * A blank entry cannot be chosen deliberately, so a manifest this server did not write --
   * reachable only by hand -- still yields something readable rather than an empty row.
   */
  test("a rendition with no name falls back to its language and then to its position", () => {
    const choices = readTrackChoices({
      audioTracks: [{ lang: "jpn" }, { name: "   " }, {}],
      audioTrack: 0,
      subtitleTracks: [],
      subtitleTrack: SUBTITLES_OFF,
    });
    expect(choices.audio.map((a) => a.name)).toEqual(["jpn", "Audio 2", "Audio 3"]);
  });
});
