/**
 * The full-window player: the film fills the window and every control is ours.
 *
 * Judged against the comp in `.claude/docs/player-comp/` -- read its README for why each element
 * exists before adding one. The session, hls.js and the element's source are `usePlayHere`'s;
 * this component owns what the viewer SEES and PRESSES, and reads the element for every drawn
 * value (`useVideoState`) rather than keeping a copy that Safari's media keys would falsify.
 *
 * ## The rules that are easy to break
 *
 * - **The chrome never squats.** It hides after `IDLE_HIDE_MS` without pointer movement while
 *   playing, with the cursor, and it is PINNED by every state in `chromeVisible`'s `pinned` --
 *   paused, ended, scrubbing, a menu or the help open, keyboard focus in the bar, an error.
 * - **Touch never toggles play.** A tap shows or hides the chrome; a mouse click on the frame
 *   toggles play and a double-click toggles fullscreen, which is YouTube's contract.
 * - **Fullscreen is the STAGE, not the `<video>`**, so our controls go fullscreen with it. iOS has
 *   no element fullscreen at all and gets the video's native one (`webkitEnterFullscreen`).
 * - **The keyboard is CLAIMED, not swallowed** (`keyboard-claim.ts`), so the title page's ←/→ and
 *   Escape go quiet while React handlers inside the player -- the menus, the volume slider --
 *   keep working.
 * - **Escape peels one layer**: the help, then a menu, and only then the player. In fullscreen the
 *   browser consumes Escape to exit fullscreen itself, and this does not double-handle it.
 */

import {
  Activity,
  AudioLines,
  Captions,
  CircleAlert,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { claimKeyboard } from "../../lib/keyboard-claim";
import { HOST_PLATFORM, type KeyTarget, playerActionFor, playerGlyph } from "../../lib/keymap";
import { detectCapabilities, type PlaybackSession } from "../../lib/playback-api";
import { playbackReport } from "../../lib/playback-report";
import type { BrowserStats } from "../../lib/playback-telemetry";
import {
  ARROW_SEC,
  audioFeedback,
  bufferedSpans,
  chromeVisible,
  clampTime,
  clampVolume,
  DEFAULT_FRAME_SEC,
  FEEDBACK_MS,
  IDLE_HIDE_MS,
  nextAudioTrack,
  percentTime,
  SKIP_SEC,
  SPEEDS,
  skipFeedback,
  speedFeedback,
  speedLabel,
  stepSpeed,
  subtitlesFeedback,
  timeReadout,
  toggledSubtitles,
  VOLUME_STEP,
  volumeFeedback,
} from "../../lib/player-controls";
import { loadPrefs, safeStorage, savePrefs } from "../../lib/player-prefs";
import { SUBTITLES_OFF, type TrackChoices } from "../../lib/player-tracks";
import { realTimers, type Timers } from "../../lib/timers";
import { useVideoState, type VideoState } from "../../lib/use-video-state";
import { cn } from "../../lib/utils";
import { CopyReport, PlayerStats } from "../PlayerStats";
import { ControlButton, PlayerMenu } from "./PlayerMenu";
import { SeekBar } from "./SeekBar";
import { ShortcutOverlay } from "./ShortcutOverlay";

type MenuName = "subtitles" | "audio" | "speed" | "more";

/** The vendor-prefixed fullscreen API Safari still ships beside the standard one. */
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

const fullscreenElement = (): Element | null =>
  document.fullscreenElement ?? (document as FullscreenDocument).webkitFullscreenElement ?? null;

export interface PlayerStageProps {
  title: string;
  /** `S1E3 · Episode name` for an episode, drawn under the title. */
  episodeLabel?: string | null;
  session: PlaybackSession;
  video: HTMLVideoElement | null;
  attachVideo: (el: HTMLVideoElement | null) => void;
  tracks: TrackChoices | null;
  onAudio: (index: number) => void;
  onSubtitles: (index: number) => void;
  /** A failure the player cannot recover from, in the player's own words. */
  fatal: string | null;
  readBrowserStats: () => BrowserStats | null;
  onClose: () => void;
  /**
   * Cards that belong over the frame -- resume, up next. A render function because they read the
   * element's state (how close to the end, whether it ended), which lives in this component.
   */
  overlay?: (video: VideoState, actions: { seekTo: (seconds: number) => void }) => ReactNode;
  timers?: Timers;
}

export function PlayerStage(props: PlayerStageProps) {
  const { session, video, tracks, fatal, timers = realTimers } = props;
  const v = useVideoState(video, session.durationSec);
  const stage = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const [awake, setAwake] = useState(true);
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [help, setHelp] = useState(false);
  const [stats, setStats] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [focusInBar, setFocusInBar] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; key: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const lastSubtitle = useRef<number | null>(null);
  const idleTimer = useRef<unknown>(null);
  const feedbackTimer = useRef<unknown>(null);

  /* ---- chrome visibility ---- */

  const wake = useCallback(() => {
    setAwake(true);
    if (idleTimer.current !== null) timers.clear(idleTimer.current);
    idleTimer.current = timers.set(() => {
      idleTimer.current = null;
      setAwake(false);
    }, IDLE_HIDE_MS);
  }, [timers]);

  const sleep = useCallback(() => {
    if (idleTimer.current !== null) timers.clear(idleTimer.current);
    idleTimer.current = null;
    setAwake(false);
  }, [timers]);

  useEffect(() => {
    wake();
    return () => {
      if (idleTimer.current !== null) timers.clear(idleTimer.current);
      if (feedbackTimer.current !== null) timers.clear(feedbackTimer.current);
    };
  }, [wake, timers]);

  const pinned = v.paused || v.ended || menu !== null || help || scrubbing || focusInBar || fatal !== null;
  const visible = chromeVisible(awake, pinned);

  /* ---- while the stage is up: own the keyboard, freeze the page, take focus ---- */

  useEffect(() => {
    const release = claimKeyboard();
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    stage.current?.focus();
    return () => {
      release();
      root?.removeAttribute("inert");
      html.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    const sync = () => setFullscreen(fullscreenElement() === stage.current);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  /*
    The remembered volume, mute and speed, applied the moment there is an element.

    `defaultPlaybackRate` as well as `playbackRate`: attaching a source runs the media element's
    load algorithm, which resets `playbackRate` to the DEFAULT -- so setting only the live rate
    would be undone by hls.js attaching a moment later.
  */
  useEffect(() => {
    if (!video) return;
    const prefs = loadPrefs(safeStorage());
    video.volume = prefs.volume;
    video.muted = prefs.muted;
    video.defaultPlaybackRate = prefs.rate;
    video.playbackRate = prefs.rate;
  }, [video]);

  /* ---- actions ---- */

  const flash = useCallback(
    (text: string) => {
      setFeedback({ text, key: Date.now() });
      setAnnouncement(text);
      if (feedbackTimer.current !== null) timers.clear(feedbackTimer.current);
      feedbackTimer.current = timers.set(() => {
        feedbackTimer.current = null;
        setFeedback(null);
      }, FEEDBACK_MS);
    },
    [timers],
  );

  const togglePlay = () => {
    if (!video) return;
    if (video.paused || video.ended) void video.play()?.catch?.(() => {});
    else video.pause();
  };
  const seekTo = (seconds: number) => {
    if (video) video.currentTime = clampTime(seconds, v.duration);
  };
  const seekBy = (delta: number) => {
    if (!video) return;
    seekTo(video.currentTime + delta);
    flash(skipFeedback(delta));
  };
  const setVolume = (volume: number) => {
    if (!video) return;
    const next = clampVolume(volume);
    video.volume = next;
    video.muted = next === 0;
    savePrefs(safeStorage(), { volume: next, muted: video.muted });
    flash(volumeFeedback(next, video.muted));
  };
  const toggleMute = () => {
    if (!video) return;
    video.muted = !video.muted;
    savePrefs(safeStorage(), { muted: video.muted });
    flash(volumeFeedback(video.volume, video.muted));
  };
  const setRate = (rate: number) => {
    if (!video) return;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    savePrefs(safeStorage(), { rate });
    flash(speedFeedback(rate));
  };
  const selectSubtitles = (index: number) => {
    if (index !== SUBTITLES_OFF) lastSubtitle.current = index;
    props.onSubtitles(index);
  };
  const toggleFullscreen = () => {
    const el = stage.current as FullscreenElement | null;
    if (!el) return;
    if (fullscreenElement()) {
      const doc = document as FullscreenDocument;
      void (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return;
    }
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    // iOS Safari: no element fullscreen, only the video's own, which brings its native controls.
    else (video as IosVideo | null)?.webkitEnterFullscreen?.();
  };
  const stepFrame = (direction: 1 | -1) => {
    if (!video) return;
    if (!video.paused) video.pause();
    seekTo(video.currentTime + direction * DEFAULT_FRAME_SEC);
  };

  /* ---- the keyboard ---- */

  const onKey = (event: KeyboardEvent) => {
    const hit = playerActionFor(event, event.target as KeyTarget | null, HOST_PLATFORM);
    if (!hit) return;
    const { action } = hit;
    // Behind the help or an error, the only keys that mean anything close them.
    if ((help || fatal) && action !== "close" && action !== "shortcuts") return;
    if (action === "close") {
      if (help) setHelp(false);
      else if (menu) setMenu(null);
      // In fullscreen the browser takes Escape to leave fullscreen; do not also close the player.
      else if (fullscreenElement()) return;
      else props.onClose();
      event.preventDefault();
      return;
    }
    event.preventDefault();
    wake();
    switch (action) {
      case "playPause":
        togglePlay();
        break;
      case "back10":
        seekBy(-SKIP_SEC);
        break;
      case "forward10":
        seekBy(SKIP_SEC);
        break;
      case "back5":
        seekBy(-ARROW_SEC);
        break;
      case "forward5":
        seekBy(ARROW_SEC);
        break;
      case "volumeUp":
        setVolume((video?.muted ? 0 : (video?.volume ?? 0)) + VOLUME_STEP);
        break;
      case "volumeDown":
        setVolume((video?.muted ? 0 : (video?.volume ?? 0)) - VOLUME_STEP);
        break;
      case "mute":
        toggleMute();
        break;
      case "fullscreen":
        toggleFullscreen();
        break;
      case "subtitles": {
        const next = toggledSubtitles(tracks, lastSubtitle.current);
        if (next === null) flash("No subtitles for this title");
        else {
          selectSubtitles(next);
          flash(subtitlesFeedback(tracks, next));
        }
        break;
      }
      case "nextAudio": {
        const next = nextAudioTrack(tracks);
        if (next === null) flash("Only one audio track");
        else {
          props.onAudio(next);
          flash(audioFeedback(tracks, next));
        }
        break;
      }
      case "seekPercent":
        seekTo(percentTime(Number(hit.key), v.duration));
        flash(`${Number(hit.key) * 10}%`);
        break;
      case "seekStart":
        seekTo(0);
        break;
      case "seekEnd":
        seekTo(v.duration);
        break;
      case "frameBack":
        stepFrame(-1);
        break;
      case "frameForward":
        stepFrame(1);
        break;
      case "slower":
        setRate(stepSpeed(video?.playbackRate ?? 1, -1));
        break;
      case "faster":
        setRate(stepSpeed(video?.playbackRate ?? 1, 1));
        break;
      case "stats":
        setStats((was) => !was);
        break;
      case "shortcuts":
        setHelp((was) => !was);
        break;
    }
  };
  // Read through a ref so the window listener is registered once and always sees this render.
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  /* ---- the frame itself ---- */

  const onSurfacePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") {
      visible ? sleep() : wake();
      return;
    }
    if (e.button !== 0) return;
    if (menu) {
      setMenu(null);
      return;
    }
    togglePlay();
  };

  const { elapsed, total } = timeReadout(v.currentTime, v.duration);
  const spans = bufferedSpans(v.buffered, v.duration);
  const showBigPlay = v.paused && !v.ended && !fatal && !help && (v.started || v.ready);
  const showSpinner = !fatal && !v.paused && (v.buffering || !v.started);
  const volumeIcon = v.muted || v.volume === 0 ? <VolumeX /> : v.volume < 0.5 ? <Volume1 /> : <Volume2 />;
  const hasSubtitles = (tracks?.subtitles.length ?? 0) > 0;
  const hasAudioChoice = (tracks?.audio.length ?? 0) > 1;

  const subtitleSection = {
    heading: "Subtitles",
    options: [
      { value: SUBTITLES_OFF, label: "Off" },
      ...(tracks?.subtitles ?? []).map((t) => ({ value: t.index, label: t.name })),
    ],
    value: tracks?.subtitlesAt ?? SUBTITLES_OFF,
    onSelect: (i: number) => selectSubtitles(i),
  };
  const audioSection = {
    heading: "Audio",
    options: (tracks?.audio ?? []).map((t) => ({ value: t.index, label: t.name })),
    value: tracks?.audioAt ?? 0,
    onSelect: (i: number) => props.onAudio(i),
  };
  const speedSection = {
    heading: "Speed",
    options: SPEEDS.map((s) => ({ value: s as number, label: speedLabel(s) })),
    value: v.rate,
    onSelect: (rate: number) => setRate(rate),
  };
  const openMenu = (name: MenuName) => (open: boolean) => setMenu(open ? name : null);

  const buildReport = () =>
    playbackReport({
      session,
      browser: props.readBrowserStats(),
      report: null,
      capabilities: detectCapabilities(),
      userAgent: navigator.userAgent,
      page: window.location.href,
      now: Date.now(),
    });

  return (
    <div
      ref={stage}
      role="dialog"
      aria-modal="true"
      aria-label={`Player: ${props.title}`}
      tabIndex={-1}
      data-testid="player-stage"
      data-chrome={visible ? "shown" : "hidden"}
      className={cn(
        "fixed inset-0 z-50 overflow-hidden bg-black text-ink outline-none select-none",
        !visible && "cursor-none",
      )}
      onPointerMove={(e) => {
        if (e.pointerType !== "touch") wake();
      }}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: subtitles arrive as HLS renditions hls.js turns into TextTracks; there is no static <track> to declare. */}
      <video ref={props.attachVideo} playsInline className="absolute inset-0 h-full w-full object-contain" />

      {/* The frame as a surface: click toggles play, double-click fullscreen, a tap shows the chrome.
          Its keyboard equivalents are Space/k and f, which work from anywhere in the player. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer affordance with global keyboard equivalents */}
      <div
        data-testid="player-surface"
        className="absolute inset-0"
        onPointerUp={onSurfacePointerUp}
        onDoubleClick={toggleFullscreen}
      />

      {/* ---- centre ---- */}
      {showBigPlay ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <button
            type="button"
            aria-label="Play"
            onClick={togglePlay}
            className="pointer-events-auto grid size-18 place-items-center rounded-full bg-black/55 text-ink ring-1 ring-white/15 outline-none backdrop-blur-sm transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Play className="ml-1 size-9 fill-current" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {showSpinner ? (
        <div
          className="pointer-events-none absolute inset-0 grid place-items-center"
          role="status"
          aria-label="Loading"
        >
          <div className="size-14 animate-spin rounded-full border-4 border-white/20 border-t-accent" />
        </div>
      ) : null}
      {feedback ? (
        <div key={feedback.key} className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="rounded-full bg-black/65 px-4 py-2.5 text-base font-medium tabular-nums backdrop-blur-sm">
            {feedback.text}
          </div>
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {props.overlay?.(v, { seekTo })}

      {/* ---- top ---- */}
      <div
        className={cn(
          "fdr-chrome absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-black/75 via-black/35 to-transparent px-4 pt-[max(0.75rem,var(--safe-top))] pb-16 sm:px-6",
          !visible && "pointer-events-none opacity-0",
        )}
      >
        <div className="min-w-0 pt-1">
          <p className="truncate text-base font-semibold sm:text-lg">{props.title}</p>
          {props.episodeLabel ? <p className="truncate text-sm text-ink/70">{props.episodeLabel}</p> : null}
        </div>
        <ControlButton label="Close player" shortcut="esc" onClick={props.onClose}>
          <X aria-hidden="true" />
        </ControlButton>
      </div>

      {/* ---- stats ---- */}
      {stats ? (
        <div className="absolute top-16 left-4 z-10 max-h-[calc(100%-11rem)] w-[min(40rem,calc(100%-2rem))] overflow-y-auto sm:left-6">
          <PlayerStats
            session={session}
            readBrowserStats={props.readBrowserStats}
            // 90%, not the comp's 75%: measured over a saturated frame in Chromium, 75% let the
            // colours behind bleed through the numbers.
            className="rounded-xl bg-black/90 px-3 py-2 text-left ring-1 ring-white/10 backdrop-blur"
          />
        </div>
      ) : null}

      {/* ---- bottom ---- */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: focus TRACKING only -- keyboard focus in the bar pins the chrome; nothing is activated here */}
      <div
        data-testid="player-controls"
        className={cn(
          "fdr-chrome absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pt-20 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-3",
          !visible && "pointer-events-none opacity-0",
        )}
        onFocus={(e) => {
          let keyboard = true;
          try {
            keyboard = (e.target as HTMLElement).matches(":focus-visible");
          } catch {
            // An engine without :focus-visible; treat focus as keyboard focus, which pins rather than hides.
          }
          if (keyboard) setFocusInBar(true);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusInBar(false);
        }}
      >
        <div className="mx-1">
          <SeekBar
            position={v.currentTime}
            duration={v.duration}
            buffered={spans}
            onSeek={seekTo}
            onScrubbing={setScrubbing}
          />
        </div>
        <div className="mt-1 flex items-center gap-0.5 sm:gap-1">
          <ControlButton
            label={v.paused || v.ended ? "Play" : "Pause"}
            shortcut={playerGlyph("playPause")}
            onClick={togglePlay}
          >
            {v.paused || v.ended ? <Play className="fill-current" /> : <Pause className="fill-current" />}
          </ControlButton>
          <ControlButton
            label="Back 10 seconds"
            shortcut={playerGlyph("back10")}
            className="hidden sm:grid"
            onClick={() => seekBy(-SKIP_SEC)}
          >
            <RotateCcw />
          </ControlButton>
          <ControlButton
            label="Forward 10 seconds"
            shortcut={playerGlyph("forward10")}
            className="hidden sm:grid"
            onClick={() => seekBy(SKIP_SEC)}
          >
            <RotateCw />
          </ControlButton>
          <div className="group/vol hidden items-center sm:flex">
            <ControlButton
              label={v.muted ? "Unmute" : "Mute"}
              shortcut={playerGlyph("mute")}
              onClick={toggleMute}
            >
              {volumeIcon}
            </ControlButton>
            <VolumeSlider volume={v.muted ? 0 : v.volume} onChange={setVolume} />
          </div>
          <p className="ml-2 text-sm whitespace-nowrap tabular-nums" data-testid="player-time">
            <span>{elapsed}</span>
            <span className="text-ink/60"> / {total}</span>
          </p>

          <div className="flex-1" />

          {hasSubtitles ? (
            <PlayerMenu
              id={`${menuId}-subtitles`}
              label="Subtitles"
              shortcut={playerGlyph("subtitles")}
              icon={<Captions />}
              open={menu === "subtitles"}
              onOpenChange={openMenu("subtitles")}
              sections={[subtitleSection]}
            />
          ) : null}
          {hasAudioChoice ? (
            <PlayerMenu
              id={`${menuId}-audio`}
              label="Audio track"
              shortcut={playerGlyph("nextAudio")}
              icon={<AudioLines />}
              open={menu === "audio"}
              onOpenChange={openMenu("audio")}
              sections={[audioSection]}
              className="hidden sm:block"
            />
          ) : null}
          <PlayerMenu
            id={`${menuId}-speed`}
            label="Playback speed"
            shortcut=">"
            icon={<Gauge />}
            open={menu === "speed"}
            onOpenChange={openMenu("speed")}
            sections={[speedSection]}
            className="hidden sm:block"
          />
          <PlayerMenu
            id={`${menuId}-more`}
            label="More"
            icon={<Settings />}
            open={menu === "more"}
            onOpenChange={openMenu("more")}
            sections={[
              ...(hasAudioChoice ? [audioSection] : []),
              speedSection,
              {
                heading: "Diagnostics",
                options: [{ value: true, label: "Stats for nerds" }],
                value: stats,
                onSelect: () => setStats((was) => !was),
              },
            ]}
            className="sm:hidden"
          />
          <ControlButton
            label={stats ? "Hide stats for nerds" : "Stats for nerds"}
            shortcut={playerGlyph("stats")}
            active={stats}
            aria-pressed={stats}
            className="hidden sm:grid"
            onClick={() => setStats((was) => !was)}
          >
            <Activity />
          </ControlButton>
          <ControlButton
            label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            shortcut={playerGlyph("fullscreen")}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize /> : <Maximize />}
          </ControlButton>
        </div>
      </div>

      {help ? <ShortcutOverlay onClose={() => setHelp(false)} /> : null}

      {fatal ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 p-4">
          <section
            role="alertdialog"
            aria-labelledby="player-error-title"
            aria-describedby="player-error-detail"
            className="w-full max-w-md rounded-2xl bg-surface p-6 ring-1 ring-line"
          >
            <CircleAlert className="mb-3 size-6 text-danger" aria-hidden="true" />
            <h2 id="player-error-title" className="text-lg font-semibold">
              This title stopped playing
            </h2>
            <p id="player-error-detail" className="mt-1.5 text-sm text-muted">
              {fatal}. Copy the diagnostics into a bug report: they say what the player and the server were
              doing.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <CopyReport
                build={buildReport}
                className="rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-line outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
              />
              <button
                type="button"
                onClick={props.onClose}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink"
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Volume, as a slider that slides out beside the mute button on hover or focus.
 *
 * It handles ITS OWN arrow keys and stops them, because on a focused slider ← and → mean "change
 * this value" (WAI-ARIA), while the player's global ← and → seek.
 */
function VolumeSlider({ volume, onChange }: { volume: number; onChange: (volume: number) => void }) {
  const track = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const at = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return volume;
    return (clientX - rect.left) / rect.width;
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowUp"
        ? VOLUME_STEP
        : e.key === "ArrowLeft" || e.key === "ArrowDown"
          ? -VOLUME_STEP
          : 0;
    if (step === 0) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(volume + step);
  };
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Volume"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(volume * 100)}
      aria-valuetext={`${Math.round(volume * 100)}%`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onChange(at(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(at(e.clientX));
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      className="flex h-10 w-0 cursor-pointer touch-none items-center overflow-hidden rounded-full outline-none transition-[width] duration-150 group-hover/vol:ml-1 group-hover/vol:w-20 focus-visible:ml-1 focus-visible:w-20 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="relative h-1 w-full rounded-full bg-white/25">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-ink"
          style={{ width: `${volume * 100}%` }}
        />
      </div>
    </div>
  );
}
