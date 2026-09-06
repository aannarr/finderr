/**
 * Poster proxy with an on-disk cache.
 *
 * Hotlinking image.tmdb.org means every card on every page is a fresh TLS round trip
 * to a CDN in another continent. Proxying once and serving from local disk turns a
 * 200-800ms image into a ~1ms one, and posters are essentially the entire page weight.
 *
 * image.tmdb.org needs no API key -- verified with a plain unauthenticated GET.
 */

import { mkdirSync } from "node:fs";
import type { Config } from "./../lib/config";
import { paths } from "./../lib/config";
import type { TmdbSettingsReader } from "./../lib/tmdb-settings";
import { cacheHeaders, IMMUTABLE_PUBLIC } from "./cache-policy";

const ALLOWED_SIZES = new Set(["w92", "w154", "w185", "w342", "w500", "w780", "original"]);

/** TMDB paths look like /qJ2tW6WMUDux911r6m7haRef0WH.jpg -- nothing else is acceptable. */
const SAFE_PATH = /^[A-Za-z0-9_-]+\.(?:jpg|png|webp|svg)$/;

export class ImageCache {
  private dir: string;
  private inFlight = new Map<string, Promise<Response>>();

  /**
   * `tmdb` is the RUNTIME half: where the upstream lives is a setting an operator can change
   * on the admin page, so it is read per miss rather than captured here. `cfg` keeps the two
   * halves a deployment fixes -- the cache directory and whether to write to it at all.
   */
  constructor(
    private cfg: Config,
    private tmdb: TmdbSettingsReader,
  ) {
    this.dir = paths(cfg).images;
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * `size` and `file` are attacker-controlled, so both are validated against
   * allowlists rather than sanitized. No path separators can survive SAFE_PATH,
   * so there is no traversal to defend against.
   */
  async serve(size: string, file: string): Promise<Response> {
    if (!ALLOWED_SIZES.has(size)) return new Response("bad size", { status: 400 });
    if (!SAFE_PATH.test(file)) return new Response("bad path", { status: 400 });

    const key = `${size}/${file}`;
    const local = `${this.dir}/${size}__${file}`;

    const cached = Bun.file(local);
    if (await cached.exists()) {
      return new Response(cached, {
        headers: {
          "Content-Type": cached.type || "image/jpeg",
          // Poster paths are content-addressed by TMDB; a given path never changes.
          ...cacheHeaders(IMMUTABLE_PUBLIC),
          "X-Cache": "HIT",
        },
      });
    }

    // Collapse concurrent misses for the same poster into one upstream fetch --
    // a grid of 25 cards rendering at once should not open 25 connections.
    const existing = this.inFlight.get(key);
    if (existing) return (await existing).clone();

    const task = this.fetchAndStore(size, file, local);
    this.inFlight.set(key, task);
    try {
      return (await task).clone();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchAndStore(size: string, file: string, local: string): Promise<Response> {
    const upstream = `${this.tmdb.read().imageBase}/${size}/${file}`;
    let res: Response;
    try {
      res = await fetch(upstream, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      return new Response(`upstream failed: ${(err as Error).message}`, {
        status: 502,
      });
    }
    if (!res.ok)
      return new Response("not found upstream", {
        status: res.status === 404 ? 404 : 502,
      });

    const bytes = await res.arrayBuffer();
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (this.cfg.tmdb.cacheImages) {
      // Write via a temp name so a crash mid-write can never leave a truncated
      // poster that would then be served forever as a cache hit.
      const tmp = `${local}.part`;
      await Bun.write(tmp, bytes);
      await Bun.write(local, Bun.file(tmp));
      await Bun.file(tmp)
        .delete()
        .catch(() => {});
    }
    return new Response(bytes, {
      headers: {
        "Content-Type": type,
        ...cacheHeaders(IMMUTABLE_PUBLIC),
        "X-Cache": "MISS",
      },
    });
  }

  async stats(): Promise<{ files: number; bytes: number }> {
    const glob = new Bun.Glob("*");
    let files = 0;
    let bytes = 0;
    for await (const name of glob.scan({ cwd: this.dir })) {
      files++;
      bytes += Bun.file(`${this.dir}/${name}`).size;
    }
    return { files, bytes };
  }
}
