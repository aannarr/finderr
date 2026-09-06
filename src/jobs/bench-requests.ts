/**
 * What `GET /api/requests` costs, and which of its reads the cost belongs to.
 *
 * ```bash
 * # the ladder, both shapes, against two live servers -- HEAD and an older tree
 * bun src/jobs/bench-requests.ts --scratch /abs/scratch --before 58fe658
 *
 * # the two red proofs, each of which MUST exit non-zero
 * bun src/jobs/bench-requests.ts --scratch /abs/scratch --red auth
 * bun src/jobs/bench-requests.ts --scratch /abs/scratch --red mine
 * ```
 *
 * ## The question, and why it needed a harness rather than a test
 *
 * `RootLayout` polls this route every eight seconds for every open tab, so it is on the poll
 * loop twice over: once as the `?mine=1` list somebody is reading, and once as the badge poll
 * that carries a `quota` object no reader ever looks at. Three reads were added to it in
 * `5ae3f8e` -- the quota count, a poster lookup, and one grouped episode query -- and the
 * suite that pins their SHAPES says nothing at all about what they cost.
 *
 * ## Why it drives a real server instead of calling the handler
 *
 * The handler is not exported and there is no reason to export it: the number worth having is
 * the one a browser waits for, which includes routing, `withAuth`, `withTiming`, JSON
 * serialisation and the loopback. So this boots the app exactly as the dev script does --
 * `FINDERR_NO_AUTH=1` against a scratch data dir -- and drives it over HTTP. The BEFORE arm is
 * a second live server built from `git archive <ref>`, because arithmetic on separately-timed
 * parts is not a before/after.
 *
 * ## Every sample asserts, and the two red modes prove the assertions bite
 *
 * A harness that times a route without checking what came back is the failure this repo has
 * paid for repeatedly, and this route has two ways to hand you a fast number that means
 * nothing. Both are reproduced on purpose rather than guarded against in a comment:
 *
 * - `--red auth` boots WITHOUT the no-auth flag. `/api/requests` is not in `publicPaths()`,
 *   so the response is a fast 401 with a JSON body -- indistinguishable from a fast route to
 *   anything that only reads the clock.
 * - `--red mine` gives the seeded requests to somebody else. `?mine=1` is
 *   `listRequestsFor(me)`, so the reader a person actually watches returns zero rows and
 *   looks like the quickest thing in the run.
 *
 * `sample()` asserts `200` and an exact row count on every single response, so both modes
 * exit non-zero. Run them before believing any green number this prints.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { hostname, totalmem } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../lib/auth-store";
import { loadConfig } from "../lib/config";
import { episodeStateOf, seasonProgress, todayUtc } from "../lib/episodes";
import { SCHEMA } from "../lib/index-builder";
import { utcDayStart } from "../lib/request-quota";
import { Store } from "../lib/store";
import { NO_AUTH_USER } from "../server/auth-routes";

/** One rung of the ladder: how deep the request list is when it is measured. */
interface Depth {
  rows: number;
  /** How many of those rows are series. The rest are films, which cost the episode read nothing. */
  series: number;
  seasonsPerSeries: number;
  episodesPerSeason: number;
}

/**
 * The ladder, and the shape of a real household rather than a round number.
 *
 * Three rungs because ONE proves nothing about the others: the card's own warning is that a
 * five-row list says nothing about fifty outstanding requests. 200 is the top because
 * `listRequests(undefined, 200)` is where the badge poll caps, so it is the worst case the
 * route can actually be asked for.
 */
const LADDER: readonly Depth[] = [
  { rows: 5, series: 2, seasonsPerSeries: 4, episodesPerSeason: 10 },
  { rows: 50, series: 20, seasonsPerSeries: 6, episodesPerSeason: 12 },
  { rows: 200, series: 80, seasonsPerSeries: 6, episodesPerSeason: 12 },
];

/** Which reader is being measured. They take different branches and cost different things. */
type Shape = "mine" | "badge";

const SHAPES: readonly Shape[] = ["mine", "badge"];

interface Args {
  scratch: string;
  runs: number;
  /** The AFTER arm's port. The BEFORE arm takes the next one up. */
  port: number;
  /** Git ref to build the BEFORE arm from, or null to measure HEAD alone. */
  before: string | null;
  /** Reproduce a way this measurement can lie. Both must exit non-zero. */
  red: "auth" | "mine" | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { scratch: "", runs: 60, port: 4055, before: null, red: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scratch") out.scratch = argv[++i] ?? "";
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--before") out.before = argv[++i] ?? null;
    else if (a === "--red") out.red = (argv[++i] ?? "") as Args["red"];
  }
  if (!out.scratch.startsWith("/")) throw new Error("--scratch must be an absolute path");
  if (out.red !== null && out.red !== "auth" && out.red !== "mine") {
    throw new Error("--red takes 'auth' or 'mine'");
  }
  return out;
}

// --- the fixture -----------------------------------------------------------

/**
 * A title index with the real schema and one row, which is all this route needs.
 *
 * The server exits at boot when `titles.db` is absent and `FINDERR_INDEX_REFRESH_ON_BOOT` is
 * off, and building a real one means half a gigabyte of IMDb dumps. `/api/requests` never
 * touches the index -- it reads the app database and the arr mirrors -- so the cheapest honest
 * fixture is a valid index with nothing in it. `tfts` is created by `buildIndex` and NOT by
 * `SCHEMA`, so it is created here too or the search paths die on "no such table".
 */
function writeIndexFixture(path: string): void {
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  db.run(
    "create virtual table tfts using fts5(ntitle, norig, dtitle, content='title', content_rowid='rowid_', " +
      "tokenize='unicode61 remove_diacritics 2')",
  );
  db.query("insert or replace into meta (key, value) values ('built_at', ?)").run(new Date().toISOString());
  db.query("insert or replace into meta (key, value) values ('rows', '0')").run();
  db.close();
}

interface Seeded {
  /** The account `?mine=1` will be read as. */
  readerId: string;
  /** Every id written, in the order the route will meet them. */
  tconsts: string[];
  /** The subset Sonarr owns -- the only rows the episode read is asked about. */
  seriesIds: string[];
}

/**
 * A data directory holding one account and `depth.rows` requests it owns.
 *
 * The account is created HERE rather than left to the server, and `ensureDevUser` adopts it by
 * display name -- which is what lets the requests be owned by the reader before the first
 * request is served. Seeding them afterwards would need a second boot.
 *
 * `owner` is a parameter and not the constant because that is the whole of `--red mine`: give
 * the rows to somebody else and the `mine` shape truthfully returns nothing.
 */
function seedDataDir(dir: string, depth: Depth, owner: string): Seeded {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeIndexFixture(join(dir, "titles.db"));

  const store = new Store(loadConfig());
  const auth = new AuthStore(store.db, () => true);
  const reader = auth.createUser({ displayName: NO_AUTH_USER, role: "user" });
  const ownerId =
    owner === NO_AUTH_USER ? reader.id : auth.createUser({ displayName: owner, role: "user" }).id;

  const tconsts: string[] = [];
  const seriesIds: string[] = [];
  const seasons = Array.from({ length: depth.seasonsPerSeries }, (_, i) => i + 1);
  for (let i = 0; i < depth.rows; i++) {
    const isSeries = i < depth.series;
    const tconst = `tt${String(9_000_000 + i)}`;
    tconsts.push(tconst);
    store.createRequest({
      tconst,
      title: `Bench title ${i}`,
      year: 2020,
      kind: isSeries ? "tvSeries" : "movie",
      service: isSeries ? "sonarr" : "radarr",
      seasons: isSeries ? seasons : null,
      requestedBy: ownerId,
    });
    // Artwork for every row, because "we looked it up and have one" is the ordinary state and
    // the state the poster read is slowest in -- a missing row is a miss on the same index.
    store.setArtwork(tconst, `https://example.invalid/${tconst}.jpg`, "Bench Pictures");
    if (!isSeries) continue;
    seriesIds.push(tconst);
    store.replaceEpisodes(
      tconst,
      seasons.flatMap((season) =>
        Array.from({ length: depth.episodesPerSeason }, (_, e) => ({
          season,
          episode: e + 1,
          arr_episode_id: season * 1000 + e,
          has_file: e % 2,
          monitored: 1,
          air_date: `20${20 + (season % 5)}-01-${String((e % 28) + 1).padStart(2, "0")}`,
        })),
      ),
    );
  }
  store.close();
  return { readerId: reader.id, tconsts, seriesIds };
}

// --- the servers -----------------------------------------------------------

interface Instance {
  url: string;
  stop(): Promise<void>;
}

/**
 * The admin bearer token both servers are given, so the harness can read their own instruments.
 *
 * `/api/health` serves `timings` only to an admin, and the obvious way to be one -- making the
 * no-auth account an admin -- would change what is being measured: an admin reader sends
 * `/api/requests` down the `authStore.listUsers()` branch and gets attribution back. The system
 * API key is an admin principal that the SESSION is not, so the samples stay an ordinary
 * reader's while the instrument stays readable. A constant rather than a secret: this process
 * mints it, hands it to two children on 127.0.0.1, and kills them. It is padded to clear the
 * 24-character floor `validate()` puts on any admin key, which the server refuses to boot under.
 */
const BENCH_ADMIN_KEY = "bench-admin-key-for-localhost-only";

/**
 * What the SERVER thinks it spent, out of its own `Timings`, cumulatively.
 *
 * `withTiming` wraps the whole route table and keys on the route PATTERN, so `?mine=1` and the
 * badge poll land in one bucket -- which is why this returns the running totals and the caller
 * diffs them around each shape rather than reading a per-shape number that does not exist.
 *
 * It exists because the client's wall clock includes reading the body, and the body is 31%
 * bigger after the change. Without this the harness could not tell "the handler got slower"
 * from "there is more to download", and those want different answers.
 */
async function handlerTotals(url: string): Promise<{ n: number; totalMs: number }> {
  const res = await fetch(`${url}/api/health`, { headers: { Authorization: `Bearer ${BENCH_ADMIN_KEY}` } });
  const body = (await res.json()) as {
    timings?: { requests?: Record<string, { n: number; totalMs: number }> };
  };
  const entry = body.timings?.requests?.["GET /api/requests"];
  if (!entry) throw new Error(`${url}/api/health served no timings -- the admin key was not accepted`);
  return { n: entry.n, totalMs: entry.totalMs };
}

/**
 * A tree at `ref`, extracted with `git archive` and lent this checkout's dependencies.
 *
 * `git archive` rather than `git worktree add`, deliberately: a worktree is git state in the
 * shared checkout that somebody then has to remove, and this needs nothing but the bytes. The
 * two symlinks are what make the extracted tree runnable without a second `bun install` --
 * both are read-only to the child.
 */
async function materialiseTree(ref: string, dest: string, here: string): Promise<string> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const archive = Bun.spawn(["git", "archive", ref], { cwd: here, stdout: "pipe", stderr: "pipe" });
  const untar = Bun.spawn(["tar", "-x", "-C", dest], { stdin: archive.stdout, stderr: "pipe" });
  if ((await untar.exited) !== 0 || (await archive.exited) !== 0) {
    throw new Error(`could not extract ${ref}: ${await new Response(archive.stderr).text()}`);
  }
  // `vendor/` is tracked and arrives in the archive; `node_modules` never is. Lending only
  // what the extract did not bring keeps this true whichever way that goes in future.
  for (const shared of ["node_modules", "vendor"]) {
    if (existsSync(join(here, shared)) && !existsSync(join(dest, shared))) {
      symlinkSync(join(here, shared), join(dest, shared));
    }
  }
  return dest;
}

/**
 * Boot one finderr and wait until it answers.
 *
 * `/api/health` is the readiness probe because it is the one route that answers an
 * unauthenticated caller, which is exactly what the `--red auth` arm is.
 *
 * > [!IMPORTANT] SIGTERM and then WAIT, never a hard kill
 * > A SIGKILL mid-WAL-checkpoint overwrote page 1 of the real `finderr.db` twice. The database
 * > here is scratch and could be thrown away, but the shutdown path is not worth having two
 * > spellings of, and a bench that teaches the wrong one is worse than no bench.
 */
async function boot(tree: string, dataDir: string, port: number, noAuth: boolean): Promise<Instance> {
  const child = Bun.spawn(["bun", join(tree, "src/server/index.ts")], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FINDERR_DATA_DIR: dataDir,
      FINDERR_PORT: String(port),
      FINDERR_HOST: "127.0.0.1",
      FINDERR_NO_AUTH: noAuth ? "1" : "",
      FINDERR_ADMIN_API_KEY: BENCH_ADMIN_KEY,
      // Nothing upstream, so no reconcile pass can add network time to a sample.
      FINDERR_RADARR_URL: "",
      FINDERR_SONARR_URL: "",
      FINDERR_PROWLARR_URL: "",
      FINDERR_PLEX_URL: "",
    },
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `server at ${tree} exited ${child.exitCode}: ${await new Response(child.stderr).text()}`,
      );
    }
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        return {
          url,
          stop: async () => {
            child.kill("SIGTERM");
            await child.exited;
          },
        };
      }
    } catch {
      // Not listening yet. The deadline above is the only thing that gives up.
    }
    await Bun.sleep(150);
  }
  child.kill("SIGTERM");
  throw new Error(`server at ${tree} never became ready on ${port}`);
}

// --- the samplers ----------------------------------------------------------

/**
 * Drive one shape `runs` times and return the wall clock a browser would have waited.
 *
 * IT ASSERTS ON EVERY SAMPLE, and that is the entire reason to trust anything below. A 401 is
 * sub-millisecond and an empty list is faster still; either would be reported as a fast route
 * by a harness that only reads the clock. See `--red auth` and `--red mine`, which exist to
 * make both of those failures happen on demand.
 */
async function sample(url: string, shape: Shape, runs: number, expectRows: number): Promise<Samples> {
  const target = `${url}/api/requests${shape === "mine" ? "?mine=1" : ""}`;
  const ms: number[] = [];
  let body = "";
  for (let i = 0; i < runs; i++) {
    const t = Bun.nanoseconds();
    const res = await fetch(target);
    const text = await res.text();
    ms.push((Bun.nanoseconds() - t) / 1e6);
    body = text;
    if (res.status !== 200)
      throw new Error(`${target} answered ${res.status}, not 200 -- measuring a refusal`);
    const got = (JSON.parse(text) as { requests?: unknown[] }).requests?.length ?? -1;
    if (got !== expectRows) {
      throw new Error(`${target} returned ${got} rows, expected ${expectRows} -- measuring the wrong list`);
    }
  }
  return { ms, body };
}

/**
 * What the CLIENT saw: one wall clock per call, and the answer it was given.
 *
 * The body is kept because the added READS do not account for the whole before/after delta, and
 * the rest has to be named rather than shrugged at: this route now sends per-season progress
 * and a poster path for every row, so it both computes more and serialises more. Keeping the
 * bytes is what lets `serialisationCost` measure that half instead of asserting it.
 */
interface Samples {
  ms: number[];
  /** The last response body. Deterministic for a fixed seed, so one is enough. */
  body: string;
}

/** The client's view plus the server's own, which is the pair that separates the two costs. */
interface Sampled extends Samples {
  /** Mean handler time over the same calls, out of the server's `Timings`. */
  handlerMs: number;
}

/**
 * What it costs to turn this response into JSON, before and after.
 *
 * The route builds an object and Bun writes it out; the part of the delta that is neither a
 * query nor `seasonProgress` is that object being 31% bigger. Re-serialising the two real
 * bodies is a direct measurement of exactly that, rather than an estimate from their sizes --
 * and it is done here, in the harness, because asking the server to time its own serialisation
 * would mean instrumenting a render path to answer a question about one commit.
 */
function serialisationCost(sampled: Sampled, runs: number): number {
  const parsed = JSON.parse(sampled.body) as unknown;
  const t = Bun.nanoseconds();
  for (let i = 0; i < runs; i++) JSON.stringify(parsed);
  return (Bun.nanoseconds() - t) / 1e6 / runs;
}

/**
 * What each of the added reads costs on its own, asked exactly as the route asks it.
 *
 * A total says the route is fast; it cannot say which read to remove if it ever stops being.
 * These run against the same database file on a separate connection, so the numbers are
 * comparable to each other rather than to the HTTP figures -- which carry routing, auth and
 * serialisation that none of these do.
 *
 * THE FOURTH ROW IS NOT A READ, and it is here because the three that are do not add up to the
 * measured delta. `seasonProgress` walks every mirrored episode of every series on the page --
 * one grouped query brings back thousands of rows and each one is classified against today --
 * so the CPU it spends is a real part of what `5ae3f8e` added and the honest place for it is
 * beside the queries rather than in a sentence explaining a gap.
 */
function attributeReads(seeded: Seeded, runs: number): Record<string, number> {
  const store = new Store(loadConfig());
  const quotaSince = utcDayStart();
  const today = todayUtc();
  const measure = (fn: () => unknown): number => {
    const t = Bun.nanoseconds();
    for (let i = 0; i < runs; i++) fn();
    return (Bun.nanoseconds() - t) / 1e6 / runs;
  };
  const episodes = [...store.episodesForSeries(seeded.seriesIds).values()];
  const out = {
    "quota count(*) x1": measure(() => store.countRequestsSince(seeded.readerId, quotaSince)),
    [`getArtwork x${seeded.tconsts.length}`]: measure(() => {
      for (const tconst of seeded.tconsts) store.getArtwork(tconst);
    }),
    [`episodesForSeries x1 (${seeded.seriesIds.length} series)`]: measure(() =>
      store.episodesForSeries(seeded.seriesIds),
    ),
    [`map+seasonProgress x${seeded.seriesIds.length}`]: measure(() => {
      // The route's own two steps for a series row, in its order: every mirrored episode is
      // turned into the wire shape `../lib/episodes.ts` reads, and then classified. Timing the
      // classification alone would leave the allocation out, and the allocation is the larger
      // half at this depth.
      for (const rows of episodes) seasonProgress(rows.map(episodeStateOf), today);
    }),
  };
  store.close();
  return out;
}

// --- reporting -------------------------------------------------------------

interface Row {
  depth: Depth;
  shape: Shape;
  after: Sampled;
  before: Sampled | null;
}

/** One rung's whole answer: what the route took, and where the difference went. */
interface Rung {
  rows: Row[];
  /** Every named part of the delta, in milliseconds per response. */
  parts: Record<string, number>;
}

function quantile(times: readonly number[], q: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

function report(rows: readonly Row[], attribution: ReadonlyMap<number, Record<string, number>>): void {
  const kb = (s: Sampled): string => `${(s.body.length / 1024).toFixed(0)}K`;
  const or = (v: number | null, digits = 2): string => (v === null ? "-" : v.toFixed(digits));
  console.log("\nclient p50 is what a browser waits for; handler is what the server spent inside it.\n");
  console.log(
    `${"rows".padStart(6)}${"shape".padStart(8)}${"before p50".padStart(12)}${"after p50".padStart(11)}` +
      `${"delta".padStart(8)}${"after p95".padStart(11)}${"before hdlr".padStart(13)}${"after hdlr".padStart(12)}` +
      `${"before kB".padStart(11)}${"after kB".padStart(10)}`,
  );
  console.log("-".repeat(92));
  for (const r of rows) {
    const after = quantile(r.after.ms, 0.5);
    const before = r.before === null ? null : quantile(r.before.ms, 0.5);
    console.log(
      `${String(r.depth.rows).padStart(6)}${r.shape.padStart(8)}` +
        `${or(before).padStart(12)}${after.toFixed(2).padStart(11)}` +
        `${or(before === null ? null : after - before).padStart(8)}` +
        `${quantile(r.after.ms, 0.95).toFixed(2).padStart(11)}` +
        `${or(r.before?.handlerMs ?? null, 3).padStart(13)}${r.after.handlerMs.toFixed(3).padStart(12)}` +
        `${(r.before === null ? "-" : kb(r.before)).padStart(11)}${kb(r.after).padStart(10)}`,
    );
  }

  console.log("\nwhere the handler delta went, each part measured on its own, per response (ms):");
  for (const [rowCount, parts] of attribution) {
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    console.log(`  ${rowCount} rows`);
    for (const [name, ms] of Object.entries(parts)) console.log(`    ${name.padEnd(36)}${ms.toFixed(3)}`);
    console.log(`    ${"= accounted for".padEnd(36)}${total.toFixed(3)}`);
    /*
      THE REMAINDER IS PRINTED, NEVER SWALLOWED.

      Each part above is timed in a tight loop that does nothing else, while the handler does
      them interleaved with building 200 response rows and thousands of episode objects -- so
      the same statements cost more in place than in isolation. That is a real effect and the
      honest thing to do with it is show it: a reader who adds the column up and finds it short
      of the measured delta should find the difference already named here rather than conclude
      the attribution is wrong.
    */
    const badge = rows.find((r) => r.depth.rows === rowCount && r.shape === "badge");
    if (!badge?.before) continue;
    const measured = badge.after.handlerMs - badge.before.handlerMs;
    console.log(`    ${"measured handler delta (badge)".padEnd(36)}${measured.toFixed(3)}`);
    console.log(`    ${"unattributed remainder".padEnd(36)}${(measured - total).toFixed(3)}`);
  }
}

// --- the run ---------------------------------------------------------------

/**
 * One rung: seed, boot whatever arms were asked for, sample both shapes, tear down.
 *
 * The servers are booted per rung rather than once, because the seed is what defines the rung
 * and the app database is what the seed writes. Booting once and re-seeding underneath a
 * running server would leave two writers on one SQLite file, which is how the real database
 * has been corrupted before.
 */
async function runRung(args: Args, depth: Depth, here: string, beforeTree: string | null): Promise<Rung> {
  const dataDir = join(args.scratch, "data");
  const owner = args.red === "mine" ? "somebody_else" : NO_AUTH_USER;
  const seeded = seedDataDir(dataDir, depth, owner);

  const after = await boot(here, dataDir, args.port, args.red !== "auth");
  const before = beforeTree === null ? null : await boot(beforeTree, dataDir, args.port + 1, true);
  try {
    const rows: Row[] = [];
    for (const shape of SHAPES) {
      // The `mine` list is one person's; the badge poll is the whole log, capped at 200.
      const expect = shape === "mine" ? seeded.tconsts.length : Math.min(depth.rows, 200);
      rows.push({
        depth,
        shape,
        after: await timed(after.url, shape, args.runs, expect),
        before: before === null ? null : await timed(before.url, shape, args.runs, expect),
      });
    }
    // The badge poll is the arm the serialisation figure is taken from: it is the shape both
    // trees answer identically apart from the added fields, so the difference between the two
    // bodies is the added fields and nothing else.
    const badge = rows.find((r) => r.shape === "badge");
    const parts = attributeReads(seeded, args.runs);
    if (badge?.before) {
      parts["JSON.stringify the extra fields"] =
        serialisationCost(badge.after, args.runs) - serialisationCost(badge.before, args.runs);
    }
    return { rows, parts };
  } finally {
    await after.stop();
    if (before) await before.stop();
  }
}

/**
 * `sample`, with a discarded warm-up in front of it.
 *
 * The first calls through a route pay for statement preparation and for the JIT, and reporting
 * that as the p50 of a loop that runs every eight seconds for hours would overstate the steady
 * state this card is actually about. The warm-up asserts exactly as the measured run does, so
 * it is also where a red proof fails -- one round trip in rather than sixty.
 */
async function timed(url: string, shape: Shape, runs: number, expectRows: number): Promise<Sampled> {
  await sample(url, shape, 5, expectRows);
  const opened = await handlerTotals(url);
  const samples = await sample(url, shape, runs, expectRows);
  const closed = await handlerTotals(url);
  // The MEAN and not a percentile: `Timings` rounds each reported figure to whole
  // milliseconds, which is uselessly coarse at this scale, but its running total is summed
  // before rounding -- so over a few hundred calls the mean has real resolution.
  return { ...samples, handlerMs: (closed.totalMs - opened.totalMs) / Math.max(1, closed.n - opened.n) };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const here = join(import.meta.dir, "../..");
  mkdirSync(args.scratch, { recursive: true });
  // Every child reads its data dir from the env, but `loadConfig()` in THIS process is what
  // `seedDataDir` and `attributeReads` open, so it is set once here for both.
  process.env.FINDERR_DATA_DIR = join(args.scratch, "data");

  console.log(
    `# host: ${hostname()} ${process.platform}/${process.arch} ${navigator.hardwareConcurrency}cpu ` +
      `ram=${Math.round(totalmem() / 1e9)}GB bun=${Bun.version}`,
  );
  console.log(`# date: ${new Date().toISOString()}  runs=${args.runs}  head=${here}`);
  if (args.red) console.log(`# RED PROOF (${args.red}): this run MUST exit non-zero`);

  const beforeTree = args.before
    ? await materialiseTree(args.before, join(args.scratch, "before"), here)
    : null;
  if (beforeTree) console.log(`# before: ${args.before} extracted to ${beforeTree}`);

  const rows: Row[] = [];
  const attribution = new Map<number, Record<string, number>>();
  // A red proof only needs one rung to fail on, and failing fast keeps its output readable.
  const ladder = args.red ? LADDER.slice(1, 2) : LADDER;
  for (const depth of ladder) {
    const rung = await runRung(args, depth, here, beforeTree);
    rows.push(...rung.rows);
    attribution.set(depth.rows, rung.parts);
  }
  report(rows, attribution);
  console.log(`\nscratch left at ${args.scratch} -- it is inside the worktree and goes with it`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
