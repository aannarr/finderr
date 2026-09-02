/**
 * Prowlarr, read-only.
 *
 * The one question finderr asks it: *did the searches Radarr and Sonarr already ran come
 * back with anything?* Prowlarr is the only service that knows, because the arrs record
 * what they GRABBED and never what they were offered and turned down.
 *
 * > [!CAUTION] finderr never asks Prowlarr to SEARCH
 * > `/api/v1/search` runs a live query against every configured indexer, and a page that
 * > triggered one on render would turn a reader refreshing a request into an indexer flood
 * > -- which is how a tracker account gets suspended. This client has exactly one method
 * > and it reads history. Adding a search endpoint here needs a deliberate decision about
 * > who may trigger it and how often, not a convenience wrapper.
 */

import { ServarrHttp } from "./arr";
import type { ServarrService } from "./config";

/**
 * One row of Prowlarr's history.
 *
 * Everything is optional because this is somebody else's JSON and a missing field must
 * degrade to "we do not know" rather than throw on a timer. `data` is a bag whose keys
 * differ per `eventType`; only the two that answer our question are named.
 */
export interface ProwlarrHistoryRecord {
  /**
   * `indexerQuery`, `indexerRss`, `releaseGrabbed`, `indexerAuth`, ...
   *
   * ONLY `indexerQuery` is a search somebody asked for. `indexerRss` is Prowlarr polling
   * an indexer's feed on its own schedule, which happens whether or not anybody requested
   * anything -- counting it would make every title look heavily searched.
   */
  eventType?: string;
  date?: string;
  indexerId?: number;
  data?: {
    /** The text the arr sent, e.g. "Sicario 2015". The only join we have -- see below. */
    query?: string;
    /**
     * How many releases the indexer returned. A STRING on the wire: Prowlarr serialises
     * every `data` value as text, so `0` arrives as `"0"` and a numeric comparison against
     * the raw field silently reads "no results" as truthy.
     */
    queryResults?: string | number;
  };
}

export class ProwlarrClient extends ServarrHttp {
  constructor(svc: ServarrService) {
    super("prowlarr", svc, "v1");
  }

  /**
   * The most recent history rows, newest first.
   *
   * One page for the whole instance rather than a query per request: Prowlarr has no
   * endpoint keyed on anything finderr holds (see the correlation note in
   * `./request-diagnostics.ts`), so a per-request call would be the same page fetched N
   * times. The default is generous because an RSS-heavy instance can bury a day of real
   * searches under polls, and the polls are filtered out on our side.
   */
  history(pageSize = 500) {
    return this.get<{ records: ProwlarrHistoryRecord[] }>("/history", {
      page: 1,
      pageSize,
      sortKey: "date",
      sortDirection: "descending",
    });
  }
}
