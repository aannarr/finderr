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
export type SubtitleAction = "none" | "extract" | "burn";

export interface PlaybackPlan {
  video: { action: StreamAction; sourceIndex: number | null; codec: string };
  audio: { action: StreamAction; sourceIndex: number | null; codec: string };
  subtitles: { action: SubtitleAction; sourceIndex: number | null };
  reasons: string[];
}

/** True when this plan re-encodes video -- the one genuinely expensive outcome. */
export function isExpensivePlan(plan: PlaybackPlan): boolean {
  return plan.video.action === "transcode";
}

/**
 * A one-line summary of what the server is doing, for the admin strip under the player.
 *
 * Deliberately plain rather than clever: "Remuxing, re-encoding audio" is the answer to
 * "why is the NAS warm", and it is the only place that answer is visible without reading a
 * log on the box.
 */
export function planSummary(plan: PlaybackPlan): string {
  const parts: string[] = [];
  parts.push(
    plan.video.action === "copy" ? `video ${plan.video.codec} copied` : `video → ${plan.video.codec}`,
  );
  parts.push(
    plan.audio.action === "copy" ? `audio ${plan.audio.codec} copied` : `audio → ${plan.audio.codec}`,
  );
  if (plan.subtitles.action === "burn") parts.push("subtitles burned in");
  if (plan.subtitles.action === "extract") parts.push("subtitles as WebVTT");
  return parts.join(" · ");
}
