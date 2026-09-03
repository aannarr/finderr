/**
 * IMDb dataset acquisition.
 *
 * IMDb publishes daily gzipped TSVs and honours conditional GETs, so the common
 * case (nothing changed since yesterday) costs one HEAD and zero bytes.
 *
 * Licence note: these datasets are published for personal, non-commercial use.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

export const IMDB_BASE = "https://datasets.imdbws.com";

export type DumpName = "title.basics" | "title.ratings" | "title.akas" | "title.principals" | "name.basics";

/**
 * The exact header each TSV must present. If IMDb reorders or renames a column we
 * MUST fail loudly rather than silently ingest values into the wrong fields --
 * a shifted column would poison the index in a way no row count would catch.
 */
export const EXPECTED_HEADERS: Record<DumpName, string> = {
  "title.basics":
    "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres",
  "title.ratings": "tconst\taverageRating\tnumVotes",
  "title.akas": "titleId\tordering\ttitle\tregion\tlanguage\ttypes\tattributes\tisOriginalTitle",
  // By far the largest thing we ingest -- and the reason the cast build is floored rather
  // than complete. The row count lives on `castMinVotes` in ./config.ts, which owns it.
  "title.principals": "tconst\tordering\tnconst\tcategory\tjob\tcharacters",
  "name.basics": "nconst\tprimaryName\tbirthYear\tdeathYear\tprimaryProfession\tknownForTitles",
};

export class SchemaDriftError extends Error {
  constructor(
    readonly dump: DumpName,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `schema drift in ${dump}.tsv\n` +
        `  expected: ${expected.replace(/\t/g, " | ")}\n` +
        `  actual:   ${actual.replace(/\t/g, " | ")}\n` +
        "Refusing to ingest -- columns may have shifted. The existing index is untouched.",
    );
    this.name = "SchemaDriftError";
  }
}

export interface DumpState {
  etag?: string;
  lastModified?: string;
  fetchedAt?: string;
  bytes?: number;
}

/** Tiny key/value store for ETags, kept beside the app DB. */
export class DumpStateStore {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("pragma journal_mode = wal");
    this.db.run(
      "create table if not exists dump_state (name text primary key, etag text, last_modified text, fetched_at text, bytes int)",
    );
  }
  get(name: string): DumpState {
    const r = this.db
      .query("select etag, last_modified, fetched_at, bytes from dump_state where name = ?")
      .get(name) as
      | {
          etag: string | null;
          last_modified: string | null;
          fetched_at: string | null;
          bytes: number | null;
        }
      | undefined;
    if (!r) return {};
    return {
      etag: r.etag ?? undefined,
      lastModified: r.last_modified ?? undefined,
      fetchedAt: r.fetched_at ?? undefined,
      bytes: r.bytes ?? undefined,
    };
  }
  set(name: string, s: DumpState): void {
    this.db.run(
      "insert into dump_state (name, etag, last_modified, fetched_at, bytes) values (?,?,?,?,?) " +
        "on conflict(name) do update set etag=excluded.etag, last_modified=excluded.last_modified, " +
        "fetched_at=excluded.fetched_at, bytes=excluded.bytes",
      [name, s.etag ?? null, s.lastModified ?? null, s.fetchedAt ?? null, s.bytes ?? null],
    );
  }
  close(): void {
    this.db.close();
  }
}

export interface FetchResult {
  changed: boolean;
  path: string;
  bytes: number;
  etag?: string;
  lastModified?: string;
}

/**
 * Download a dump only if it changed upstream.
 *
 * We ask with `If-None-Match`; a 304 means the local copy is current and we return
 * `changed: false` having transferred nothing.
 */
export async function fetchDump(
  dump: DumpName,
  dir: string,
  state: DumpStateStore,
  onProgress?: (received: number, total: number) => void,
): Promise<FetchResult> {
  mkdirSync(dir, { recursive: true });
  const url = `${IMDB_BASE}/${dump}.tsv.gz`;
  const path = `${dir}/${dump}.tsv.gz`;
  const prev = state.get(dump);

  const headers: Record<string, string> = {};
  // Only send a conditional request if we still have the file it refers to.
  const haveFile = await Bun.file(path).exists();
  if (haveFile && prev.etag) headers["If-None-Match"] = prev.etag;
  else if (haveFile && prev.lastModified) headers["If-Modified-Since"] = prev.lastModified;

  const res = await fetch(url, { headers });

  if (res.status === 304) {
    return {
      changed: false,
      path,
      bytes: prev.bytes ?? 0,
      etag: prev.etag,
      lastModified: prev.lastModified,
    };
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);

  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;
  const total = Number.parseInt(res.headers.get("content-length") ?? "0", 10);

  // Stream to a temp file so an aborted download can never be mistaken for a good one.
  const tmp = `${path}.part`;
  const sink = Bun.file(tmp).writer();
  let received = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`GET ${url} returned no body`);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sink.write(value);
    received += value.byteLength;
    onProgress?.(received, total);
  }
  await sink.end();

  if (total > 0 && received !== total) {
    throw new Error(`truncated download of ${dump}: got ${received} of ${total} bytes`);
  }

  await Bun.write(Bun.file(path), Bun.file(tmp));
  await Bun.file(tmp)
    .delete()
    .catch(() => {});

  state.set(dump, {
    etag,
    lastModified,
    fetchedAt: new Date().toISOString(),
    bytes: received,
  });
  return { changed: true, path, bytes: received, etag, lastModified };
}

/** HEAD a dump to see whether it changed, transferring nothing. */
export async function dumpChanged(dump: DumpName, state: DumpStateStore): Promise<boolean> {
  const prev = state.get(dump);
  if (!prev.etag && !prev.lastModified) return true;
  const res = await fetch(`${IMDB_BASE}/${dump}.tsv.gz`, { method: "HEAD" });
  if (!res.ok) throw new Error(`HEAD ${dump} -> ${res.status}`);
  const etag = res.headers.get("etag");
  if (etag && prev.etag) return etag !== prev.etag;
  const lm = res.headers.get("last-modified");
  if (lm && prev.lastModified) return lm !== prev.lastModified;
  return true;
}

/**
 * Stream a gzipped TSV line by line, asserting the header first.
 *
 * Uses `gunzip -c` rather than an in-process inflate: it is a separate core doing the
 * decompression, and these files are large (title.basics is 226 MB compressed).
 */
export async function* streamTsv(path: string, dump: DumpName): AsyncGenerator<string[], void, undefined> {
  const proc = Bun.spawn(["gunzip", "-c", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let buffer = "";
  let headerChecked = false;

  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!headerChecked) {
        headerChecked = true;
        const expected = EXPECTED_HEADERS[dump];
        if (line.trimEnd() !== expected) {
          proc.kill();
          throw new SchemaDriftError(dump, expected, line.trimEnd());
        }
      } else if (line.length > 0) {
        yield line.split("\t");
      }
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim().length > 0 && headerChecked) yield buffer.split("\t");

  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`gunzip ${path} exited ${code}: ${err.slice(0, 400)}`);
  }
}

/** IMDb writes `\N` for null. */
export function nullable(v: string | undefined): string | null {
  return v === undefined || v === "\\N" || v === "" ? null : v;
}

export function intOrNull(v: string | undefined): number | null {
  const s = nullable(v);
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}
