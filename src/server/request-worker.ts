/**
 * Background request queue.
 *
 * The constraint that shapes this file: POSTing a request must return immediately so
 * the human can carry on searching. Adding to Radarr/Sonarr takes anywhere from
 * 200ms to several seconds (it triggers a metadata refresh and an indexer search),
 * and making the user watch a spinner for that is exactly the Seerr experience we
 * are replacing.
 *
 * So: the HTTP handler writes a row and returns 202. This worker drains the queue at
 * its own pace, one at a time, and the client polls for outcomes.
 */

import type { RadarrClient, SonarrClient } from "../lib/arr";
import { ArrError, safeArrMessage } from "../lib/arr";
import type { ProwlarrClient } from "../lib/prowlarr";
import { decodeSeasons } from "../lib/seasons";
import type { Store } from "../lib/store";
import { searchOnAddOf } from "../lib/store";
import { diagnoseRequests, downloadsByArrId } from "./diagnose-requests";

export interface WorkerDeps {
  store: Store;
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  /**
   * Read-only, and only for diagnostics. Optional: without it a request that has found
   * nothing is reported as still looking rather than as hopeless -- see
   * `../lib/request-diagnostics.ts`.
   */
  prowlarr?: ProwlarrClient;
  log: (...args: unknown[]) => void;
}

/**
 * One unit of work.
 *
 * > [!IMPORTANT] An EPISODE job is not a `request` row, and that is deliberate
 * > A title request is a durable record with a status a reader polls -- it can sit
 * > "searching" for a day and age out to `no_release`. Asking for one episode of a series
 * > Sonarr ALREADY holds is a different animal: two immediate calls (monitor, then search)
 * > against a series that is already in the library, with no add and no metadata refresh.
 * >
 * > Its outcome is already recorded somewhere honest -- the episode mirror, which reports
 * > `monitored` and then `hasFile` from Sonarr itself on the next sync. Writing a second
 * > record of the same fact would give "do we have this episode" two owners that can
 * > disagree, which is exactly the bug `plex_item` exists to avoid on the title side.
 * >
 * > It shares the QUEUE with title requests, because the reason for the queue is the arr's
 * > load and not the record: firing a burst of searches is how a seedbox gets suspended.
 */
type Job = { kind: "title"; tconst: string } | { kind: "episode"; tconst: string; episodeIds: number[] };

export class RequestWorker {
  private queue: Job[] = [];
  private running = false;
  private processed = 0;
  private failed = 0;

  constructor(private deps: WorkerDeps) {}

  /** Pick up anything left queued by a previous run. */
  start(): void {
    for (const r of this.deps.store.listRequests("queued", 500)) this.enqueue(r.tconst);
    if (this.queue.length > 0) this.deps.log(`request queue: resuming ${this.queue.length} pending`);
  }

  enqueue(tconst: string): void {
    if (!this.queue.some((j) => j.kind === "title" && j.tconst === tconst)) {
      this.queue.push({ kind: "title", tconst });
    }
    void this.drain();
  }

  /**
   * Ask Sonarr for specific episodes of a series it already holds.
   *
   * The ids are SONARR'S, resolved by the caller out of the episode mirror -- this worker
   * never translates a season and number, because Sonarr's monitor and search endpoints do
   * not take one.
   */
  enqueueEpisodes(tconst: string, episodeIds: readonly number[]): void {
    if (episodeIds.length === 0) return;
    this.queue.push({ kind: "episode", tconst, episodeIds: [...episodeIds] });
    void this.drain();
  }

  stats() {
    return {
      pending: this.queue.length,
      processed: this.processed,
      failed: this.failed,
      running: this.running,
    };
  }

  /**
   * One at a time, deliberately.
   *
   * Each add triggers a metadata refresh plus an indexer search on the arr side, and
   * firing a burst of those is how you get a seedbox suspended for flooding. Slow is
   * fine here -- the user is not waiting.
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        if (job.kind === "title") await this.process(job.tconst);
        else await this.processEpisodes(job.tconst, job.episodeIds);
        // Breathe between adds.
        await Bun.sleep(400);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(tconst: string): Promise<void> {
    const { store, radarr, sonarr, log } = this.deps;
    const req = store.getRequest(tconst);
    if (!req) return;
    if (req.status !== "queued") return;

    try {
      // Null for every ordinary request, which is what makes this a no-op for them: both
      // clients fall back to the configured service default when a field is absent, so
      // there is no second default here that could drift from the first.
      const overrides = {
        qualityProfileId: req.quality_profile_id ?? undefined,
        rootFolderPath: req.root_folder_path ?? undefined,
        searchOnAdd: searchOnAddOf(req),
      };

      if (req.service === "radarr") {
        if (!radarr) throw new Error("Radarr is not configured");
        const movie = await radarr.add({ imdbId: tconst, ...overrides });
        store.updateRequest(tconst, {
          status: "sent",
          arr_id: movie.id,
          error: null,
        });
        log(`request: added "${req.title}" to Radarr as id ${movie.id}`);
      } else {
        if (!sonarr) throw new Error("Sonarr is not configured");
        // decodeSeasons returns null for a request made before the selector existed, and
        // null is exactly what `add` wants for "all" -- no branch needed here.
        const series = await sonarr.add({
          imdbId: tconst,
          seasons: decodeSeasons(req.seasons),
          ...overrides,
        });
        store.updateRequest(tconst, {
          status: "sent",
          arr_id: series.id,
          error: null,
        });
        log(`request: added "${req.title}" to Sonarr as id ${series.id}`);
      }
      this.processed++;
    } catch (err) {
      const e = err as Error;
      // A 400 from an arr almost always means "already exists" -- not a failure the
      // user needs to see as red.
      const already = err instanceof ArrError && err.status === 400 && /already|exist/i.test(err.body);
      if (already) {
        store.updateRequest(tconst, { status: "sent", error: null });
        log(`request: "${req.title}" already existed in ${req.service}`);
        this.processed++;
        return;
      }
      store.updateRequest(tconst, {
        status: "failed",
        // SANITISED. The arr's own message quotes its response body, which carries root
        // folder paths and internal hostnames, and this column is served to the browser.
        // The full text goes to the log line below and stays there.
        error: safeArrMessage(err),
      });
      this.failed++;
      log(`request FAILED "${req.title}": ${e.message}`);
    }
  }

  /**
   * Monitor, then search. Both halves, in that order, and neither is optional.
   *
   * > [!WARNING] Sonarr will not search an UNMONITORED episode, and it does not say so
   * > `EpisodeSearch` against an unmonitored episode is accepted -- HTTP 201, a real
   * > command id -- and then quietly finds nothing. So monitoring is not preparation for
   * > the search, it is half of the request, and a failure to monitor must stop the search
   * > rather than let it run and look like a title with no releases.
   *
   * The mirror is updated optimistically the moment Sonarr accepts, so the row a reader is
   * looking at stops offering a button they have already pressed. It is not a second source
   * of truth: the next library sync overwrites it with whatever Sonarr actually says.
   */
  private async processEpisodes(tconst: string, episodeIds: number[]): Promise<void> {
    const { store, sonarr, log } = this.deps;
    if (!sonarr) {
      this.failed++;
      log(`episode request FAILED ${tconst}: Sonarr is not configured`);
      return;
    }
    try {
      await sonarr.monitorEpisodes(episodeIds, true);
      await sonarr.searchEpisodes(episodeIds);
      store.markEpisodesMonitored(tconst, episodeIds);
      this.processed++;
      log(`request: asked Sonarr to find ${episodeIds.length} episode(s) of ${tconst}`);
    } catch (err) {
      this.failed++;
      // Sanitised for the same reason a title request's error is: an arr's message quotes
      // its response body, which carries root folder paths. Only the log sees the detail --
      // and unlike a title request there is no row to write a safe message onto, because
      // the mirror is the record and it reports what Sonarr says rather than what we asked.
      log(`episode request FAILED ${tconst}: ${(err as Error).message}`);
    }
  }

  /**
   * Reconcile in-flight requests against reality.
   *
   * Two things to notice: a download that started (so we can show progress) and a
   * request that has been sitting with nothing found. The second is the case Seerr
   * handles worst -- it shows "Processing" forever for a title that has no release
   * anywhere, with no way for the user to know they should stop waiting.
   *
   * It also writes down WHY, in the same pass and from the same queue read -- see
   * `./diagnose-requests`. The status is the state machine; the diagnostic is the evidence
   * a reader is shown, and deriving one from the other is `verdictFor`'s job rather than
   * this method's.
   */
  async reconcile(): Promise<void> {
    const { store, log } = this.deps;
    const open = [
      ...store.listRequests("sent", 200),
      ...store.listRequests("grabbed", 200),
      ...store.listRequests("downloading", 200),
    ];
    if (open.length === 0) return;

    const lib = store.libraryMap();

    /*
      Anything that now has a file is done.

      THIS IS THE ONE PLACE A REQUEST BECOMES NEWS. `available_seen_at` is cleared with the
      transition rather than left alone, because a title can travel this way twice: it
      arrives, the asker is shown it, an admin removes the file, they re-request, and it
      arrives again. Leaving the old stamp would mean the second arrival was already marked
      as read before it happened. It is null on a first arrival anyway, so this costs
      nothing in the ordinary case and is correct in the other one.
    */
    for (const r of open) {
      const l = lib.get(r.tconst);
      if (l?.has_file === 1) {
        store.updateRequest(r.tconst, { status: "available", error: null, available_seen_at: null });
        log(`request: "${r.title}" is now available`);
      }
    }

    // ONE queue read, feeding both questions the queues can answer: is this downloading at
    // all, and how far along is it. Two reads would be two answers free to disagree.
    const downloads = await downloadsByArrId(this.deps);
    for (const r of open) {
      if (r.arr_id !== null && downloads.has(r.arr_id) && r.status !== "downloading") {
        store.updateRequest(r.tconst, { status: "downloading" });
      }
    }

    // Age out the hopeless ones. Nine reconcile passes is roughly 4.5 minutes of
    // being "sent" with nothing to show for it -- long enough to be meaningful,
    // short enough to be useful.
    //
    // No `error` is written with the transition. The sentence a reader sees for a
    // given-up request is `VERDICT_COPY.no_releases` (or `nothing_accepted`, when the
    // indexers turned out to have something) and it is chosen from the evidence below --
    // a fixed string here would be a second, blunter copy of the same claim.
    for (const r of open) {
      if (r.status !== "sent") continue;
      const attempts = r.search_attempts + 1;
      store.updateRequest(r.tconst, { search_attempts: attempts });
      const ageHours = (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
      if (attempts > 9 && ageHours > 24) {
        store.updateRequest(r.tconst, { status: "no_release", error: null });
        log(`request: "${r.title}" -> no_release`);
      }
    }

    // Safe to pass the rows read at the top of the pass: a diagnostic is keyed on tconst
    // and built from `title`, `arr_id` and `created_at`, none of which the loops above
    // touch. The STATUS they do move is read fresh wherever a verdict is derived.
    for (const d of await diagnoseRequests(this.deps, open, downloads)) {
      store.upsertRequestDiagnostic(d);
    }
  }
}
