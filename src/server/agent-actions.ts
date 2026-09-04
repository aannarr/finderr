/**
 * `AgentActions` against the real Radarr and Sonarr -- the server half of the write tool.
 *
 * The tool layer (`../lib/agent/actions.ts`) declares WHAT can be done and bounds how much;
 * this decides whether one particular ask is allowed and performs it. Split that way because
 * the decision needs the store, the request worker, the live index and the asking principal,
 * none of which belong in an `AgentContext` that the benchmark harness also constructs.
 *
 * > [!IMPORTANT] THE ORDER OF CHECKS IS COPIED FROM `POST /api/requests` ON PURPOSE
 * > Unknown title -> service configured -> already in library -> daily quota, quota LAST and
 * > only when a row would actually be created. That ordering is load-bearing and its reasons
 * > are written out at the route: an impossible request must never come back as "you have
 * > asked for too many", and a title that already has a request row is exempt because
 * > `createRequest` upserts and no new row is written.
 * >
 * > **This is duplication and it is worth naming rather than hiding.** The route owns the
 * > HTTP shape of the same decision and the two must not drift. What is genuinely shared is
 * > shared -- `quotaVerdict`, `serviceFor`, `store.createRequest`, `worker.enqueue` -- and
 * > what is duplicated is the ORDER, which is four lines. Extracting those four lines would
 * > mean threading `Response` construction through a function that has no business knowing
 * > about HTTP, so the copy is the cheaper of two bad options. If a fifth check appears,
 * > that trade flips and this should become a shared decision function.
 */

import { type AgentActions, ConversationBudget, type RequestOutcome } from "../lib/agent/actions";
import type { Principal } from "../lib/auth";
import { entityKindFor } from "../lib/facets";
import { quotaVerdict, utcDayStart } from "../lib/request-quota";
import type { Store } from "../lib/store";
import type { LiveIndex } from "./live-index";
import type { RequestWorker } from "./request-worker";

export interface AgentActionDeps {
  store: Store;
  worker: RequestWorker;
  live: LiveIndex;
  /** Who is asking. Their daily quota and their attribution. */
  principal: Principal | null;
  /** Which arrs exist. A request for a service that is not configured is refused, not queued. */
  has: { radarr: boolean; sonarr: boolean };
  quotaPerDay: number;
}

/** Same question the facet vocabulary answers, so "is this episodic?" keeps one owner. */
function serviceFor(kind: string): "radarr" | "sonarr" {
  return entityKindFor(kind) === "series" ? "sonarr" : "radarr";
}

export function makeAgentActions(deps: AgentActionDeps): AgentActions {
  const budget = new ConversationBudget();
  // The record of what this conversation actually did. See `performed` on the interface.
  const log: RequestOutcome[] = [];

  /**
   * The daily quota, asked exactly as the route asks it.
   *
   * Returns a REASON rather than a Response, because the caller here is a model and not a
   * browser -- but the verdict itself comes from the same `quotaVerdict`, so a person cannot
   * get a different answer by asking through the assistant than by pressing the button.
   */
  function quotaRefusal(): string | null {
    const me = deps.principal?.user?.id;
    if (!me) return null;
    const v = quotaVerdict({
      role: deps.principal?.role ?? "user",
      limit: deps.quotaPerDay,
      usedToday: () => deps.store.countRequestsSince(me, utcDayStart(new Date())),
      now: new Date(),
    });
    return v.allowed ? null : v.message;
  }

  return {
    remaining: () => budget.remaining(),
    spend: (n) => budget.spend(n),
    performed: () => log.slice(),

    requestTitles(tconsts) {
      const out: RequestOutcome[] = [];
      for (const tconst of tconsts) {
        const row = deps.live.current.byTconst(tconst);
        if (!row) {
          out.push({
            tconst,
            title: tconst,
            grain: "movie",
            status: "not_found",
            reason: "unknown title id",
          });
          continue;
        }
        const service = serviceFor(row.kind);
        const grain = service === "sonarr" ? "series" : "movie";
        const named = { tconst, title: row.title, grain } as const;

        if (service === "radarr" && !deps.has.radarr) {
          out.push({ ...named, status: "refused", reason: "Radarr is not configured" });
          continue;
        }
        if (service === "sonarr" && !deps.has.sonarr) {
          out.push({ ...named, status: "refused", reason: "Sonarr is not configured" });
          continue;
        }
        if (deps.store.libraryMap().has(row.tconst)) {
          out.push({ ...named, status: "already_have", reason: "already in the library" });
          continue;
        }
        // Quota LAST, and only when a row would actually be created -- see the header.
        if (!deps.store.getRequest(row.tconst)) {
          const refused = quotaRefusal();
          if (refused) {
            out.push({ ...named, status: "refused", reason: refused });
            continue;
          }
        } else {
          out.push({ ...named, status: "already_requested", reason: "already requested" });
          continue;
        }

        deps.store.createRequest({
          tconst: row.tconst,
          title: row.title,
          year: row.year,
          kind: row.kind,
          service,
          requestedBy: deps.principal?.user?.id ?? null,
        });
        deps.worker.enqueue(row.tconst);
        out.push({ ...named, status: "queued" });
      }
      log.push(...out);
      return out;
    },

    requestEpisodes(parent, episodes) {
      const out: RequestOutcome[] = [];
      const row = deps.live.current.byTconst(parent);
      const title = row?.title ?? parent;

      if (!deps.has.sonarr) {
        const refusals = episodes.map((e) => ({
          tconst: parent,
          title,
          grain: "episode" as const,
          season: e.season,
          episode: e.number,
          status: "refused" as const,
          reason: "Sonarr is not configured",
        }));
        log.push(...refusals);
        return refusals;
      }

      /*
        THE MIRROR IS THE AUTHORITY, not the IMDb index the agent read the numbers from.

        The agent chose these episodes from `title.episode`, which is IMDb's numbering; Sonarr
        numbers from TVDB and the two disagree often enough to matter -- absolute ordering,
        specials, a two-parter counted as one episode. `store.getEpisode` is the join, and a
        miss is reported as `not_found` rather than guessed at, which is what makes a numbering
        mismatch a visible refusal instead of the wrong download.
      */
      const ids: number[] = [];
      for (const e of episodes) {
        const known = deps.store.getEpisode(parent, e.season, e.number);
        const named = {
          tconst: parent,
          title,
          grain: "episode" as const,
          season: e.season,
          episode: e.number,
        };
        if (!known) {
          out.push({ ...named, status: "not_found", reason: "Sonarr does not list that episode" });
          continue;
        }
        if (known.has_file === 1) {
          out.push({ ...named, status: "already_have", reason: "already downloaded" });
          continue;
        }
        ids.push(known.arr_episode_id);
        out.push({ ...named, status: "queued" });
      }

      // One enqueue for the whole batch rather than one per episode: the worker takes a list,
      // and the per-row route only sends one because it only ever has one.
      if (ids.length > 0) deps.worker.enqueueEpisodes(parent, ids);
      log.push(...out);
      return out;
    },
  };
}
