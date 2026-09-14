/**
 * `/api/watch/*` -- where each reader stopped, written by the player and read by the pages.
 *
 * EVERY READER, not admin-only: a position is the reader's own state, keyed by the session's
 * USER. A principal with no user -- the admin API key -- owns nothing, so it writes nothing (204)
 * and reads empty. That is not an error; it is the true answer for a caller who is not a person.
 *
 * LOCAL SQLITE ONLY, and one statement per request. The player writes every ~15 s per viewer, so
 * a write is a guard plus one upsert and nothing else -- no index lookup, no "does this title
 * exist" read. The `:tconst` guard is a closed pattern instead, which is what keeps a hostile
 * client from filling its own history with rows that are not title ids.
 *
 * > [!IMPORTANT] WHY THERE IS NO ORIGIN CHECK, and what protects the writes instead
 * > No route in this server checks `Origin`; CSRF is closed by the session cookie being
 * > `SameSite=Lax` and by nothing that changes state answering GET. That holds here: `PUT` and
 * > `DELETE` cannot be sent cross-site without a preflight nobody answers, and the one simple
 * > request -- a `text/plain` `POST`, which is exactly what `sendBeacon` sends -- arrives
 * > cross-site WITHOUT the Lax cookie, so `withAuth` refuses it before this module runs.
 *
 * Bounds per the fifth rule: every number is refused past its `LIMITS` entry with a 400 naming
 * the limit, never clamped.
 */

import { boundedInt, boundedNumber, type Guarded, LIMITS, refusalMessage } from "../lib/input-guards";
import type { WatchHistoryPage, WatchState } from "../lib/watch-progress";
import { FILM_KEY, type WatchKey, type WatchStateStore } from "../lib/watch-state";
import { IMDB_ID } from "./artwork";
import { json } from "./json-response";

/** The history page size a request with no `limit` gets. */
export const WATCH_HISTORY_PAGE_DEFAULT = 60;

export interface WatchDeps {
  store: WatchStateStore;
  /** The signed-in PERSON behind a request, or null -- `readerId` in `index.ts`. */
  readerId: (req: Request) => string | null;
  /** Injected so a test can pin `updatedAt`. */
  now?: () => Date;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const refused = (error: string) => json({ error }, { status: 400 });
const nothing = () => new Response(null, { status: 204 });

/** A `:tconst` that is a well-formed IMDb id, or null. */
function tconstOf(raw: string): string | null {
  return raw.length <= LIMITS.id && IMDB_ID.test(raw) ? raw : null;
}

/**
 * A season and episode that go together: both absent is a film, both present is an episode, one
 * alone is refused -- half a key would silently address the film row.
 */
function keyFrom(season: Guarded<number | null>, episode: Guarded<number | null>): Parsed<WatchKey> {
  if (!season.ok) return { ok: false, error: refusalMessage("season", season) };
  if (!episode.ok) return { ok: false, error: refusalMessage("episode", episode) };
  if (season.value === null && episode.value === null) return { ok: true, value: FILM_KEY };
  if (season.value === null || episode.value === null) {
    return { ok: false, error: "season and episode are sent together or not at all" };
  }
  return { ok: true, value: { season: season.value, episode: episode.value } };
}

/**
 * Parse one write body. Exported for `abuse.test.ts`, which walks the hostile corpus over it.
 *
 * `positionSec` may overshoot `durationSec` by `LIMITS.watchOvershootSec` and is stored as sent
 * -- `isFinished` already reads a position past the end as finished, so there is nothing to clamp.
 */
export function parseWatchWrite(v: unknown): Parsed<WatchKey & { positionSec: number; durationSec: number }> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = v as Record<string, unknown>;
  const key = keyFrom(
    boundedNumber(b.season, { min: 0, max: LIMITS.seasonNumber, integer: true }),
    boundedNumber(b.episode, { min: 0, max: LIMITS.episodeNumber, integer: true }),
  );
  if (!key.ok) return key;

  const duration = boundedNumber(b.durationSec, { min: 0, max: LIMITS.watchSeconds });
  if (!duration.ok) return { ok: false, error: refusalMessage("durationSec", duration) };
  if (duration.value === null || duration.value === 0) return { ok: false, error: "durationSec is required" };

  const position = boundedNumber(b.positionSec, { min: 0, max: LIMITS.watchSeconds });
  if (!position.ok) return { ok: false, error: refusalMessage("positionSec", position) };
  if (position.value === null) return { ok: false, error: "positionSec is required" };
  if (position.value > duration.value + LIMITS.watchOvershootSec) {
    return {
      ok: false,
      error: `positionSec is past durationSec (limit ${LIMITS.watchOvershootSec}s over)`,
    };
  }

  return { ok: true, value: { ...key.value, positionSec: position.value, durationSec: duration.value } };
}

export function watchRoutes(deps: WatchDeps): Record<string, unknown> {
  const now = deps.now ?? (() => new Date());

  /**
   * PUT and POST are the same write. POST exists because `navigator.sendBeacon` can only POST,
   * and it sends `text/plain` -- so the body is read as TEXT and parsed as JSON whatever the
   * content type says.
   */
  const write = async (req: Bun.BunRequest<"/api/watch/:tconst">): Promise<Response> => {
    const tconst = tconstOf(req.params.tconst);
    if (!tconst) return refused("bad title id");
    const me = deps.readerId(req);
    if (!me) return nothing();

    const text = await req.text();
    if (text.length > LIMITS.watchBody) return refused(`body is too long (limit ${LIMITS.watchBody})`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refused("body must be JSON");
    }
    const parsed = parseWatchWrite(body);
    if (!parsed.ok) return refused(parsed.error);
    return json(deps.store.upsert(me, tconst, parsed.value, now()));
  };

  return {
    /** Static, so it wins over `/api/watch/:tconst` for GET -- and `history` is no tconst anyway. */
    "/api/watch/history": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const limit = boundedInt(q.get("limit"), { min: 1, max: LIMITS.pageSize });
        if (!limit.ok) return refused(refusalMessage("limit", limit));
        const offset = boundedInt(q.get("offset"), { min: 0, max: LIMITS.pageOffset });
        if (!offset.ok) return refused(refusalMessage("offset", offset));
        const me = deps.readerId(req);
        const page: WatchHistoryPage = me
          ? deps.store.history(me, {
              limit: limit.value ?? WATCH_HISTORY_PAGE_DEFAULT,
              offset: offset.value ?? 0,
            })
          : { entries: [], hasMore: false };
        return json(page);
      },
    },

    "/api/watch/:tconst": {
      /** The resume point and every episode's state, in one read of the primary key. */
      GET: (req: Bun.BunRequest<"/api/watch/:tconst">) => {
        const tconst = tconstOf(req.params.tconst);
        if (!tconst) return refused("bad title id");
        const me = deps.readerId(req);
        const rows = me ? deps.store.forTitle(me, tconst) : [];
        let resume: WatchState["resume"] = null;
        for (const r of rows) if (!resume || r.updatedAt > resume.updatedAt) resume = r;
        const state: WatchState = { resume, episodes: rows.filter((r) => r.season !== null) };
        return json(state);
      },
      PUT: write,
      POST: write,
      /** `?season=&episode=` forgets one episode; neither forgets the whole title. */
      DELETE: (req: Bun.BunRequest<"/api/watch/:tconst">) => {
        const tconst = tconstOf(req.params.tconst);
        if (!tconst) return refused("bad title id");
        const q = new URL(req.url).searchParams;
        const key = keyFrom(
          boundedInt(q.get("season"), { min: 0, max: LIMITS.seasonNumber }),
          boundedInt(q.get("episode"), { min: 0, max: LIMITS.episodeNumber }),
        );
        if (!key.ok) return refused(key.error);
        const me = deps.readerId(req);
        if (!me) return nothing();
        // No key names the whole title -- which, for a film, is its one row anyway.
        const at = key.value === FILM_KEY ? undefined : key.value;
        return json({ removed: deps.store.remove(me, tconst, at) });
      },
    },
  };
}
