/**
 * Poster resolution and byte caching.
 *
 * The IMDb index carries no artwork and TMDB's bulk export has no `imdb_id`, so
 * there is no free offline crosswalk between them. But Radarr and Sonarr resolve
 * `imdb:ttXXXXXXX` -> full metadata *including poster URLs* for ANY title, owned or
 * not, through metadata proxies we already talk to and are already authenticated
 * against. That is the crosswalk, and it needs no TMDB API key.
 *
 * Two layers, both permanent:
 *   1. imdb_id -> poster URL   (SQLite, resolved once via an arr lookup)
 *   2. poster URL -> bytes     (disk, fetched once)
 *
 * Neither layer is on the search render path. `/api/search` never waits for a
 * poster; the browser requests images separately and they stream in.
 */

import { mkdirSync } from "node:fs";
import type { RadarrClient, SonarrClient } from "../lib/arr";
import type { Config } from "../lib/config";
import { paths } from "../lib/config";
import { posterFrom, type Store, studioFrom } from "../lib/store";

/**
 * Only these hosts may be fetched. The URL comes from Radarr/Sonarr rather than the
 * user, but it still ends up in a server-side fetch, so it gets an allowlist --
 * a compromised or misconfigured metadata proxy must not turn this into an SSRF.
 */
const ALLOWED_HOSTS = new Set(["image.tmdb.org", "artworks.thetvdb.com", "assets.fanart.tv", "thetvdb.com"]);

/**
 * A remote image URL this service is willing to fetch, or null.
 *
 * The single owner of that judgement. `serveUrl` refuses anything this rejects, and the
 * facet image proxy asks the same question BEFORE handing the browser a path -- an image
 * we would refuse to fetch should read as "no image" and draw a fallback, rather than as
 * a link that 400s when the browser follows it.
 */
export function proxyableImageUrl(rawUrl: string): URL | null {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  return target.protocol === "https:" && ALLOWED_HOSTS.has(target.hostname) ? target : null;
}

/**
 * A width we will ask an upstream CDN for.
 *
 * `size` arrives from the query string, and `preferredSize` splices it INTO the upstream
 * path -- so an unchecked one is a path traversal on the CDN (`?size=../../whatever`
 * normalises away the `/t/p/` prefix and fetches something else entirely). Validated in
 * `serveUrl`, which is the one door every caller goes through.
 */
const IMAGE_SIZE = /^w\d{2,4}$|^original$/;

/** TMDB serves sized variants; asking for `original` wastes bandwidth on a card. */
function preferredSize(url: string, size: string): string {
  if (!url.includes("image.tmdb.org")) return url;
  return url.replace(/\/t\/p\/[^/]+\//, `/t/p/${size}/`);
}

/**
 * The width every image route falls back to, and the one the warm loop materialises.
 *
 * One constant because a poster warmed at one size and served at another is a cache that
 * never hits: the size is part of the filename.
 */
export const DEFAULT_IMAGE_SIZE = "w342";

const IMDB_ID = /^tt\d{7,10}$/;

export class ArtworkService {
  private dir: string;
  private inFlight = new Map<string, Promise<string | null>>();
  private byteFetches = new Map<string, Promise<ArrayBuffer | null>>();

  constructor(
    private cfg: Config,
    private store: Store,
    private clients: { radarr?: RadarrClient; sonarr?: SonarrClient },
    private log: (m: string) => void = () => {},
  ) {
    this.dir = `${paths(cfg).images}`;
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * imdb_id -> poster URL. Cached forever, including negative results, so a title
   * with genuinely no artwork is looked up once and never again.
   */
  async resolveUrl(tconst: string, kind: string): Promise<string | null> {
    const cached = this.store.getArtwork(tconst);
    // A row cached BEFORE studio existed has a url and a null studio, and returning
    // early here would mean it never gets one -- the badge would be permanently
    // missing for every title resolved before that column was added. Re-look-up once
    // to fill the gap; the url we already have is returned either way.
    if (cached !== undefined && (cached.url === null || cached.studio !== null)) {
      return cached.url;
    }

    const existing = this.inFlight.get(tconst);
    if (existing) return existing;
    if (cached?.url) {
      // Fill the studio in the background and hand back the known url immediately --
      // an image request must never wait on a metadata call.
      const fill = this.lookup(tconst, kind).finally(() => this.inFlight.delete(tconst));
      this.inFlight.set(tconst, fill);
      return cached.url;
    }

    const task = this.lookup(tconst, kind).finally(() => this.inFlight.delete(tconst));
    this.inFlight.set(tconst, task);
    return task;
  }

  private async lookup(tconst: string, kind: string): Promise<string | null> {
    const isSeries = kind === "tvSeries" || kind === "tvMiniSeries";
    // Try the natural service first, then the other -- IMDb's `titleType` and the
    // arrs' idea of what a thing is do not always agree (a miniseries may only exist
    // in Radarr, a "tvMovie" may be in Sonarr).
    const order = isSeries
      ? [this.clients.sonarr, this.clients.radarr]
      : [this.clients.radarr, this.clients.sonarr];

    let anyAnswered = false;
    // A service can answer with a studio but no poster, so the two are collected
    // independently -- otherwise a title with no artwork would also lose its badge.
    let studio: string | null = null;
    for (const client of order) {
      if (!client) continue;
      try {
        const found = await client.lookupByImdb(tconst);
        anyAnswered = true;
        studio ??= studioFrom(found);
        const url = posterFrom((found as { images?: unknown } | null)?.images);
        if (url) {
          this.store.setArtwork(tconst, url, studio);
          return url;
        }
      } catch {
        // A lookup FAILURE is not an answer -- the service may just be busy, or
        // restarting mid-refresh. Fall through and try the other one.
      }
    }

    // Only cache a negative when something actually answered and said "no poster".
    // Caching a transient failure would permanently blank a title's artwork.
    if (anyAnswered) this.store.setArtwork(tconst, null, studio);
    return null;
  }

  /**
   * Serve a poster by IMDb id: resolve the URL if unknown, fetch the bytes if
   * uncached, then serve from disk forever after.
   */
  async serve(tconst: string, size: string, kind = ""): Promise<Response> {
    if (!IMDB_ID.test(tconst)) return new Response("bad id", { status: 400 });
    // Also checked in `serveUrl`, and checked again HERE because resolving an unknown
    // title costs an arr lookup: a bogus size must not be able to buy one.
    if (!IMAGE_SIZE.test(size)) return new Response("bad size", { status: 400 });

    const cached = this.store.getArtwork(tconst);
    // A known-null means we already looked and there is no poster. Say so cheaply.
    if (cached !== undefined && cached.url === null) return new Response("no artwork", { status: 404 });

    const url = cached?.url ?? (await this.resolveUrl(tconst, kind));
    if (!url) return new Response("no artwork", { status: 404 });

    return this.serveUrl(url, size);
  }

  /**
   * Fetch-and-cache a remote image, keyed by a hash of the sized URL.
   *
   * EVERY route that serves upstream bytes lands here -- the poster route, and the facet
   * image proxy -- so both arguments are validated here rather than at each caller. `size`
   * reaches an upstream path, so an unvalidated one is a traversal on the CDN.
   */
  async serveUrl(rawUrl: string, size: string): Promise<Response> {
    if (!IMAGE_SIZE.test(size)) return new Response("bad size", { status: 400 });

    const target = proxyableImageUrl(preferredSize(rawUrl, size));
    if (!target) return new Response("image url not proxyable", { status: 400 });

    // Content-addressed filename: the URL fully determines the bytes, and hashing
    // avoids any path-separator or length problems from the remote path.
    const key = Bun.hash(target.href).toString(16);
    const ext = target.pathname.match(/\.(jpg|jpeg|png|webp)$/i)?.[1]?.toLowerCase() ?? "jpg";
    const local = `${this.dir}/${key}.${ext}`;

    const file = Bun.file(local);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "Content-Type": file.type || "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Cache": "HIT",
        },
      });
    }

    // Collapse concurrent misses -- a grid of 25 cards must not open 25 connections
    // to the same poster.
    const existing = this.byteFetches.get(local);
    const bytes = existing
      ? await existing
      : await (() => {
          const t = this.fetchBytes(target.href, local).finally(() => this.byteFetches.delete(local));
          this.byteFetches.set(local, t);
          return t;
        })();

    if (!bytes) return new Response("upstream failed", { status: 502 });
    return new Response(bytes, {
      headers: {
        "Content-Type": `image/${ext === "jpg" ? "jpeg" : ext}`,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Cache": "MISS",
      },
    });
  }

  private async fetchBytes(href: string, local: string): Promise<ArrayBuffer | null> {
    try {
      const res = await fetch(href, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (this.cfg.tmdb.cacheImages) {
        // Write via a temp name: a crash mid-write must never leave a truncated
        // poster that is then served forever as a cache hit.
        const tmp = `${local}.part`;
        await Bun.write(tmp, buf);
        await Bun.write(local, Bun.file(tmp));
        await Bun.file(tmp)
          .delete()
          .catch(() => {});
      }
      return buf;
    } catch (err) {
      this.log(`artwork fetch failed for ${href}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Warm the cache for titles about to be shown.
   *
   * Fire-and-forget, paced, and deliberately gentle: these are lookups against
   * the operator's own Radarr/Sonarr, and this stack has a documented history of
   * problems caused by bursts of API calls.
   */
  prewarm(titles: { tconst: string; kind: string }[], limit = 10): void {
    const unknown = titles
      .filter((t) => {
        const a = this.store.getArtwork(t.tconst);
        // Never looked up, OR looked up before studio existed and still missing one.
        return a === undefined || (a.url !== null && a.studio === null);
      })
      .slice(0, limit);
    if (unknown.length === 0) return;
    void (async () => {
      for (const t of unknown) {
        await this.resolveUrl(t.tconst, t.kind).catch(() => {});
        await Bun.sleep(120);
      }
    })();
  }

  /**
   * Fill in studios for titles cached before that column existed.
   *
   * Nothing else revisits these rows -- the poster is already resolved, so no image
   * request triggers a lookup -- which is why the badge was missing on every
   * discovery shelf. Paced hard: these are calls against the operator's own arrs, and
   * this stack has a documented history of trouble caused by bursts.
   */
  async backfillStudios(limit = 200, pauseMs = 100): Promise<number> {
    const ids = this.store.artworkNeedingStudio(limit);
    if (ids.length === 0) return 0;
    let filled = 0;
    for (const tconst of ids) {
      // Kind is unknown here, so `lookup` tries movie-first then series; it falls
      // through to the other service anyway.
      const before = this.store.getArtwork(tconst)?.studio ?? null;
      await this.lookup(tconst, "movie").catch(() => {});
      if (before === null && this.store.getArtwork(tconst)?.studio) filled++;
      await Bun.sleep(pauseMs);
    }
    this.log(`artwork: studio backfill -- ${filled} of ${ids.length} filled`);
    return filled;
  }

  /**
   * Fully materialise artwork for a set of titles: resolve the URL AND pull the
   * bytes to disk, so the first visitor pays nothing.
   *
   * This is for the rows that are always on screen -- the discovery shelves. Those
   * are `pin`ned so eviction can never take them, which is the difference between a
   * warm front page and one that re-fetches every time the cache fills up.
   */
  async materialise(
    titles: { tconst: string; kind: string }[],
    opts: { size?: string; pin?: boolean; pauseMs?: number } = {},
  ): Promise<{ ok: number; missing: number }> {
    const size = opts.size ?? DEFAULT_IMAGE_SIZE;
    let ok = 0;
    let missing = 0;
    for (const t of titles) {
      try {
        const url = await this.resolveUrl(t.tconst, t.kind);
        if (!url) {
          missing++;
          continue;
        }
        const res = await this.serveUrl(url, size);
        // Drain the body so the write to disk actually completes.
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) {
          ok++;
          if (opts.pin !== false) this.pinned.add(t.tconst);
        }
      } catch {
        missing++;
      }
      await Bun.sleep(opts.pauseMs ?? 80);
    }
    return { ok, missing };
  }

  /** Titles that must survive eviction -- the always-visible shelves. */
  private pinned = new Set<string>();

  /** Local path a resolved poster would occupy, for pin-aware eviction. */
  private localFor(rawUrl: string, size: string): string | null {
    const target = proxyableImageUrl(preferredSize(rawUrl, size));
    if (!target) return null;
    const key = Bun.hash(target.href).toString(16);
    const ext = target.pathname.match(/\.(jpg|jpeg|png|webp)$/i)?.[1]?.toLowerCase() ?? "jpg";
    return `${this.dir}/${key}.${ext}`;
  }

  /**
   * Evict least-recently-modified posters until the cache is under `maxBytes`.
   *
   * Deliberately simple. A poster is ~30 KB at w342, so even 2 GB holds tens of
   * thousands of them and this will rarely fire. Pinned titles are never evicted,
   * and anything wrongly evicted is one cheap re-fetch away -- the expensive half
   * (the imdb -> URL lookup) lives in SQLite and is never evicted at all.
   */
  async evict(
    maxBytes: number,
    size = DEFAULT_IMAGE_SIZE,
  ): Promise<{ deleted: number; freed: number; kept: number }> {
    const protectedPaths = new Set<string>();
    for (const tconst of this.pinned) {
      const art = this.store.getArtwork(tconst);
      if (art?.url) {
        const p = this.localFor(art.url, size);
        if (p) protectedPaths.add(p);
      }
    }

    const glob = new Bun.Glob("*.{jpg,jpeg,png,webp}");
    const files: { path: string; size: number; mtime: number }[] = [];
    let total = 0;
    for await (const name of glob.scan({ cwd: this.dir })) {
      const path = `${this.dir}/${name}`;
      const f = Bun.file(path);
      const bytes = f.size;
      total += bytes;
      files.push({ path, size: bytes, mtime: f.lastModified });
    }

    if (total <= maxBytes) return { deleted: 0, freed: 0, kept: files.length };

    // Oldest first, skipping anything pinned.
    files.sort((a, b) => a.mtime - b.mtime);
    let freed = 0;
    let deleted = 0;
    for (const f of files) {
      if (total - freed <= maxBytes) break;
      if (protectedPaths.has(f.path)) continue;
      try {
        await Bun.file(f.path).delete();
        freed += f.size;
        deleted++;
      } catch {
        // A file that vanished under us is already evicted.
      }
    }
    this.log(
      `artwork eviction: removed ${deleted} files, freed ${(freed / 1e6).toFixed(1)} MB ` +
        `(${protectedPaths.size} pinned kept)`,
    );
    return { deleted, freed, kept: files.length - deleted };
  }

  async diskUsage(): Promise<{ files: number; bytes: number }> {
    const glob = new Bun.Glob("*.{jpg,jpeg,png,webp}");
    let files = 0;
    let bytes = 0;
    for await (const name of glob.scan({ cwd: this.dir })) {
      files++;
      bytes += Bun.file(`${this.dir}/${name}`).size;
    }
    return { files, bytes };
  }

  stats() {
    return { ...this.store.artworkCount(), pinned: this.pinned.size };
  }
}
