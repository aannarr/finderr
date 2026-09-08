/**
 * Playing a title in THIS browser, rather than handing it to a Plex client.
 *
 * ADMIN ONLY while this is a prototype. The gate is the SERVER's -- every `/api/play` route
 * asks `requireAdmin` -- and this component merely declines to draw a control nobody else
 * could use. A component that hid itself and no more would be a rule with two owners and
 * only one of them enforced.
 *
 * It sits beside `PlayOnPlex` rather than replacing it, and the two answer different
 * questions: Plex plays on the reader's TV with their history and their subtitles; this
 * plays here, now, in the tab that is already open, on a machine that may have no Plex
 * client at all.
 *
 * > [!IMPORTANT] hls.js is loaded with a DYNAMIC import, and that is a performance decision
 * > It is ~200 KB and it is needed by one control on one page for one role. A static import
 * > would put it in the application chunk every reader downloads, which is the shape rule
 * > four exists to refuse. `import()` makes it its own chunk, fetched the first time an
 * > admin actually presses play and never otherwise.
 * >
 * > Safari needs none of it -- it plays HLS natively -- so on that path the chunk is never
 * > fetched at all.
 */

import { useEffect, useRef, useState } from "react";
import {
  hasNativeHls,
  PlaybackRefused,
  type PlaybackSession,
  startPlayback,
  stopPlayback,
} from "../lib/playback-api";
import { isExpensivePlan, planSummary } from "../lib/playback-types";

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "playing"; session: PlaybackSession }
  | { kind: "failed"; message: string };

export function PlayHere({
  tconst,
  season,
  episode,
  isAdmin,
}: {
  tconst: string;
  season?: number;
  episode?: number;
  isAdmin: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Held in a ref rather than state: tearing hls.js down is a side effect on unmount, and
  // putting it in state would re-render the player every time it changed.
  const hlsRef = useRef<{ destroy(): void } | null>(null);

  const session = state.kind === "playing" ? state.session : null;
  const sessionId = session?.sessionId ?? null;

  /*
    Attach the playlist once BOTH the session and the <video> element exist.

    Two separate awaits stand between pressing play and having a source -- the POST and the
    dynamic import -- so a naive "start then attach" races the element into existence. This
    effect runs after the render that created it, which is the only ordering that is not a
    guess.
  */
  useEffect(() => {
    const video = videoRef.current;
    if (!session || !video) return;
    let cancelled = false;

    /*
      MSE FIRST, NATIVE ONLY AS THE FALLBACK. This order is the fix for a real bug and it is
      the opposite of what reads naturally.

      The obvious shape is "if the browser plays HLS itself, hand it the URL" -- and it is
      wrong, because **Chromium answers `canPlayType("application/vnd.apple.mpegurl")` with
      `"maybe"`**. Any truthiness test on that string claims native support that does not
      exist: the src is set, nothing loads, no request is even made, and the element sits at
      `error.code 4` with an empty console. Measured in a real headless Chromium on
      2026-09-08, after the component passed every unit test.

      Requiring `"probably"` instead would be the other half of the same mistake, because
      iOS Safari also says `"maybe"` and native HLS is the ONLY path there -- it has no
      MediaSource at all. So neither answer to "can you play HLS" is usable, and the
      question that IS decidable gets asked instead: `Hls.isSupported()` tests for real MSE
      support, which every desktop browser has and iOS does not. Ask that first, and the
      native path becomes exactly what remains.
    */
    void (async () => {
      const { default: Hls } = await import("hls.js");
      if (cancelled) return;
      if (!Hls.isSupported()) {
        if (hasNativeHls()) {
          video.src = session.playlist;
          void video.play().catch(() => {});
        }
        return;
      }
      const hls = new Hls({
        // The playlist names the whole film before any of it has been produced, so a
        // fragment request is what CAUSES its segment to be made. Two settings follow from
        // that and neither is a default worth keeping.
        //
        // The retries cover a segment the server declined to start right now -- too many
        // productions already in flight, which is the back-pressure a viewer dragging the
        // scrubber runs into. Those come back 404 by design (hls.js retries a 404 and gives
        // up on a 500).
        manifestLoadingMaxRetry: 8,
        levelLoadingMaxRetry: 8,
        fragLoadingMaxRetry: 8,
        // The timeout has to cover PRODUCING the fragment, not just transferring it. A
        // copy-mode segment is 0.08 s on the NAS; a 4K software re-encode of one is seconds,
        // and the default 20 s would abandon it just as it finished.
        fragLoadingTimeOut: 60_000,
        /*
          `maxBufferHole` IS AN ESCAPE HATCH, NOT A SETTING. It is aannarr's, it is TEMPORARY,
          and the card that removes it is already open.

          This override was removed when audio got its own rendition, on the reasoning that the
          server no longer leaves a hole at a boundary -- video and audio are separate renditions
          on separate grids, and an audio segment covers its whole declared range and a little of
          the one before it, so there is nothing to jump. **That reasoning is correct about the
          AUDIO hole and it was not the whole story.** A second, independent defect was hiding
          underneath it: every COPY-mode video fragment is placed 0.083 s later than the one
          before it, cumulatively, because each per-segment init carries a `duration=0,
          media_time=1328` edit-list entry (the two-frame B-frame reorder delay) that accumulates
          per APPEND. Measured against hls.js's own `frag.startPTS` and ffprobe on the media.

          The intersection gap that leaves is ~0.134 s, over the default 0.1 s tolerance, so
          Chrome stalls and jumps once per segment -- roughly every six seconds, on copy mode,
          which is ~97% of this library. Removing the override made that VISIBLE rather than
          causing it.

          aannarr took the hatch on 2026-09-08, knowing exactly what it covers, because he is
          using playback day to day and a stutter every six seconds is not liveable while the
          real fix is built.

          DELETE THIS THE MOMENT THE DRIFT IS FIXED, and prove the fix with it gone. A correct
          muxing route needs no hole tolerance at all, and leaving this in afterwards puts the
          cover back over the thing it was bought to survive. Card:
          `copy-mode-fmp4-segments-drift-83ms-later-per-fragment-in-the`.
        */
        maxBufferHole: 0.25,
      });
      hlsRef.current = hls;
      hls.loadSource(session.playlist);
      hls.attachMedia(video);
      void video.play().catch(() => {});
    })();

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [session]);

  /*
    Give the slot back when the TAB goes away.

    `pagehide` rather than `beforeunload`: it is the one that fires on iOS and on a bfcache
    navigation, which is most of how a tab actually leaves.

    > [!CAUTION] THE CLEANUP MUST NOT STOP THE SESSION, and that cost a working player
    > The obvious version releases in the cleanup as well, so an unmount frees the slot
    > immediately. **In development that kills the session about a millisecond after it
    > starts**: StrictMode mounts, unmounts and remounts every component, the simulated
    > unmount runs the cleanup, and the remount comes back holding a `sessionId` the server
    > has already stopped. Every subsequent playlist request is a 404, hls.js retries its
    > budget and gives up, and the console says nothing at all. Measured in a real browser
    > 2026-09-08 -- the unit tests passed throughout, because none of them unmount.
    >
    > There is no way to tell a simulated unmount from a real one, so the release simply
    > does not live here. The three real exits are covered: the Stop button, `pagehide`, and
    > `IDLE_REAP_MS` -- and the reaper is not a consolation prize, it is the mechanism built
    > for exactly this case, a client that went away without saying so.
  */
  useEffect(() => {
    if (!sessionId) return;
    const release = () => stopPlayback(sessionId);
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [sessionId]);

  if (!isAdmin) return null;

  async function play() {
    setState({ kind: "starting" });
    try {
      const s = await startPlayback(tconst, { season, episode });
      setState({ kind: "playing", session: s });
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

  /*
    The PLAYER IS AN OVERLAY and the BUTTON stays in the header, which is a layout decision
    rather than a stylistic one.

    This control sits in the poster rail, beside "Play on Plex" -- a column about 200px
    wide. Expanding a 16:9 video into it would be unwatchable, and expanding it anywhere
    else in the header would push the header around, which is the one thing that region's
    rule forbids. An overlay leaves the page underneath exactly as it was, which is also
    what a reader wants when they stop: they are back where they were, not scrolled
    somewhere new.
  */
  if (state.kind === "playing") {
    const { plan } = state.session;
    const close = () => {
      stopPlayback(state.session.sessionId);
      setState({ kind: "idle" });
    };
    // `role="dialog"` is not decoration to satisfy a linter: it is what makes Escape a
    // legitimate handler here rather than a key listener bolted to a decorative div, and
    // it is what tells a screen reader that the page behind this is inert.
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Player"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div className="w-full max-w-5xl space-y-2">
          {/* biome-ignore lint/a11y/useMediaCaption: subtitles are a server-side plan
              decision and arrive burned in or not at all; there is no track to declare. */}
          <video ref={videoRef} controls playsInline className="w-full rounded-lg bg-black" />
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted">
            <span>
              {planSummary(plan)}
              {isExpensivePlan(plan) ? " · re-encoding video" : ""}
            </span>
            <button type="button" onClick={close} className="text-muted hover:text-ink">
              Stop
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={play}
        disabled={state.kind === "starting"}
        className={`block w-full rounded-lg border border-line px-3 py-2 text-center text-sm font-medium
                    transition-opacity hover:opacity-90 active:opacity-75 disabled:opacity-60`}
      >
        {state.kind === "starting" ? "Starting…" : "Play here"}
      </button>
      {state.kind === "failed" ? <p className="text-center text-xs text-muted">{state.message}</p> : null}
    </div>
  );
}
