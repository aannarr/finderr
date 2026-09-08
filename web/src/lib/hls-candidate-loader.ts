/**
 * Pointing every hls.js request at whichever of the server's addresses is currently working.
 *
 * A thin shim, and deliberately: **hls.js keeps its own retry machinery**, and the whole
 * design here is to let it. A failed segment demotes the candidate that failed; hls.js's own
 * retry then calls `load` again; the rewrite below sends that attempt to the next address.
 * Nothing here counts attempts, backs off or schedules -- doing any of it would be a second
 * retry policy racing the library's.
 *
 * > [!IMPORTANT] SUBCLASS THE CONFIGURED LOADER, never reimplement `Loader`
 * > The interface looks small -- `load`, `abort`, `destroy` -- and it is not: it owns
 * > progressive chunk delivery, `LoaderStats` (which is what the ABR estimator reads to pick a
 * > rendition), timeouts, and the abort semantics fragment eviction depends on. A hand-rolled
 * > loader that got the stats wrong would degrade quality selection in a way no test would
 * > catch. The base class is passed IN rather than imported, because hls.js is a dynamic
 * > import (~200 KB, one control, one role) and importing it here would put it back in the
 * > application chunk.
 *
 * ## Which segment kinds this covers
 *
 * All of them, by construction: the rewrite is on the PATH prefix rather than on a list of
 * file names, so the master playlist, the video rendition, the separate audio rendition and
 * the WebVTT subtitle rendition are all retargeted by the same rule, as is anything a later
 * rendition adds. There is no per-track vocabulary here to fall behind `hls-timeline.ts`.
 */

import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";
import type { EndpointRing } from "./stream-endpoints";

/** The shape hls.js wants in `config.loader`: a constructor taking the resolved config. */
export type LoaderConstructor = HlsConfig["loader"];

/**
 * Whether a failed request says the PATH is bad, rather than the resource.
 *
 * The distinction is the whole correctness of the failover. Our segment route answers **404
 * for a segment that is not ready yet** -- ffmpeg is still producing it, or declined to start
 * another production right now -- and that is back-pressure on a perfectly healthy
 * connection. Rotating candidates for it would walk the ring on a busy server and end up on
 * the worst route available while nothing was ever wrong with the first.
 *
 * So: a transport failure (`code` 0, which is also what a blocked CORS response looks like to
 * a browser) or a server-side error demotes. A 4xx does not.
 */
function pathIsDead(status: number): boolean {
  return status === 0 || status >= 500;
}

/**
 * A loader that fetches from the ring's current endpoint and demotes it when it dies.
 *
 * @param Base The loader class hls.js would otherwise use -- `Hls.DefaultConfig.loader`.
 * @param ring Owns which candidate is current. Shared with the caller, which pins the race
 *   winner into it before playback starts.
 * @param pageOrigin The origin to resolve a relative URL against, and the fallback when the
 *   ring is empty. `location.origin` in a browser; a literal in a test.
 */
export function candidateLoader(
  Base: LoaderConstructor,
  ring: EndpointRing,
  pageOrigin: string,
): LoaderConstructor {
  return class CandidateLoader extends Base {
    override load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ) {
      // Mutating the context is how hls.js's own documented `pLoader` examples retarget a
      // URL, and it is what makes the change visible to the callbacks the library will
      // report against -- a copy would be reported under the pre-rewrite URL.
      context.url = ring.retarget(context.url, pageOrigin);
      // Read BEFORE the request, so a late failure demotes the candidate that actually served
      // it rather than whichever one happens to be current when the error lands.
      const attempted = ring.current();

      super.load(context, config, {
        ...callbacks,
        onError: (error, ctx, networkDetails, stats) => {
          if (attempted && pathIsDead(error.code)) ring.demote(attempted);
          callbacks.onError(error, ctx, networkDetails, stats);
        },
        onTimeout: (stats, ctx, networkDetails) => {
          // A timeout is always the path: the request reached nothing, or reached something
          // that never answered, and neither is a statement about the segment.
          if (attempted) ring.demote(attempted);
          callbacks.onTimeout(stats, ctx, networkDetails);
        },
      });
    }
  };
}
