/**
 * The track menus under the player.
 *
 * They DO rather than draw -- picking an entry has to reach hls.js -- so this drives a real
 * DOM through `interact` rather than asserting static markup. The control that renders but
 * calls nothing is exactly the failure a markup snapshot cannot see.
 */

import { describe, expect, test } from "bun:test";
import { SUBTITLES_OFF, type TrackChoices } from "../lib/player-tracks";
import { fireEvent, render, screen } from "../test/interact";
import { PlayerTracks } from "./PlayerTracks";

const DUBBED: TrackChoices = {
  audio: [
    { index: 0, name: "English" },
    { index: 1, name: "Japanese" },
  ],
  audioAt: 0,
  subtitles: [
    { index: 0, name: "English (forced)" },
    { index: 1, name: "German" },
  ],
  subtitlesAt: SUBTITLES_OFF,
};

const noop = () => {};

describe("what the menus offer", () => {
  test("every rendition is listed by the name the manifest gave it", () => {
    render(<PlayerTracks choices={DUBBED} onAudio={noop} onSubtitles={noop} />);

    for (const name of ["English", "Japanese", "English (forced)", "German"]) {
      expect(screen.getByRole("option", { name })).toBeTruthy();
    }
  });

  /** A menu of one is not a choice, and drawing it is clutter on the ~81% of films with one. */
  test("a lone audio track is not offered as a menu", () => {
    render(
      <PlayerTracks
        choices={{ ...DUBBED, audio: [{ index: 0, name: "English" }] }}
        onAudio={noop}
        onSubtitles={noop}
      />,
    );
    expect(screen.queryByLabelText("Audio")).toBeNull();
    expect(screen.getByLabelText("Subtitles")).toBeTruthy();
  });

  /**
   * ONE subtitle track IS a choice, because the other half of it is "off" -- the server
   * publishes them unselected, so a viewer who wants them has nowhere else to ask.
   */
  test("a lone subtitle track is still offered, with the way back out", () => {
    render(
      <PlayerTracks
        choices={{ ...DUBBED, subtitles: [{ index: 0, name: "German" }] }}
        onAudio={noop}
        onSubtitles={noop}
      />,
    );
    expect(screen.getByRole("option", { name: "Off" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "German" })).toBeTruthy();
  });

  test("a film with nothing to choose draws nothing at all", () => {
    const { container } = render(
      <PlayerTracks
        choices={{
          audio: [{ index: 0, name: "English" }],
          audioAt: 0,
          subtitles: [],
          subtitlesAt: SUBTITLES_OFF,
        }}
        onAudio={noop}
        onSubtitles={noop}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("the menus show what the player is currently on", () => {
    render(
      <PlayerTracks choices={{ ...DUBBED, audioAt: 1, subtitlesAt: 0 }} onAudio={noop} onSubtitles={noop} />,
    );
    expect((screen.getByLabelText("Audio") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Subtitles") as HTMLSelectElement).value).toBe("0");
  });
});

describe("picking one", () => {
  /** A NUMBER, because that is what is assigned to `hls.audioTrack`; a string switches nothing. */
  test("choosing an audio track reports its index", () => {
    const picked: number[] = [];
    render(<PlayerTracks choices={DUBBED} onAudio={(i) => picked.push(i)} onSubtitles={noop} />);

    fireEvent.change(screen.getByLabelText("Audio"), { target: { value: "1" } });

    expect(picked).toEqual([1]);
  });

  test("choosing a subtitle track reports its index", () => {
    const picked: number[] = [];
    render(<PlayerTracks choices={DUBBED} onAudio={noop} onSubtitles={(i) => picked.push(i)} />);

    fireEvent.change(screen.getByLabelText("Subtitles"), { target: { value: "1" } });

    expect(picked).toEqual([1]);
  });

  /** Turning them off is a real selection and must reach the player, not just blank the menu. */
  test("choosing Off reports the sentinel the player understands", () => {
    const picked: number[] = [];
    render(
      <PlayerTracks
        choices={{ ...DUBBED, subtitlesAt: 0 }}
        onAudio={noop}
        onSubtitles={(i) => picked.push(i)}
      />,
    );

    fireEvent.change(screen.getByLabelText("Subtitles"), { target: { value: String(SUBTITLES_OFF) } });

    expect(picked).toEqual([SUBTITLES_OFF]);
  });
});
