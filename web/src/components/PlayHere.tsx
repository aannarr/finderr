/**
 * Playing a title in THIS browser, rather than handing it to a Plex client.
 *
 * ADMIN ONLY while this is a prototype. The gate is the SERVER's -- every `/api/play` route
 * asks `requireAdmin` -- and this component merely declines to draw a control nobody else
 * could use. A component that hid itself and no more would be a rule with two owners and
 * only one of them enforced.
 *
 * The STATE lives in `usePlayHere`, not in the button, because the title page offers this
 * from two places: as the default half of `PlayMenu` when Plex does not hold the title, and
 * as an item in that menu when it does. Either way one hook owns the session and the
 * player, so a menu item and a button cannot grow two players.
 *
 * WHAT THE VIEWER SEES is `player/PlayerStage.tsx`, the full-window player judged against the
 * comp. This file owns the session, hls.js, the element's source and the diagnostics feed.
 *
 * > [!IMPORTANT] hls.js is loaded with a DYNAMIC import, and that is a performance decision
 * > It is ~200 KB and it is needed by one control on one page for one role. A static import
 * > would put it in the application chunk every reader downloads, which is the shape rule
 * > four exists to refuse. `import()` makes it its own chunk, fetched the first time an
 * > admin actually presses play and never otherwise.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { candidateLoader } from "../lib/hls-candidate-loader";
import {
  electStreamEndpoint,
  hasNativeHls,
  PlaybackRefused,
  type PlaybackSession,
  renewStreamToken,
  startPlayback,
  stopPlayback,
} from "../lib/playback-api";
import { type BrowserStats, PlaybackTelemetry, watchPolicyViolations } from "../lib/playback-telemetry";
import { readTrackChoices, type TrackChoices, type TrackReader } from "../lib/player-tracks";
import { PRIMARY_BUTTON } from "../lib/ui";
import { PlayerStage } from "./player/PlayerStage";

/**
 * Whether this reader can play this title in this tab -- the two facts, in one place.
 *
 * A PLACEMENT question rather than a second gate. The component below already refuses to
 * draw for a non-admin, but a page that wants to put this control in its primary slot has to
 * know the answer BEFORE it renders anything, or the slot silently collapses to nothing for
 * everybody who is not an admin. Exported so `TitleRoute` asks rather than re-derives: the
 * admin half of the rule then has one owner, in the file that enforces it.
 */
export function canPlayHere(title: { hasFile: boolean }, isAdmin: boolean): boolean {
  return title.hasFile && isAdmin;
}

/** Which episode to play, and how to name it on screen. Absent for a film. */
export interface PlayTarget {
  season?: number;
  episode?: number;
  /** `S1E3 · Episode name`, drawn under the title. */
  episodeLabel?: string | null;
}

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "playing"; session: PlaybackSession; target: PlayTarget }
  | { kind: "failed"; message: string };

export interface PlayHereControl {
  state: State;
  /** Ask the server for a session. Safe to call from a button or a menu item alike. */
  play: (target?: PlayTarget) => Promise<void>;
  /** The player while a session is playing, else null. Portalled, so it can mount anywhere. */
  player: React.ReactNode;
}

export function usePlayHere({
  tconst,
  title,
  season,
  episode,
}: {
  tconst: string;
  /** What the player's top bar calls this title. */
  title?: string;
  season?: number;
  episode?: number;
}): PlayHereControl {
  const [state, setState] = useState<State>({ kind: "idle" });
  /*
    What the player is offering, and what it is on. STATE rather than a ref, unlike the
    instance below, because this one is DRAWN: the menus have to re-render when hls.js finishes
    parsing the manifest, which happens after the effect that created the player has returned.
    Null until then, and on the native path where there is no hls.js instance to ask.
  */
  const [tracks, setTracks] = useState<TrackChoices | null>(null);
  /** A failure the player will not recover from on its own, in the words it failed with. */
  const [fatal, setFatal] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /*
    The element as STATE as well as a ref: the controls subscribe to its events, and a ref
    changing does not re-render anything. The callback is stable so React does not detach and
    reattach it -- and set state -- on every render.
  */
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideo(el);
  }, []);
  // Held in a ref rather than state: tearing hls.js down is a side effect on unmount, and
  // putting it in state would re-render the player every time it changed.
  const hlsRef = useRef<(TrackReader & { destroy(): void; bandwidthEstimate?: number }) | null>(null);
  // Also a ref, and for a stronger reason: fragment events fire several times a second per
  // rendition, so routing them through state would re-render the video element itself. The
  // stats panel samples this on its own timer, and only while it is open.
  const telemetryRef = useRef(new PlaybackTelemetry());
  /*
    Where focus was when play was pressed, so closing the player hands it back there. Captured
    at the press rather than looked up at close: by then the page underneath has been inert for
    the whole film and `document.activeElement` is the body.
  */
  const returnFocus = useRef<HTMLElement | null>(null);
  const refocusOnIdle = useRef(false);

  const session = state.kind === "playing" ? state.session : null;
  const sessionId = session?.sessionId ?? null;

  /** What the browser knows right now, or null before there is an element to ask. */
  const readBrowserStats = useCallback((): BrowserStats | null => {
    const el = videoRef.current;
    if (!el) return null;
    return telemetryRef.current.read(el, hlsRef.current?.bandwidthEstimate ?? null);
  }, []);

  /*
    Attach the playlist once BOTH the session and the <video> element exist.

    Two separate awaits stand between pressing play and having a source -- the POST and the
    dynamic import -- so a naive "start then attach" races the element into existence. This
    effect runs after the render that created it, which is the only ordering that is not a
    guess.
  */
  useEffect(() => {
    const el = videoRef.current;
    if (!session || !el) return;
    let cancelled = false;
    let stopRenewal: () => void = () => {};
    telemetryRef.current = new PlaybackTelemetry();
    const telemetry = telemetryRef.current;
    // A refused `blob:` raises nothing in hls.js and only `code 4` on the element -- see
    // `watchPolicyViolations`. Listening is what lets the stats panel and the error name it.
    const stopWatching = watchPolicyViolations(document, telemetry);
    const onElementError = () => setFatal(`Media element error ${el.error?.code ?? "unknown"}`);
    el.addEventListener("error", onElementError);

    /*
      MSE FIRST, NATIVE ONLY AS THE FALLBACK. This order is the fix for a real bug and it is
      the opposite of what reads naturally.

      **Chromium answers `canPlayType("application/vnd.apple.mpegurl")` with `"maybe"`**, so a
      truthiness test claims native support that does not exist, and iOS Safari also says
      `"maybe"` while native HLS is its ONLY path. `Hls.isSupported()` tests for real MSE, which
      every desktop browser has and iOS does not. Ask that first; native is what remains.
      Measured in a real headless Chromium on 2026-09-08.
    */
    void (async () => {
      const { default: Hls } = await import("hls.js");
      if (cancelled) return;
      if (!Hls.isSupported()) {
        // Same-origin by construction: the element follows the playlist itself, so there is no
        // loader to retarget a request and multi-homing is an MSE-path feature.
        if (hasNativeHls()) {
          el.src = session.playlist;
          void el.play()?.catch?.(() => {});
        }
        return;
      }

      // WHICH ADDRESS TO STREAM FROM, decided before the first playlist request. See
      // `electStreamEndpoint`: an unroutable LAN address hangs rather than failing.
      const ring = await electStreamEndpoint(session, location.origin);
      if (cancelled) return;
      stopRenewal = renewStreamToken(session, ring);

      const hls = new Hls({
        loader: candidateLoader(Hls.DefaultConfig.loader, ring, location.origin),
        // A fragment request is what CAUSES its segment to be made, so the retries cover a
        // production the server declined right now (back-pressure answers 404, which hls.js
        // retries) and the timeout covers PRODUCING a segment, not just transferring it.
        manifestLoadingMaxRetry: 8,
        levelLoadingMaxRetry: 8,
        fragLoadingMaxRetry: 8,
        fragLoadingTimeOut: 60_000,
        // Sixty seconds ahead rather than the default thirty: on the LAN the fetch is cheap, the
        // server's read-ahead is already producing past the playhead, and a deeper buffer is
        // what rides out a busy array (STREAM epic, the warm-up stall card).
        maxBufferLength: 60,
        // NO `maxBufferHole` OVERRIDE, and its absence is the assertion: `SEGMENT_MUXER_OPTIONS`
        // in `playback-plan.ts` moved each fragment's position into its own `tfdt`.
      });
      hlsRef.current = hls;
      // THE MENUS ARE FED BY EVENTS, because the renditions do not exist until the manifest is
      // parsed, and the switch events keep the control agreeing with the player.
      const syncTracks = () => setTracks(readTrackChoices(hls));
      hls.on(Hls.Events.MANIFEST_PARSED, syncTracks);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncTracks);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, syncTracks);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, syncTracks);
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, syncTracks);
      // Feed the stats panel from the ONE place that holds an hls.js instance, as plain data.
      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        telemetry.fragmentLoaded({
          index: typeof data.frag.sn === "number" ? data.frag.sn : null,
          track: data.frag.type ?? null,
          loadMs: Math.round(data.frag.stats.loading.end - data.frag.stats.loading.start),
          bytes: data.frag.stats.loaded,
        });
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        telemetry.failed(`${data.details}${data.fatal ? " (fatal)" : ""}`);
        // A fatal error is hls.js having given up; nothing else will tell the viewer.
        if (data.fatal) setFatal(`The player gave up: ${data.details}`);
      });
      hls.loadSource(session.playlist);
      hls.attachMedia(el);
      void el.play()?.catch?.(() => {});
    })();

    return () => {
      cancelled = true;
      stopRenewal();
      stopWatching();
      el.removeEventListener("error", onElementError);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      setTracks(null);
    };
  }, [session]);

  /**
   * Switch a rendition, and show the switch immediately.
   *
   * The optimistic update keeps the checked menu row from snapping back until hls.js finishes
   * the switch; the switch event still arrives and corrects an answer the player declined.
   */
  const selectTrack = useCallback((pick: (player: TrackReader) => void, at: Partial<TrackChoices>) => {
    const player = hlsRef.current;
    if (!player) return;
    pick(player);
    setTracks((was) => (was ? { ...was, ...at } : was));
  }, []);

  const selectAudio = useCallback(
    (index: number) =>
      selectTrack(
        (player) => {
          player.audioTrack = index;
        },
        { audioAt: index },
      ),
    [selectTrack],
  );

  const selectSubtitles = useCallback(
    (index: number) =>
      selectTrack(
        (player) => {
          player.subtitleTrack = index;
        },
        { subtitlesAt: index },
      ),
    [selectTrack],
  );

  /*
    Give the slot back when the TAB goes away.

    > [!CAUTION] THE CLEANUP MUST NOT STOP THE SESSION, and that cost a working player
    > StrictMode mounts, unmounts and remounts every component; a release in the cleanup stopped
    > the session a millisecond after it started and every playlist request 404'd with nothing in
    > the console. Measured in a real browser 2026-09-08. The three real exits are covered:
    > Close, `pagehide`, and `IDLE_REAP_MS` on the server.
  */
  useEffect(() => {
    if (!sessionId) return;
    const release = () => stopPlayback(sessionId);
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [sessionId]);

  // Focus back to the control that opened the player, once the page is no longer inert.
  useEffect(() => {
    if (state.kind !== "idle" || !refocusOnIdle.current) return;
    refocusOnIdle.current = false;
    returnFocus.current?.focus();
  }, [state.kind]);

  async function play(target: PlayTarget = {}) {
    const captureFocus = () => {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        returnFocus.current = document.activeElement;
      }
    };
    captureFocus();
    setState({ kind: "starting" });
    setFatal(null);
    try {
      // Subtitles are always ASKED FOR and never switched on: the server publishes a
      // `DEFAULT=NO` WebVTT rendition and nothing is fetched until somebody selects it.
      const s = await startPlayback(tconst, {
        season: target.season ?? season,
        episode: target.episode ?? episode,
        wantSubtitles: true,
      });
      /*
        Captured AGAIN once the request is back. Started from `PlayMenu`'s item, focus was on a
        menu row that unmounts as the menu closes -- and the menu then hands focus to its trigger.
        The trigger is the control a keyboard reader returns to; the vanished row is nowhere.
      */
      if (!returnFocus.current?.isConnected) captureFocus();
      setState({ kind: "playing", session: s, target });
    } catch (err) {
      const message =
        err instanceof PlaybackRefused && err.status === 503
          ? "The server is already transcoding as much as it can. Try again shortly."
          : err instanceof Error
            ? err.message
            : "Playback could not start.";
      setState({ kind: "failed", message });
    }
  }

  if (state.kind !== "playing") return { state, play, player: null };

  const close = () => {
    stopPlayback(state.session.sessionId);
    refocusOnIdle.current = true;
    setState({ kind: "idle" });
  };

  // PORTALLED to the body so the page's own root can be made `inert` underneath it -- which is
  // what makes `aria-modal` true rather than a claim, and keeps Tab from wandering behind the film.
  const player = createPortal(
    <PlayerStage
      title={title ?? "Now playing"}
      episodeLabel={state.target.episodeLabel}
      session={state.session}
      video={video}
      attachVideo={attachVideo}
      tracks={tracks}
      onAudio={selectAudio}
      onSubtitles={selectSubtitles}
      fatal={fatal}
      readBrowserStats={readBrowserStats}
      onClose={close}
    />,
    document.body,
  );
  return { state, play, player };
}

/** "Play here" as a standalone button. `PlayMenu` uses the hook directly instead. */
export function PlayHere({
  tconst,
  title,
  season,
  episode,
  isAdmin,
}: {
  tconst: string;
  title?: string;
  season?: number;
  episode?: number;
  isAdmin: boolean;
}) {
  const { state, play, player } = usePlayHere({ tconst, title, season, episode });
  if (!isAdmin) return null;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => void play()}
        disabled={state.kind === "starting"}
        // The accent, because this is the one thing a title we already hold is FOR.
        className={`${PRIMARY_BUTTON} disabled:opacity-60`}
      >
        {state.kind === "starting" ? "Starting…" : "Play here"}
      </button>
      {state.kind === "failed" ? <p className="text-center text-xs text-muted">{state.message}</p> : null}
      {player}
    </div>
  );
}
