/**
 * Plex, as a MIRROR -- "is this on the server, and what is its ratingKey?" answered from
 * local SQLite, never from a request while a reader waits.
 *
 * The point is one link: a title we already hold should offer to PLAY, not only to be
 * requested. That needs two facts Plex will not hand over in a single addressable call.
 *
 * > [!IMPORTANT] Plex cannot be asked "which item is `tt0092494`?"
 * > Verified against the live server 2026-08-31. `?guid=` on `/library/all` matches ONLY
 * > the modern agent's own `plex://movie/<hash>` guid; `?guid=imdb://tt0092494` returns
 * > `size: 0` for an item that is unquestionably there. The IMDb id lives in the `Guid`
 * > CHILDREN, which arrive only with `includeGuids=1` and cannot be queried on. So there
 * > is no lookup endpoint to hit lazily even if we wanted one -- the crosswalk has to be
 * > built by walking each section and inverting it, which is exactly what a mirror is.
 *
 * That constraint turns out to cost nothing: the walk is a handful of requests against a
 * server on our own LAN, the same shape and the same timer as the Radarr/Sonarr mirror
 * beside it, and it is what keeps the render path local.
 */

import type { Store } from "./store";

/** What one mirrored Plex item is, reduced to the two things a link needs. */
export interface PlexItem {
  /** Our own `tconst`, lifted out of the item's `Guid` children. */
  imdb_id: string;
  /** Plex's id for the item, and the only part of the deeplink that varies per title. */
  rating_key: string;
}

/**
 * A deeplink pair for one item, or null when we cannot build an honest one.
 *
 * Two addresses because they fail in opposite directions: the web app works anywhere but
 * lands in a browser, and `plex://` opens the real app but silently does nothing when no
 * app is installed to claim it. Offering both and labelling them is the only version that
 * is not a guess about the reader's machine.
 */
export interface PlexLinks {
  web: string;
  app: string;
}

/**
 * The two addresses for one item on one server.
 *
 * Both templates are TAKEN VERBATIM from Jellyseerr's `server/entity/Media.ts` (`mediaUrl`
 * and `iOSPlexUrl`) rather than remembered, because Plex documents neither and a deeplink
 * that is subtly wrong does not fail -- it opens the server's home screen and looks like it
 * worked. If these ever need changing, check that file again rather than reasoning about it.
 *
 * The `key` is a URL-ENCODED path -- `%2Flibrary%2Fmetadata%2F123`, never
 * `/library/metadata/123`. Raw slashes are read as further hash-route segments, which is
 * exactly the silent version of the failure above. Note also that the web form has NO slash
 * before the `#!`: it is `app.plex.tv/desktop#!/...`.
 *
 * Both need the server's `machineIdentifier`, which is why an unidentified server yields NO
 * link rather than a half-built one: `/library/metadata/<key>` is meaningless without
 * knowing whose library.
 */
export function plexLinks(machineIdentifier: string, ratingKey: string): PlexLinks | null {
  if (!machineIdentifier || !ratingKey) return null;
  const key = `%2Flibrary%2Fmetadata%2F${encodeURIComponent(ratingKey)}`;
  return {
    web: `https://app.plex.tv/desktop#!/server/${machineIdentifier}/details?key=${key}`,
    app: `plex://preplay/?metadataKey=${key}&server=${machineIdentifier}`,
  };
}

// ---------------------------------------------------------------------------

interface PlexGuid {
  id?: string | null;
}

interface PlexMetadata {
  ratingKey?: string | number | null;
  Guid?: PlexGuid[] | null;
}

interface PlexDirectory {
  key?: string | null;
  type?: string | null;
}

interface PlexContainer<T> {
  MediaContainer?: {
    Metadata?: T[] | null;
    Directory?: T[] | null;
    machineIdentifier?: string | null;
    /** Items in the whole section. Present only when the request asked for a page. */
    totalSize?: number | null;
  };
}

/** The section types worth walking. A photo or music library has no `tconst` in it. */
const VIDEO_SECTIONS = new Set(["movie", "show"]);

/**
 * Items per request when walking a section.
 *
 * 500 rather than everything: a Plex item is ~2.3 KB of JSON here (2,662,805 bytes for the
 * 1,141 items in the movie section, measured 2026-09-07), of which the mirror keeps two
 * fields, so a whole-section fetch is a multi-megabyte parse to build a table of `tconst ->
 * ratingKey`. At this size that is three requests instead of one against a server on our own
 * LAN, and the peak stops growing with the library.
 */
const PAGE_SIZE = 500;

/**
 * A read-only client for one Plex Media Server.
 *
 * The token goes in the `X-Plex-Token` HEADER rather than the query string, for the reason
 * `src/plugins/tmdb` learned the hard way about `?api_key=`: an error message that quotes a
 * URL then quotes the credential. Nothing here logs a URL, and this way nothing can.
 */
export class PlexClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      headers: { Accept: "application/json", "X-Plex-Token": this.token },
    });
    // The status alone -- never the URL, which carries the path we asked for and, if a
    // caller ever builds one wrong, could carry the token.
    if (!res.ok) throw new Error(`plex responded ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * This server's stable identity, which the deeplink is addressed to.
   *
   * Read from the server rather than configured, because it is a fact the server already
   * knows and a hand-copied one is a fact that can be wrong. `/identity` needs no token,
   * but it goes through the same path as everything else so there is one client.
   */
  async machineIdentifier(): Promise<string | null> {
    const res = await this.get<PlexContainer<never>>("/identity");
    return res.MediaContainer?.machineIdentifier ?? null;
  }

  /** The keys of every movie and show section. Anything else has no titles in it. */
  async videoSectionKeys(): Promise<string[]> {
    const res = await this.get<PlexContainer<PlexDirectory>>("/library/sections");
    return (res.MediaContainer?.Directory ?? [])
      .filter((d) => typeof d.type === "string" && VIDEO_SECTIONS.has(d.type))
      .map((d) => String(d.key ?? ""))
      .filter((k) => k !== "");
  }

  /**
   * Every item in one section, as `tconst -> ratingKey`, a page of `PAGE_SIZE` at a time.
   *
   * `includeGuids=1` is what makes this possible at all -- without it the response carries
   * only the agent's own `plex://` guid and nothing that crosswalks to our index.
   *
   * > [!IMPORTANT] Plex really does honour `X-Plex-Container-Start` / `-Size`, and `totalSize`
   * > only appears when you ask for a page
   * > Measured against the live server 2026-09-07. Unpaged, section 1 came back
   * > `size: 1141, totalSize: undefined`; with `Start=0&Size=100` it came back
   * > `size: 100, totalSize: 1141, offset: 0`, and `Start=100` returned a genuinely different
   * > first item. That asymmetry is why the loop below falls back to `size` -- against a
   * > server that ignored the parameters it would see one page holding everything and stop,
   * > rather than asking for offset 500 of a list it already has in full, forever.
   *
   * The projection happens HERE rather than in the caller so a fat `Metadata` record is
   * never held past the page it arrived in: what escapes this method is two strings per item.
   */
  async *sectionItems(key: string): AsyncGenerator<PlexItem> {
    const section = `/library/sections/${encodeURIComponent(key)}/all?includeGuids=1`;
    for (let start = 0; ; ) {
      const res = await this.get<PlexContainer<PlexMetadata>>(
        `${section}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}`,
      );
      const page = res.MediaContainer?.Metadata ?? [];
      for (const m of page) {
        const imdb_id = imdbGuidOf(m.Guid);
        const rating_key = m.ratingKey == null ? "" : String(m.ratingKey);
        // An item with no IMDb guid is one Plex matched with a legacy agent, or did not
        // match at all. It is real and it is unreachable from our index, so it is not a row.
        if (imdb_id && rating_key) yield { imdb_id, rating_key };
      }

      // Advance by what THIS response actually held rather than by the page size we asked
      // for: a server that answers with a different length can then neither skip an item nor
      // be asked for one twice.
      if (page.length === 0) return;
      start += page.length;
      if (start >= (res.MediaContainer?.totalSize ?? page.length)) return;
    }
  }
}

/** The `imdb://tt...` entry among an item's guids, as a bare `tconst`. */
function imdbGuidOf(guids: PlexGuid[] | null | undefined): string {
  for (const g of guids ?? []) {
    const id = typeof g.id === "string" ? g.id : "";
    if (id.startsWith("imdb://")) return id.slice("imdb://".length);
  }
  return "";
}

/**
 * Walk every video section into the mirror, and record who we walked.
 *
 * One transaction per run, like `replaceLibrary`: an item deleted from Plex has to
 * disappear here too, and a full swap is the only way to notice a deletion without a
 * second round trip.
 *
 * A FAILURE LEAVES THE OLD MIRROR ALONE. Plex being down for a minute is not a reason to
 * stop offering to play things -- a ratingKey is stable, so a slightly stale mirror is a
 * working link, while an emptied one is a page that quietly loses its Play buttons.
 */
export async function syncPlex(
  store: Store,
  client: PlexClient | undefined,
  log: (m: string) => void = () => {},
): Promise<{ items?: number; error?: string }> {
  if (!client) return {};
  try {
    const machineIdentifier = await client.machineIdentifier();
    if (!machineIdentifier) return { error: "plex: server reported no machineIdentifier" };

    const keys = await client.videoSectionKeys();
    // The accumulated list is the NARROW one -- two strings per item, ~1,700 of them here --
    // and it is collected in full before anything is written, because `replacePlexItems` is a
    // swap: streaming it straight into the transaction would let a walk that failed halfway
    // leave the mirror holding half a library. What is bounded is the FAT parse, one page of
    // `Metadata` at a time, inside `sectionItems`.
    const items: PlexItem[] = [];
    for (const key of keys) {
      for await (const item of client.sectionItems(key)) items.push(item);
    }

    const count = store.replacePlexItems(machineIdentifier, items);
    log(`plex: ${count} items mirrored from ${keys.length} section(s)`);
    return { items: count };
  } catch (err) {
    return { error: `plex: ${(err as Error).message}` };
  }
}
