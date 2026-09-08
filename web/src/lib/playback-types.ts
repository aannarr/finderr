/**
 * The playback plan shape, as the browser reads it.
 *
 * A structural copy of `src/lib/playback-plan.ts`'s `PlaybackPlan` rather than an import,
 * following the `decadeOf` and `personNameKey` precedent: importing the real one would be a
 * VALUE cross-import pulling a server module into this bundle, which is a build-config
 * decision rather than a tidying one.
 *
 * Unlike `personNameKey`, a divergence here is HARMLESS. Nothing on this side computes a
 * plan -- it only DISPLAYS one the server sent -- so a field this copy has not heard of is
 * simply not drawn, and a field it expects and does not get renders as absent. There is no
 * decision that can silently disagree.
 */

export type StreamAction = "copy" | "transcode";

/** How one rendition is described to a viewer, as the server decided to label it. */
export interface TrackLabel {
  name: string;
  language: string | null;
}

/**
 * What the server is doing with this file.
 *
 * `audio` and `subtitles` are LISTS because 19% of the library carries more than one audio
 * track and 53% more than one text subtitle track: every one of them is published as its own
 * HLS rendition, and the player's menu is what picks between them. `video` is null for a file
 * with no video stream, which is the audio-only case rather than an error.
 *
 * There is no subtitle `action`: a published subtitle rendition is always extracted to WebVTT,
 * and "none" is the empty list. Nothing draws a BITMAP subtitle onto the picture, so the
 * server declines those and says why in `reasons` -- see `SubtitleRendition` in
 * `src/lib/playback-plan.ts`.
 */
export interface PlaybackPlan {
  video: { action: StreamAction; sourceIndex: number; codec: string } | null;
  audio: { action: StreamAction; sourceIndex: number; codec: string; label: TrackLabel }[];
  subtitles: { sourceIndex: number; codec: string; label: TrackLabel }[];
  reasons: string[];
}

/** True when this plan re-encodes video -- the one genuinely expensive outcome. */
export function isExpensivePlan(plan: PlaybackPlan): boolean {
  return plan.video?.action === "transcode";
}

/**
 * A one-line summary of what the server is doing, for the admin strip under the player.
 *
 * Deliberately plain rather than clever: "Remuxing, re-encoding audio" is the answer to
 * "why is the NAS warm", and it is the only place that answer is visible without reading a
 * log on the box.
 *
 * It describes the DEFAULT audio rendition -- the one that plays -- and then says how many
 * others are on offer. Naming all twelve of a heavily-dubbed release here would push the
 * player's controls off the line; the full list is in the plan's own `reasons`, which the
 * stats panel draws.
 */
export function planSummary(plan: PlaybackPlan): string {
  const parts: string[] = [];
  if (plan.video) {
    parts.push(
      plan.video.action === "copy" ? `video ${plan.video.codec} copied` : `video → ${plan.video.codec}`,
    );
  }
  const audio = plan.audio[0];
  if (audio) {
    parts.push(audio.action === "copy" ? `audio ${audio.codec} copied` : `audio → ${audio.codec}`);
  }
  if (plan.audio.length > 1) parts.push(`${plan.audio.length} audio tracks`);
  if (plan.subtitles.length > 0) {
    parts.push(
      plan.subtitles.length === 1
        ? "subtitles as WebVTT"
        : `${plan.subtitles.length} subtitle tracks as WebVTT`,
    );
  }
  return parts.join(" · ");
}
