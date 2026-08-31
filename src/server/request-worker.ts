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
import { decodeSeasons } from "../lib/seasons";
import type { Store } from "../lib/store";
import { searchOnAddOf } from "../lib/store";

export interface WorkerDeps {
  store: Store;
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  log: (...args: unknown[]) => void;
}

export class RequestWorker {
  private queue: string[] = [];
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
    if (!this.queue.includes(tconst)) this.queue.push(tconst);
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
        const tconst = this.queue.shift();
        if (!tconst) break;
        await this.process(tconst);
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
   * Reconcile in-flight requests against reality.
   *
   * Two things to notice: a download that started (so we can show progress) and a
   * request that has been sitting with nothing found. The second is the case Seerr
   * handles worst -- it shows "Processing" forever for a title that has no release
   * anywhere, with no way for the user to know they should stop waiting.
   */
  async reconcile(): Promise<void> {
    const { store, radarr, sonarr, log } = this.deps;
    const open = [
      ...store.listRequests("sent", 200),
      ...store.listRequests("grabbed", 200),
      ...store.listRequests("downloading", 200),
    ];
    if (open.length === 0) return;

    const lib = store.libraryMap();

    // Anything that now has a file is done.
    for (const r of open) {
      const l = lib.get(r.tconst);
      if (l?.has_file === 1) {
        store.updateRequest(r.tconst, { status: "available", error: null });
        log(`request: "${r.title}" is now available`);
      }
    }

    // Anything currently downloading gets flagged as such.
    try {
      const queues = await Promise.all([
        radarr ? radarr.queue() : Promise.resolve(null),
        sonarr ? sonarr.queue() : Promise.resolve(null),
      ]);
      const active = new Set<number>();
      for (const q of queues)
        for (const rec of q?.records ?? []) {
          if (rec.movieId) active.add(rec.movieId);
          if (rec.seriesId) active.add(rec.seriesId);
        }
      for (const r of open) {
        if (r.arr_id !== null && active.has(r.arr_id) && r.status !== "downloading") {
          store.updateRequest(r.tconst, { status: "downloading" });
        }
      }
    } catch {
      // A queue read failing is not worth surfacing; the next tick will retry.
    }

    // Age out the hopeless ones. Nine reconcile passes is roughly 4.5 minutes of
    // being "sent" with nothing to show for it -- long enough to be meaningful,
    // short enough to be useful.
    for (const r of open) {
      if (r.status !== "sent") continue;
      const attempts = r.search_attempts + 1;
      store.updateRequest(r.tconst, { search_attempts: attempts });
      const ageHours = (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
      if (attempts > 9 && ageHours > 24) {
        store.updateRequest(r.tconst, {
          status: "no_release",
          error: "No release found on any configured indexer after 24 hours of searching.",
        });
        log(`request: "${r.title}" -> no_release`);
      }
    }
  }
}
