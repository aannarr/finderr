/**
 * What a library mirror walk costs in memory, before and after bounding it.
 *
 * ```bash
 * bun src/jobs/bench-mirror.ts --items 1389,13890 --json .claude/temp/mirror.json
 * ```
 *
 * ## Why this is a third harness and not a flag on `bench-memory`
 *
 * `bench-memory.ts` measures the INDEX under a memory cap -- page cache, residency, eviction,
 * a file mapped by SQLite. Its whole instrument is `readMemoryUsage()`, which reads the
 * cgroup, and its whole subject is a thing the kernel owns. A mirror walk is the opposite
 * question in every respect: a transient V8 heap spike inside ONE process, on a machine that
 * may not be Linux at all, over a body that arrives on a socket. The two share a vocabulary
 * and nothing else, which is the same relationship `bench-memory` has to `bench-index`.
 *
 * ## Three decisions that make the numbers mean something
 *
 * **Every cell is its own PROCESS.** RSS is a high-water mark: the allocator does not hand
 * pages back, so running the unbounded shape and then the bounded one in one process would
 * show the second inheriting the first's peak and looking identical to it. The parent serves
 * the library and spawns a child per cell; each child measures itself and prints one JSON
 * line.
 *
 * **The library is served from the PARENT, never built in the child.** A synthetic body large
 * enough to be interesting is tens of megabytes, and generating it inside the process being
 * measured would swamp the thing being measured.
 *
 * **The bodies are calibrated against the live servers rather than invented.** Measured
 * 2026-09-07: Radarr answers 7,627,558 bytes for 1,389 movies (5,491 B each) and one Plex
 * section answers 2,662,805 bytes for 1,141 items (2,334 B each). The generators below pad to
 * those figures and assert they hit them, so a 10x row is a real 10x rather than a guess.
 *
 * The `whole` shape is a faithful transcription of the code this card replaced -- read the
 * body entire, `JSON.parse` it, `map` the result twice -- kept here because a "before" number
 * has to come from somewhere once the before is deleted. It writes to a real `Store` exactly
 * as the bounded shape does, so the two arms differ ONLY in how the response is read.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir, totalmem } from "node:os";
import { RadarrClient } from "../lib/arr";
import type { ArrService } from "../lib/config";
import { loadConfig } from "../lib/config";
import { PlexClient, type PlexItem, syncPlex } from "../lib/plex";
import { addedFrom, posterFrom, Store, studioFrom, syncLibrary } from "../lib/store";

/** Bytes per record on the wire, measured against the live servers on 2026-09-07. */
const MEASURED_BYTES = { arr: 5491, plex: 2334 } as const;

type Subject = keyof typeof MEASURED_BYTES;
/** `whole` = the shape this card replaced. `bounded` = what ships. */
type Shape = "whole" | "bounded";

// ---------------------------------------------------------------------------
// The synthetic library, served by the parent

/**
 * Pad `record` with an `alternateTitles` list until it serialises to `target` bytes.
 *
 * The padding goes into a field the mirror never reads, on purpose: the point of the whole
 * exercise is that an arr record is mostly fields we throw away, so the synthetic record has
 * to be mostly fields we throw away too. A record that was all mirrored fields would make the
 * unbounded shape look far better than it is.
 */
function padded(record: Record<string, unknown>, target: number): Record<string, unknown> {
  const alternateTitles: { sourceType: string; title: string }[] = [];
  for (let i = 0; JSON.stringify({ ...record, alternateTitles }).length < target; i++) {
    alternateTitles.push({ sourceType: "tmdb", title: `alternate title number ${i} `.repeat(3) });
  }
  return { ...record, alternateTitles };
}

function radarrMovie(i: number): Record<string, unknown> {
  const imdbId = `tt${String(1000000 + i).padStart(7, "0")}`;
  return padded(
    {
      id: i + 1,
      title: `Synthetic Film ${i}`,
      originalTitle: `Synthetic Film ${i}`,
      year: 1950 + (i % 76),
      tmdbId: 200000 + i,
      imdbId,
      titleSlug: String(200000 + i),
      hasFile: i % 3 !== 0,
      monitored: true,
      sizeOnDisk: 1024 * 1024 * (700 + (i % 9000)),
      added: `20${10 + (i % 16)}-04-11T09:12:33Z`,
      studio: `Studio ${i % 400}`,
      overview: "A synthetic record shaped like the ones Radarr actually returns. ".repeat(4),
      images: [{ coverType: "poster", remoteUrl: `http://image.test/${imdbId}.jpg` }],
      ratings: { imdb: { votes: i * 7, value: 6.5 }, tmdb: { votes: i * 3, value: 7.1 } },
      movieFile: { quality: { quality: { name: "Bluray-1080p" } }, size: 1024 * 1024 * 900 },
    },
    MEASURED_BYTES.arr,
  );
}

function plexMetadata(i: number): Record<string, unknown> {
  return padded(
    {
      ratingKey: String(20000 + i),
      key: `/library/metadata/${20000 + i}`,
      guid: `plex://movie/5d7768377228e5001f1d${String(i).padStart(4, "0")}`,
      type: "movie",
      title: `Synthetic Film ${i}`,
      year: 1950 + (i % 76),
      Guid: [{ id: `imdb://tt${String(1000000 + i).padStart(7, "0")}` }, { id: `tmdb://${200000 + i}` }],
      Media: [{ id: i, duration: 7_200_000, videoResolution: "1080", Part: [{ id: i, size: 9e9 }] }],
    },
    MEASURED_BYTES.plex,
  );
}

/** Plex's own paging parameters, honoured here exactly as the live server was measured to. */
function plexPage(all: unknown[], url: URL): Response {
  const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
  const size = Number(url.searchParams.get("X-Plex-Container-Size") ?? String(all.length));
  const page = all.slice(start, start + size);
  return Response.json({
    MediaContainer: { offset: start, size: page.length, totalSize: all.length, Metadata: page },
  });
}

/**
 * A stand-in Radarr and PMS on an ephemeral loopback port.
 *
 * Port 0 rather than a registered one from `~/.claude/ports.yml`: this listener exists for the
 * seconds a bench runs, binds loopback only, and never outlives the process that started it.
 */
function serveLibrary(items: number): { server: ReturnType<typeof Bun.serve>; base: string } {
  const movies = Array.from({ length: items }, (_, i) => radarrMovie(i));
  const metadata = Array.from({ length: items }, (_, i) => plexMetadata(i));

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v3/movie") return Response.json(movies);
      if (url.pathname === "/identity") {
        return Response.json({ MediaContainer: { machineIdentifier: "0".repeat(40) } });
      }
      if (url.pathname === "/library/sections") {
        return Response.json({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } });
      }
      if (url.pathname === "/library/sections/1/all") return plexPage(metadata, url);
      return new Response("not found", { status: 404 });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

// ---------------------------------------------------------------------------
// The two shapes, in a child process

/**
 * The RADARR walk as it stood before this card: body read whole, parsed whole, mapped twice.
 *
 * Transcribed rather than imported, because the code it describes is gone. Keep it faithful --
 * a "before" that is not the real before is worse than no before at all.
 */
async function wholeArrWalk(store: Store, svc: ArrService): Promise<number> {
  const res = await fetch(new URL("/api/v3/movie", svc.url), { headers: { "X-Api-Key": svc.apiKey } });
  const movies = JSON.parse(await res.text()) as Record<string, unknown>[];
  const count = store.replaceLibrary(
    "radarr",
    movies.map((m) => ({
      imdb_id: (m.imdbId as string) ?? "",
      arr_id: m.id as number,
      has_file: m.hasFile ? 1 : 0,
      monitored: m.monitored ? 1 : 0,
      progress: m.hasFile ? 1 : 0,
      added_at: addedFrom(m),
      title_slug: (m.titleSlug as string) ?? null,
    })),
  );
  store.seedArtwork(
    movies.map((m) => ({
      imdb_id: (m.imdbId as string) ?? "",
      url: posterFrom(m.images),
      studio: studioFrom(m),
    })),
  );
  return count;
}

/** The PLEX walk as it stood before this card: one unpaged request per section, parsed whole. */
async function wholePlexWalk(store: Store, base: string): Promise<number> {
  const get = async (path: string) =>
    (await (await fetch(new URL(path, base), { headers: { "X-Plex-Token": "t" } })).json()) as {
      MediaContainer?: {
        machineIdentifier?: string;
        Metadata?: { ratingKey?: string; Guid?: { id?: string }[] }[];
      };
    };
  const machineIdentifier = (await get("/identity")).MediaContainer?.machineIdentifier ?? "";
  const all = await get("/library/sections/1/all?includeGuids=1");
  const items: PlexItem[] = (all.MediaContainer?.Metadata ?? []).flatMap((m) => {
    const imdb = m.Guid?.find((g) => g.id?.startsWith("imdb://"))?.id?.slice("imdb://".length) ?? "";
    return imdb && m.ratingKey ? [{ imdb_id: imdb, rating_key: String(m.ratingKey) }] : [];
  });
  return store.replacePlexItems(machineIdentifier, items);
}

/** One measured cell: what the process held while doing one walk, and what the walk produced. */
interface CellResult {
  subject: Subject;
  shape: Shape;
  items: number;
  /** Rows in the mirror afterwards. Both shapes must agree, or the comparison is meaningless. */
  mirrored: number;
  peakRssMb: number;
  peakHeapMb: number;
  ms: number;
}

async function runCell(subject: Subject, shape: Shape, items: number, base: string): Promise<CellResult> {
  const dir = mkdtempSync(`${tmpdir()}/finderr-bench-mirror-`);
  process.env.FINDERR_DATA_DIR = dir;
  const store = new Store(loadConfig(true));
  const svc: ArrService = { url: base, apiKey: "bench", rootFolder: "/m", qualityProfileId: 4 };

  Bun.gc(true);
  const baseRss = process.memoryUsage().rss;
  const baseHeap = process.memoryUsage().heapUsed;
  let peakRss = 0;
  let peakHeap = 0;
  // Sampled on a timer rather than at fixed points in the walk: the spike this is looking for
  // is a transient, and a sample taken only where the code happens to await would miss it for
  // the same reason Seerr's ten-second monitoring interval did.
  const sampler = setInterval(() => {
    const u = process.memoryUsage();
    peakRss = Math.max(peakRss, u.rss - baseRss);
    peakHeap = Math.max(peakHeap, u.heapUsed - baseHeap);
  }, 2);

  const t0 = Bun.nanoseconds();
  let mirrored = 0;
  try {
    if (subject === "arr") {
      mirrored =
        shape === "whole"
          ? await wholeArrWalk(store, svc)
          : // batch 0 stops at the library walk: the episode mirror is a different subject with
            // its own bound, and walking it here would put a per-series request loop inside a
            // number that is supposed to be about one response.
            ((await syncLibrary(store, { radarr: new RadarrClient(svc) }, { batch: 0, staleSeconds: 0 }))
              .radarr ?? 0);
    } else {
      mirrored =
        shape === "whole"
          ? await wholePlexWalk(store, base)
          : ((await syncPlex(store, new PlexClient(base, "t"))).items ?? 0);
    }
  } finally {
    clearInterval(sampler);
    const u = process.memoryUsage();
    peakRss = Math.max(peakRss, u.rss - baseRss);
    peakHeap = Math.max(peakHeap, u.heapUsed - baseHeap);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    subject,
    shape,
    items,
    mirrored,
    peakRssMb: peakRss / 1e6,
    peakHeapMb: peakHeap / 1e6,
    ms: (Bun.nanoseconds() - t0) / 1e6,
  };
}

/**
 * Run one cell in a child and read its single JSON line back.
 *
 * > [!CAUTION] `Bun.spawnSync` DEADLOCKS here, and the symptom is a bench that just hangs
 * > The parent is also the HTTP server the child fetches from, and `spawnSync` blocks the
 * > parent's event loop -- so the child's request is never answered and both sides wait
 * > forever, with no error and no output. Async spawn keeps the parent serving while the child
 * > runs, which is the only reason the parent can be the server at all.
 */
async function runCellInChild(
  subject: Subject,
  shape: Shape,
  items: number,
  base: string,
): Promise<CellResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.path, "--cell", `${subject}:${shape}:${items}`, "--base", base],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = out.trim().split("\n").pop() ?? "";
  if (code !== 0 || !line.startsWith("{")) {
    throw new Error(`cell ${subject}:${shape}:${items} failed (exit ${code}): ${err.slice(0, 400)}`);
  }
  return JSON.parse(line) as CellResult;
}

// ---------------------------------------------------------------------------

interface Args {
  items: number[];
  runs: number;
  json: string | null;
  cell: string | null;
  base: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { items: [1389, 13890], runs: 3, json: null, cell: null, base: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--items") out.items = (argv[++i] ?? "").split(",").map(Number).filter(Boolean);
    else if (argv[i] === "--runs") out.runs = Math.max(1, Number(argv[++i]));
    else if (argv[i] === "--json") out.json = argv[++i] ?? null;
    else if (argv[i] === "--cell") out.cell = argv[++i] ?? null;
    else if (argv[i] === "--base") out.base = argv[++i] ?? "";
  }
  return out;
}

/**
 * The WORST peak across `runs` fresh processes, and the best wall time.
 *
 * A peak is what the process could not avoid holding, so across repeats the honest summary is
 * the MAXIMUM: a single lucky collection does not make the shape cheaper. Measured here, the
 * same cell varied by half again between runs (48.3 MB and 72.5 MB on two consecutive runs of
 * the bounded 13,890-item arr walk), which is a lot to read a single number through. Wall time
 * takes the minimum instead, for the ordinary reason -- the extra milliseconds in a slow run
 * are the machine's, not the code's.
 */
function worstOf(cells: CellResult[]): CellResult {
  const worst = { ...(cells[0] as CellResult) };
  for (const c of cells) {
    worst.peakRssMb = Math.max(worst.peakRssMb, c.peakRssMb);
    worst.peakHeapMb = Math.max(worst.peakHeapMb, c.peakHeapMb);
    worst.ms = Math.min(worst.ms, c.ms);
    // -1 is a loud value rather than a silent average: two runs of one cell that mirrored
    // different row counts mean the bench itself is wrong, and the table says so.
    if (c.mirrored !== worst.mirrored) worst.mirrored = -1;
  }
  return worst;
}

function report(rows: CellResult[]): void {
  console.log(
    `\n${"subject".padEnd(9)}${"items".padStart(8)}${"shape".padStart(10)}` +
      `${"peak RSS".padStart(12)}${"peak heap".padStart(12)}${"ms".padStart(9)}${"mirrored".padStart(10)}`,
  );
  console.log("-".repeat(70));
  for (const r of rows) {
    console.log(
      `${r.subject.padEnd(9)}${String(r.items).padStart(8)}${r.shape.padStart(10)}` +
        `${`${r.peakRssMb.toFixed(1)}MB`.padStart(12)}${`${r.peakHeapMb.toFixed(1)}MB`.padStart(12)}` +
        `${r.ms.toFixed(0).padStart(9)}${String(r.mirrored).padStart(10)}`,
    );
  }

  /*
    RSS IS THE HEADLINE AND `heapUsed` IS THE SUPPORTING DETAIL, which is the opposite of what
    you would expect from a heap question. `process.memoryUsage().heapUsed` under JSC reports
    heap the runtime has ALREADY RESERVED, so a walk that fits inside what boot already claimed
    reads as a delta of zero -- true, and useless as a comparison. RSS moves for the same
    allocation and is what a cgroup limit and an OOM killer both actually look at.

    So a cell whose unbounded shape stayed under `FLOOR_MB` is reported as too small to
    separate rather than as a ratio: at that size the two shapes genuinely cost the same, and
    printing "0.0x" would read as the bounded one being worse.
  */
  const FLOOR_MB = 5;
  console.log("\nbounded vs whole:");
  for (const subject of ["arr", "plex"] as Subject[]) {
    for (const items of [...new Set(rows.map((r) => r.items))]) {
      const whole = rows.find((r) => r.subject === subject && r.items === items && r.shape === "whole");
      const bounded = rows.find((r) => r.subject === subject && r.items === items && r.shape === "bounded");
      if (!whole || !bounded) continue;
      const head = `  ${subject.padEnd(6)} ${String(items).padStart(6)} items:`;
      const disagree = whole.mirrored === bounded.mirrored ? "" : "  !! the shapes disagree on the row count";
      if (whole.peakRssMb < FLOOR_MB) {
        console.log(`${head} both under ${FLOOR_MB} MB RSS -- too small to separate${disagree}`);
        continue;
      }
      console.log(
        `${head} RSS ${whole.peakRssMb.toFixed(1)} -> ${bounded.peakRssMb.toFixed(1)} MB` +
          ` (${(whole.peakRssMb / Math.max(bounded.peakRssMb, 0.1)).toFixed(1)}x)` +
          `, heap ${whole.peakHeapMb.toFixed(1)} -> ${bounded.peakHeapMb.toFixed(1)} MB` +
          `, ${whole.ms.toFixed(0)} -> ${bounded.ms.toFixed(0)} ms${disagree}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  // CHILD: one cell, measured in a process of its own, one JSON line on stdout.
  if (args.cell) {
    const [subject, shape, items] = args.cell.split(":") as [Subject, Shape, string];
    console.log(JSON.stringify(await runCell(subject, shape, Number(items), args.base)));
    return;
  }

  console.log(
    `# host: ${hostname()} ${process.platform}/${process.arch} ${navigator.hardwareConcurrency}cpu ` +
      `hostram=${Math.round(totalmem() / 1e6)}MB bun=${Bun.version}`,
  );
  console.log(
    `# date: ${new Date().toISOString()}  runs per cell: ${args.runs} (peaks are the worst of them)`,
  );
  console.log(
    `# record sizes, measured against the live servers 2026-09-07:` +
      ` radarr ${MEASURED_BYTES.arr} B/movie, plex ${MEASURED_BYTES.plex} B/item`,
  );

  const rows: CellResult[] = [];
  for (const items of args.items) {
    const { server, base } = serveLibrary(items);
    const wire = (await (await fetch(`${base}/api/v3/movie`)).text()).length;
    console.log(`# ${items} items: radarr body is ${wire} bytes (${(wire / items).toFixed(0)} B/movie)`);
    for (const subject of ["arr", "plex"] as Subject[]) {
      for (const shape of ["whole", "bounded"] as Shape[]) {
        const repeats: CellResult[] = [];
        for (let r = 0; r < args.runs; r++) repeats.push(await runCellInChild(subject, shape, items, base));
        rows.push(worstOf(repeats));
      }
    }
    server.stop(true);
  }

  report(rows);
  if (args.json) {
    await Bun.write(
      args.json,
      JSON.stringify(
        {
          stamp: {
            host: hostname(),
            platform: process.platform,
            arch: process.arch,
            cpus: navigator.hardwareConcurrency,
            hostMemMb: Math.round(totalmem() / 1e6),
            bun: Bun.version,
            at: new Date().toISOString(),
          },
          measuredBytes: MEASURED_BYTES,
          results: rows,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${args.json}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
