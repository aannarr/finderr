/**
 * Which audio and subtitle renditions the player is offering, and which one it is on.
 *
 * > [!IMPORTANT] THE BROWSER'S OWN CONTROLS ARE NOT ENOUGH, and that is why this exists
 * > The card that asked for track selection assumed the player's native menu would do it for
 * > free, because HLS models alternate renditions natively. That is true for SUBTITLES --
 * > every browser draws a captions menu from the text tracks hls.js creates -- and it is
 * > FALSE for audio: **Chromium's default `<video controls>` has no audio-track control at
 * > all**, and neither does Firefox's. Only Safari's does. So a film with an English track
 * > and a Japanese one would be published correctly and remain unswitchable for most readers.
 * >
 * > hls.js exposes the renditions as `audioTracks`/`subtitleTracks` and switches on a plain
 * > assignment, so what is missing is a control rather than a mechanism.
 *
 * PURE and free of hls.js: it reads a structural slice of the player and answers plain data,
 * so the component can be driven by an object literal in a test. The native (iOS Safari) path
 * has no hls.js instance to read and needs none -- Safari's own menu handles both kinds.
 */

/** One rendition a viewer can pick, as the player numbers it. */
export interface TrackOption {
  /** What is assigned to `audioTrack` / `subtitleTrack` to select it. */
  index: number;
  /** The `NAME` the master playlist gave it. */
  name: string;
}

/** What `subtitleTrack` is set to for "no subtitles". hls.js's own sentinel. */
export const SUBTITLES_OFF = -1;

/** What the player is offering right now, and what it is currently on. */
export interface TrackChoices {
  audio: TrackOption[];
  /** Index of the selected audio rendition. */
  audioAt: number;
  subtitles: TrackOption[];
  /** Index of the selected subtitle rendition, or `SUBTITLES_OFF`. */
  subtitlesAt: number;
}

/**
 * The slice of an hls.js instance this reads.
 *
 * Structural rather than an hls.js import: the whole point of the split is that neither this
 * module nor its test needs the 200 KB library, and the day it renames a field the failure is
 * one compile error here instead of a silent empty menu.
 */
export interface TrackReader {
  audioTracks: readonly PlayerRendition[];
  audioTrack: number;
  subtitleTracks: readonly PlayerRendition[];
  subtitleTrack: number;
}

/** One rendition as hls.js reports it, narrowed to what a menu entry needs. */
interface PlayerRendition {
  name?: string;
  lang?: string;
}

/**
 * Read the player's current offer.
 *
 * Called on every track event rather than once, because hls.js populates these lists when it
 * parses the manifest -- which is after the instance exists -- and then again whenever a
 * switch completes.
 */
export function readTrackChoices(player: TrackReader): TrackChoices {
  return {
    audio: optionsOf(player.audioTracks, "Audio"),
    audioAt: player.audioTrack,
    subtitles: optionsOf(player.subtitleTracks, "Subtitles"),
    subtitlesAt: player.subtitleTrack,
  };
}

/**
 * Turn the player's renditions into menu entries.
 *
 * The `NAME` from the manifest is the answer in every real case -- the server derives it from
 * the container's own title, language and forced/SDH flags. The two fallbacks are for a
 * manifest this server did not write, which is only reachable by hand, and they exist so an
 * entry is never blank: a menu row with no text cannot be chosen deliberately.
 */
function optionsOf(renditions: readonly PlayerRendition[], noun: string): TrackOption[] {
  return renditions.map((rendition, index) => ({
    index,
    name: rendition.name?.trim() || rendition.lang?.trim() || `${noun} ${index + 1}`,
  }));
}
