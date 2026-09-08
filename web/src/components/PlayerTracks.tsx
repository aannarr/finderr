/**
 * Picking which audio and which subtitles to hear, under the player.
 *
 * It exists because the browser's own controls do not offer the choice -- Chromium and
 * Firefox draw no audio-track menu at all, only Safari does -- while the server now publishes
 * every audio and subtitle track the file carries as its own HLS rendition. See
 * `player-tracks.ts` for the measurement behind that.
 *
 * Deliberately a plain `<select>` rather than the design-system `Select` used on the invites
 * page: this sits INSIDE a `role="dialog"` overlay that already owns focus and Escape, and a
 * portalled popup inside a modal is where focus-trap bugs live. Two native controls in a
 * muted strip is also what a video player's track menu looks like everywhere else.
 */

import { useId } from "react";
import { SUBTITLES_OFF, type TrackChoices, type TrackOption } from "../lib/player-tracks";

export function PlayerTracks({
  choices,
  onAudio,
  onSubtitles,
}: {
  choices: TrackChoices;
  onAudio: (index: number) => void;
  onSubtitles: (index: number) => void;
}) {
  const id = useId();
  // Audio is offered only when there is a choice to MAKE -- a lone track is an answer, not a
  // menu. Subtitles are offered whenever there is one at all, because "off" is the other half
  // of that choice and the server publishes them switched off.
  const chooseAudio = choices.audio.length > 1;
  const chooseSubtitles = choices.subtitles.length > 0;
  if (!chooseAudio && !chooseSubtitles) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {chooseAudio ? (
        <TrackSelect
          id={`${id}-audio`}
          label="Audio"
          options={choices.audio}
          value={choices.audioAt}
          onChange={onAudio}
        />
      ) : null}
      {chooseSubtitles ? (
        <TrackSelect
          id={`${id}-subtitles`}
          label="Subtitles"
          options={choices.subtitles}
          value={choices.subtitlesAt}
          onChange={onSubtitles}
          offLabel="Off"
        />
      ) : null}
    </div>
  );
}

/**
 * One rendition menu.
 *
 * `offLabel` is the whole difference between the two, so it is a PROP rather than a second
 * component: subtitles can be turned off and audio cannot, and everything else about the two
 * controls is the same.
 */
function TrackSelect({
  id,
  label,
  options,
  value,
  onChange,
  offLabel,
}: {
  id: string;
  label: string;
  options: TrackOption[];
  value: number;
  onChange: (index: number) => void;
  offLabel?: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {/* `htmlFor`/`id` rather than wrapping the control, which is what an accessibility tree
          can actually follow -- the same rule `RequestOptions` states. */}
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-ink"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {offLabel ? <option value={SUBTITLES_OFF}>{offLabel}</option> : null}
        {options.map((option) => (
          <option key={option.index} value={option.index}>
            {option.name}
          </option>
        ))}
      </select>
    </span>
  );
}
