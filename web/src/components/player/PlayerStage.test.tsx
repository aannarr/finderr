/**
 * What the full-window player DOES: auto-hide, what pins the chrome, the keys, the Escape order,
 * and that the page behind it goes quiet.
 *
 * The `<video>` is real (happy-dom's) with its media state replaced by a small fake, because
 * happy-dom plays nothing: `play()` would never flip `paused` and `currentTime` would never move.
 * The fake dispatches the same events a browser does, so `useVideoState` is exercised as written.
 */

import { describe, expect, mock, test } from "bun:test";
import { useCallback, useState } from "react";
import type { PlaybackSession } from "../../lib/playback-api";
import { SUBTITLES_OFF, type TrackChoices } from "../../lib/player-tracks";
import { type FakeClock, fakeTimers } from "../../test/fake-timers";
import { act, fireEvent, render, screen } from "../../test/interact";
import { useKeyAction } from "../Kbd";
import { PlayerStage } from "./PlayerStage";

const session = {
  sessionId: "s1",
  playlist: "/api/play/s/s1/index.m3u8",
  durationSec: 600,
  segments: 100,
  plan: { video: null, audio: [], subtitles: [], reasons: [] },
} as unknown as PlaybackSession;

interface FakeMedia {
  buffered: [number, number][];
}

/** Replace the element's media state with one that behaves, and says so with real events. */
function fakeMedia(el: HTMLVideoElement, media: FakeMedia) {
  const s = { paused: true, currentTime: 0, volume: 1, muted: false, rate: 1 };
  const fire = (...names: string[]) => {
    for (const n of names) el.dispatchEvent(new Event(n));
  };
  const define = (key: string, get: () => unknown, set?: (v: never) => void) =>
    Object.defineProperty(el, key, { configurable: true, get, set });
  define("paused", () => s.paused);
  define("ended", () => false);
  define("duration", () => 600);
  define("readyState", () => 4);
  define("buffered", () => ({
    length: media.buffered.length,
    start: (i: number) => media.buffered[i]?.[0] ?? 0,
    end: (i: number) => media.buffered[i]?.[1] ?? 0,
  }));
  define(
    "currentTime",
    () => s.currentTime,
    (v: number) => {
      s.currentTime = v;
      fire("seeked", "timeupdate");
    },
  );
  define(
    "volume",
    () => s.volume,
    (v: number) => {
      s.volume = v;
      fire("volumechange");
    },
  );
  define(
    "muted",
    () => s.muted,
    (v: boolean) => {
      s.muted = v;
      fire("volumechange");
    },
  );
  define(
    "playbackRate",
    () => s.rate,
    (v: number) => {
      s.rate = v;
      fire("ratechange");
    },
  );
  el.play = () => {
    s.paused = false;
    fire("play", "playing");
    return Promise.resolve();
  };
  el.pause = () => {
    s.paused = true;
    fire("pause");
  };
  return s;
}

function renderStage(
  opts: { tracks?: TrackChoices | null; onClose?: () => void; buffered?: [number, number][] } = {},
) {
  const clock: FakeClock = fakeTimers();
  const media: FakeMedia = { buffered: opts.buffered ?? [] };
  let state: ReturnType<typeof fakeMedia> | null = null;
  function Harness() {
    const [video, setVideo] = useState<HTMLVideoElement | null>(null);
    const attach = useCallback((el: HTMLVideoElement | null) => {
      if (el) state = fakeMedia(el, media);
      setVideo(el);
    }, []);
    return (
      <PlayerStage
        title="Sintel"
        session={session}
        video={video}
        attachVideo={attach}
        tracks={opts.tracks ?? null}
        onAudio={() => {}}
        onSubtitles={() => {}}
        fatal={null}
        readBrowserStats={() => null}
        onClose={opts.onClose ?? (() => {})}
        timers={clock.timers}
      />
    );
  }
  const view = render(<Harness />);
  const stage = () => screen.getByTestId("player-stage");
  const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k }));
  const media$ = () => {
    if (!state) throw new Error("video not attached");
    return state;
  };
  return {
    clock,
    view,
    stage,
    key,
    media: media$,
    fire: (n: string) => act(() => void stage().querySelector("video")?.dispatchEvent(new Event(n))),
  };
}

const withSubtitles: TrackChoices = {
  audio: [{ index: 0, name: "English" }],
  audioAt: 0,
  subtitles: [{ index: 0, name: "English" }],
  subtitlesAt: SUBTITLES_OFF,
};

describe("the chrome never squats", () => {
  test("it hides after the idle delay while playing, and a pointer move brings it back", () => {
    const p = renderStage();
    p.key("k");
    expect(p.stage().dataset.chrome).toBe("shown");
    act(() => p.clock.advance(2_500));
    expect(p.stage().dataset.chrome).toBe("hidden");
    act(() => void fireEvent.pointerMove(p.stage(), { pointerType: "mouse" }));
    expect(p.stage().dataset.chrome).toBe("shown");
  });

  test("pausing pins it however long nobody moves", () => {
    const p = renderStage();
    p.key("k");
    p.key("k");
    act(() => p.clock.advance(10_000));
    expect(p.media().paused).toBe(true);
    expect(p.stage().dataset.chrome).toBe("shown");
  });

  test("an open menu pins it while playing", () => {
    const p = renderStage({ tracks: withSubtitles });
    p.key("k");
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Subtitles" })));
    act(() => p.clock.advance(10_000));
    expect(screen.getByRole("menu", { name: "Subtitles" })).toBeTruthy();
    expect(p.stage().dataset.chrome).toBe("shown");
  });

  test("a touch on the frame toggles the chrome and never playback", () => {
    const p = renderStage();
    p.key("k");
    const surface = screen.getByTestId("player-surface");
    act(() => void fireEvent.pointerUp(surface, { pointerType: "touch" }));
    expect(p.stage().dataset.chrome).toBe("hidden");
    expect(p.media().paused).toBe(false);
  });
});

describe("the seek bar", () => {
  test("draws every buffered range from the element, not only the one under the playhead", () => {
    const p = renderStage({
      buffered: [
        [0, 60],
        [300, 360],
      ],
    });
    p.fire("progress");
    const drawn = screen.getAllByTestId("buffered-range");
    expect(drawn).toHaveLength(2);
    expect(Number.parseFloat(drawn[1]?.style.left ?? "")).toBeCloseTo(50);
    expect(Number.parseFloat(drawn[1]?.style.width ?? "")).toBeCloseTo(10);
  });

  test("is a slider a screen reader can read, and Page Up moves it a minute", () => {
    const p = renderStage();
    // Through the ELEMENT, so the `seeked` event fires the way a browser's would.
    act(() => {
      const video = p.stage().querySelector("video");
      if (video) video.currentTime = 125;
    });
    const slider = screen.getByRole("slider", { name: "Seek" });
    expect(slider.getAttribute("aria-valuetext")).toBe("2 minutes 5 seconds of 10 minutes");
    act(() => void fireEvent.keyDown(slider, { key: "PageUp" }));
    expect(p.media().currentTime).toBe(185);
  });
});

describe("the keys drive the element", () => {
  test("j and l skip ten seconds, k plays and pauses, m mutes", () => {
    const p = renderStage();
    act(() => {
      p.media().currentTime = 100;
    });
    p.key("l");
    expect(p.media().currentTime).toBe(110);
    p.key("j");
    p.key("j");
    expect(p.media().currentTime).toBe(90);
    p.key("k");
    expect(p.media().paused).toBe(false);
    p.key("m");
    expect(p.media().muted).toBe(true);
    // Every action says what it did, on screen and to a screen reader.
    expect(screen.getAllByText("Muted").length).toBeGreaterThan(0);
  });

  test("f asks for fullscreen on the STAGE, so our controls go with it", () => {
    const p = renderStage();
    const request = mock(() => Promise.resolve());
    (p.stage() as HTMLElement & { requestFullscreen: unknown }).requestFullscreen = request;
    p.key("f");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("the title page's own keys go quiet while the player is open", () => {
    const seasonStep = mock(() => {});
    function Page() {
      useKeyAction("prevSeason", seasonStep);
      return null;
    }
    const page = render(<Page />);
    const p = renderStage();
    act(() => {
      p.media().currentTime = 100;
    });
    p.key("ArrowLeft");
    expect(p.media().currentTime).toBe(95);
    expect(seasonStep).not.toHaveBeenCalled();

    p.view.unmount();
    act(() => void fireEvent.keyDown(window, { key: "ArrowLeft" }));
    expect(seasonStep).toHaveBeenCalledTimes(1);
    page.unmount();
  });
});

describe("Escape peels one layer at a time", () => {
  test("the shortcut overlay first, then the player", () => {
    const onClose = mock(() => {});
    const p = renderStage({ onClose });
    p.key("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    p.key("Escape");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    p.key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("an open menu before the player", () => {
    const onClose = mock(() => {});
    const p = renderStage({ tracks: withSubtitles, onClose });
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Subtitles" })));
    p.key("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("in fullscreen the browser's own Escape exits fullscreen and the player stays open", () => {
    const onClose = mock(() => {});
    const p = renderStage({ onClose });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => p.stage() });
    p.key("Escape");
    expect(onClose).not.toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
  });

  test("the overlay is rendered from the keymap", () => {
    const p = renderStage();
    p.key("?");
    const overlay = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(overlay.textContent).toContain("Back / forward 10 s");
    expect(overlay.textContent).toContain("0-9");
  });
});
