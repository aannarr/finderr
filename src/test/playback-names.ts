/**
 * Published-name helpers the playback tests share.
 *
 * `initFileName` answers null for a rendition that has no initialisation segment -- WebVTT
 * subtitles -- and three test files assert against renditions that DO have one. Asserting
 * that through a cast would smuggle the null past the compiler; asking once, here, keeps it a
 * real answer everywhere else and turns "this rendition suddenly has no init" into a named
 * failure rather than a confusing `null` in an expectation.
 */

import { initFileName, type Track } from "../lib/hls-timeline";

/** The init name of a rendition that has one. Throws for one that does not. */
export function initName(track: Track, index: number): string {
  const name = initFileName(track, index);
  if (name === null) throw new Error(`the ${track} rendition publishes no initialisation segment`);
  return name;
}
