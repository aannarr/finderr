/**
 * What a PERSONAL front page costs, and what it costs everybody who never arranged one.
 *
 * ```bash
 * # both shapes of the page, against two live servers -- HEAD and the commit before this work
 * bun src/jobs/bench-discover.ts --scratch /abs/scratch --before main
 *
 * # and the held page too, which needs a TMDB key in the environment
 * FINDERR_TMDB_API_KEY=... bun src/jobs/bench-discover.ts --scratch /abs/scratch --held
 *
 * # the two red proofs, each of which MUST exit non-zero
 * bun src/jobs/bench-discover.ts --scratch /abs/scratch --red anon
 * bun src/jobs/bench-discover.ts --scratch /abs/scratch --red unapplied
 * ```
 *
 * ## The question
 *
 * `/api/discover` is the first paint. Personalisation adds one indexed read of `shelf_pref`
 * and a reorder of an array already in memory -- which is a claim about a render path, and
 * this repo's rule is that a claim about a render path is measured on named hardware or it is
 * not made. Two things need proving and they are different:
 *
 *  1. A reader with NO preference must not pay for the feature. Measured against a live server
 *     built from the commit before it existed, and the two bodies are compared as STRINGS --
 *     "byte for byte" is an assertion here rather than a turn of phrase.
 *  2. A reader WITH one pays at most that one read. Measured as a third arm.
 *
 * The default arm computes the page per request. `--held` adds the second shipped shape, the
 * page HELD in memory (`FINDERR_KEEP_SHELVES_FRESH=1`), and it is opt-in for a reason worth
 * knowing: the held page is not `ready` until all three tiers have been primed, and the TMDB
 * tier is primed by `refreshTmdbLists`, which returns immediately when there is no TMDB key.
 * So a keyless finderr with the flag on serves a COMPUTED page for ever, and a bench that did
 * not check would have printed a `held` row measuring exactly the same thing as the computed
 * one. `waitForHeldPage` refuses to let that happen; `--held` needs `FINDERR_TMDB_API_KEY` in
 * the environment, which `boot` passes through.
 *
 * Either baseline answers both questions, because what the feature ADDS -- one primary-key read
 * and one pass over a dozen shelf objects -- is the same in both shapes. Only the page it is
 * added to differs.
 *
 * ## It runs against the REAL index
 *
 * A synthetic index would make the shelf queries cheap and the reorder look expensive by
 * comparison, which is precisely the wrong answer. The real file is found the way the canary
 * finds it (`findIndex`, which reaches out of a worktree into the checkout it was cut from)
 * and CLONED into the scratch dir -- `cp -c` on APFS, so it costs no disk and no time and the
 * running production container never shares an inode with a bench.
 *
 * ## Every sample asserts, and two red modes prove the assertions bite
 *
 * Timing a route without checking what came back is the failure this repo has paid for
 * repeatedly, and this route has two ways to hand back a fast number that means nothing:
 *
 * - `--red anon` boots WITHOUT the no-auth flag. `/api/discover` is not in `publicPaths()`, so
 *   the answer is a fast 401 with a JSON body -- indistinguishable from a fast page to
 *   anything that only reads the clock.
 * - `--red unapplied` measures the arranged arm WITHOUT saving the arrangement first. The
 *   server then serves the default page, which is the exact failure "personalisation silently
 *   does nothing" would produce, and it is faster than doing the work.
 *
 * Every response is checked for its shelf count, its first shelf and the absence of the hidden
 * ones, so both modes exit non-zero.
 */

import { mkdirSync, rmSync } from "node:fs";
import { hostname, totalmem } from "node:os";
import { join } from "node:path";
import { loadConfig, paths } from "../lib/config";
import {
  BENCH_ADMIN_KEY,
  boot,
  handlerTotals,
  type Instance,
  materialiseTree,
  quantile,
} from "./bench-server";
import { findIndex } from "./canary";

/** The `Timings` bucket the front page lands in -- `withTiming` keys on the route pattern. */
const ROUTE = "GET /api/discover";

const PREFERENCE_PATH = "/api/shelves/preference";

/** Whether the page is held in memory or computed per request. Both are shipped shapes. */
type Shape = "held" | "computed";

/** Measured in this order, so the cheap arm fails fast when something is wrong. */
const shapesFor = (args: Args): Shape[] => (args.held ? ["computed", "held"] : ["computed"]);

/** Which reader is being measured. */
type Arm = "none" | "arranged";

interface Args {
  scratch: string;
  runs: number;
  /** The AFTER arm's port. The BEFORE arm takes the next one up. */
  port: number;
  /** Git ref to build the BEFORE arm from, or null to measure HEAD alone. */
  before: string | null;
  /** Also measure the held page. Needs `FINDERR_TMDB_API_KEY` -- see the docstring. */
  held: boolean;
  /** Reproduce a way this measurement can lie. Both must exit non-zero. */
  red: "anon" | "unapplied" | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { scratch: "", runs: 60, port: 4065, before: null, held: false, red: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scratch") out.scratch = argv[++i] ?? "";
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--before") out.before = argv[++i] ?? null;
    else if (a === "--held") out.held = true;
    else if (a === "--red") out.red = (argv[++i] ?? "") as Args["red"];
  }
  if (!out.scratch.startsWith("/")) throw new Error("--scratch must be an absolute path");
  if (out.red !== null && out.red !== "anon" && out.red !== "unapplied") {
    throw new Error("--red takes 'anon' or 'unapplied'");
  }
  if (out.held && !process.env.FINDERR_TMDB_API_KEY) {
    throw new Error("--held needs FINDERR_TMDB_API_KEY -- without it the tmdb tier is never primed");
  }
  return out;
}

// --- the fixture -----------------------------------------------------------

/**
 * The real index this run measures against, resolved ONCE before anything is created.
 *
 * > [!CAUTION] Resolve it before the scratch dir exists, never after
 * > `findIndex` tries the CONFIGURED path first, and the configured path is whatever
 * > `FINDERR_DATA_DIR` says. Point that at the scratch dir and the second run of this bench
 * > resolves the index to the copy the FIRST run left there -- which `seedDataDir` then
 * > deletes, one line before copying from it. That is not a hypothetical: it is what this
 * > function was doing until it took the path as an argument.
 */
function resolveIndex(): string {
  const index = findIndex(paths(loadConfig()).db);
  if (!Bun.file(index).size) {
    throw new Error(`no index at ${index} -- this bench measures the real shelf queries`);
  }
  return index;
}

/**
 * A scratch data dir holding a clone of the real index and nothing else.
 *
 * `cp -c` asks APFS for a copy-on-write clone: instant, zero disk, and -- the part that
 * matters -- a SEPARATE INODE. A hardlink or a symlink would put this bench's WAL on the same
 * file a running finderr is serving from. It falls back to a plain copy where the filesystem
 * cannot clone, which costs 1.9 GB and works.
 *
 * `cp` and not `node:fs`'s `cpSync`: under bun 1.4.0 that throws `ENOENT ... lstat <dest>` on a
 * destination that does not exist yet, which is the only kind this function ever has.
 *
 * The app database is deliberately NOT carried over: every run starts with nobody having
 * arranged anything, which is the state the first arm is about.
 */
function seedDataDir(dir: string, index: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "titles.db");
  const cloned = Bun.spawnSync(["cp", "-c", index, dest]);
  if (cloned.exitCode !== 0) {
    const copied = Bun.spawnSync(["cp", index, dest]);
    if (copied.exitCode !== 0) {
      throw new Error(`could not copy ${index} to ${dest}: ${copied.stderr.toString()}`);
    }
  }
}

/** Where this run's data lives, and the real index it was seeded from. */
interface Fixture {
  dataDir: string;
  index: string;
}

// --- the arrangement -------------------------------------------------------

/** One shelf as `/api/discover` sends it, cut down to what this bench asserts on. */
interface ShelfHead {
  id: string;
  title: string;
}

interface Arrangement {
  /** What is PUT to the preference route. */
  body: { shelves: { id: string; hidden: boolean }[] };
  /** The shelf that must come back first once it is applied. */
  first: string;
  /** The shelves that must not come back at all. */
  hidden: string[];
  /** How many shelves the page then has. */
  shelves: number;
}

/**
 * Reverse the shipped page and hide the two rows that were at its head.
 *
 * REVERSED rather than "move one shelf up", because a one-place swap is satisfied by a server
 * that applies the preference to only the first few rows -- and hiding the two the reader
 * would otherwise see FIRST is what makes a page that ignored the arrangement fail on its very
 * first shelf rather than somewhere a reader might not scroll to.
 */
function arrange(page: readonly ShelfHead[]): Arrangement {
  // Fewer than three and "reversed, with the first two hidden" stops distinguishing anything.
  // An index that serves a page this short is not one worth taking a number from.
  if (page.length < 3) throw new Error(`the index served only ${page.length} shelves -- too few to arrange`);
  const reversed = [...page].reverse().map((s) => s.id);
  const hidden = reversed.slice(-2);
  return {
    body: { shelves: reversed.map((id) => ({ id, hidden: hidden.includes(id) })) },
    first: reversed[0] ?? "",
    hidden,
    shelves: reversed.length - hidden.length,
  };
}

// --- the samplers ----------------------------------------------------------

/**
 * Wait until the HELD page has actually been built, or refuse to call the arm "held".
 *
 * The three tiers are primed by three different timers -- the arr mirror at boot, TMDB eight
 * seconds in, the index on adoption -- and `currentShelves()` falls back to COMPUTING the page
 * until all three have answered. Sample before that and the row says `held` while the server
 * was doing exactly what the `computed` row does, which is a bench quietly measuring one thing
 * and labelling it another.
 */
async function waitForHeldPage(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${url}/api/health`, {
      headers: { Authorization: `Bearer ${BENCH_ADMIN_KEY}` },
    });
    const body = (await res.json()) as { shelves?: { enabled?: boolean; ready?: boolean } };
    if (body.shelves?.enabled !== true) {
      throw new Error(`${url} reports the held page OFF -- FINDERR_KEEP_SHELVES_FRESH did not take`);
    }
    if (body.shelves.ready === true) return;
    await Bun.sleep(500);
  }
  throw new Error(`${url} never finished building the held page -- the 'held' arm would be a lie`);
}

/** What one response must look like, so a fast wrong answer cannot be reported as a fast one. */
interface Expected {
  shelves: number;
  first: string;
  absent: readonly string[];
}

async function discover(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${url}/api/discover`);
  return { status: res.status, body: await res.text() };
}

function shelvesOf(body: string): ShelfHead[] {
  return (JSON.parse(body) as { shelves?: ShelfHead[] }).shelves ?? [];
}

function check(target: string, res: { status: number; body: string }, want: Expected): ShelfHead[] {
  if (res.status !== 200) throw new Error(`${target} answered ${res.status}, not 200 -- timing a refusal`);
  const shelves = shelvesOf(res.body);
  if (shelves.length !== want.shelves) {
    throw new Error(`${target} sent ${shelves.length} shelves, expected ${want.shelves}`);
  }
  if (shelves[0]?.id !== want.first) {
    throw new Error(
      `${target} led with ${shelves[0]?.id}, expected ${want.first} -- the order was not applied`,
    );
  }
  for (const id of want.absent) {
    if (shelves.some((s) => s.id === id)) throw new Error(`${target} still carries ${id}, which is hidden`);
  }
  return shelves;
}

/** What the client saw over `runs` calls, and the answer it was given. */
interface Samples {
  ms: number[];
  /** The last response body. Deterministic for a fixed data dir, so one is enough. */
  body: string;
  /** Mean handler time over the same calls, out of the server's own `Timings`. */
  handlerMs: number;
}

/**
 * Drive `/api/discover` `runs` times, asserting on every single response.
 *
 * A discarded warm-up runs first: the first calls through a route pay for statement
 * preparation, for the JIT and -- against a 1.9 GB index -- for the pages the query touches
 * arriving in cache. Reporting that as the steady state would overstate a page most readers
 * hit warm. The warm-up asserts exactly as the measured run does, so a red proof fails one
 * round trip in rather than sixty.
 */
async function sample(url: string, want: Expected, runs: number): Promise<Samples> {
  const target = `${url}/api/discover`;
  for (let i = 0; i < 5; i++) check(target, await discover(url), want);

  const opened = await handlerTotals(url, ROUTE);
  const ms: number[] = [];
  let body = "";
  for (let i = 0; i < runs; i++) {
    const t = Bun.nanoseconds();
    const res = await discover(url);
    ms.push((Bun.nanoseconds() - t) / 1e6);
    check(target, res, want);
    body = res.body;
  }
  const closed = await handlerTotals(url, ROUTE);
  // The MEAN and not a percentile: `Timings` rounds each REPORTED figure to whole
  // milliseconds, but sums before rounding -- so over a few hundred calls the mean has real
  // resolution where a per-call percentile would have none.
  return { ms, body, handlerMs: (closed.totalMs - opened.totalMs) / Math.max(1, closed.n - opened.n) };
}

// --- the acceptance --------------------------------------------------------

async function putPreference(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}${PREFERENCE_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

interface PreferencePayload {
  customised: boolean;
  shelves: { id: string; title: string; hidden: boolean }[];
}

async function getPreference(url: string): Promise<PreferencePayload> {
  const res = await fetch(`${url}${PREFERENCE_PATH}`);
  if (res.status !== 200) throw new Error(`${PREFERENCE_PATH} answered ${res.status}`);
  return (await res.json()) as PreferencePayload;
}

function assert(condition: boolean, what: string): void {
  if (!condition) throw new Error(`ACCEPTANCE FAILED: ${what}`);
}

/**
 * The card's own acceptance, driven over HTTP against a live server before anything is timed.
 *
 * A number is worth nothing if the feature does not work, and every claim here is one a test
 * over a pure function cannot make: that it survives a RESTART, that the three verbs agree
 * with each other, and that a reader who resets gets the same bytes back as one who never
 * arranged anything.
 */
async function acceptance(
  make: () => Promise<Instance>,
  arrangement: Arrangement,
  defaultPage: string,
): Promise<void> {
  let server = await make();
  try {
    const fresh = await getPreference(server.url);
    assert(!fresh.customised, "a reader who never arranged anything is not customised");
    assert(
      fresh.shelves.every((s) => !s.hidden),
      "and nothing is hidden from them",
    );

    const saved = await putPreference(server.url, arrangement.body);
    assert(saved.status === 200, `PUT answered ${saved.status}`);
    const stored = saved.json as PreferencePayload;
    assert(stored.customised, "a reader who arranged the page is customised");
    assert(
      stored.shelves.map((s) => s.id).join() === arrangement.body.shelves.map((s) => s.id).join(),
      "the catalogue comes back in the order it was sent",
    );
    assert(
      stored.shelves.filter((s) => s.hidden).length === arrangement.hidden.length,
      "hidden shelves are still ON the catalogue, marked -- otherwise hiding is a one-way door",
    );

    check(`${server.url}/api/discover`, await discover(server.url), {
      shelves: arrangement.shelves,
      first: arrangement.first,
      absent: arrangement.hidden,
    });

    // THE RESTART. A preference held in the process would pass every check above.
    await server.stop();
    server = await make();
    const afterRestart = await getPreference(server.url);
    assert(
      afterRestart.shelves.map((s) => s.id).join() === stored.shelves.map((s) => s.id).join(),
      "the arrangement survives a server restart",
    );

    // A stored id no shelf carries any more is the nightly state, not an error.
    const withGhost = await putPreference(server.url, {
      shelves: [{ id: "genre-a-shelf-that-does-not-exist" }, ...arrangement.body.shelves],
    });
    assert(withGhost.status === 200, "an id no shelf carries is accepted rather than refused");
    assert(
      !(withGhost.json as PreferencePayload).shelves.some((s) => s.id.includes("does-not-exist")),
      "and it is dropped from the answer rather than drawn as a hole",
    );

    const reset = await fetch(`${server.url}${PREFERENCE_PATH}`, { method: "DELETE" });
    assert(reset.status === 200, `DELETE answered ${reset.status}`);
    assert(!((await reset.json()) as PreferencePayload).customised, "reset puts the page back");
    assert(
      (await discover(server.url)).body === defaultPage,
      "and the page after a reset is the shipped page BYTE FOR BYTE",
    );
  } finally {
    await server.stop();
  }
}

// --- reporting -------------------------------------------------------------

interface Row {
  shape: Shape;
  arm: Arm;
  tree: "before" | "after";
  samples: Samples;
}

function report(rows: readonly Row[]): void {
  console.log("\nclient p50 is what a browser waits for; handler is what the server spent inside it.\n");
  console.log(
    `${"shape".padStart(10)}${"tree".padStart(8)}${"reader".padStart(11)}${"p50".padStart(9)}` +
      `${"p95".padStart(9)}${"handler".padStart(10)}${"kB".padStart(8)}`,
  );
  console.log("-".repeat(65));
  for (const r of rows) {
    console.log(
      `${r.shape.padStart(10)}${r.tree.padStart(8)}${r.arm.padStart(11)}` +
        `${quantile(r.samples.ms, 0.5).toFixed(2).padStart(9)}` +
        `${quantile(r.samples.ms, 0.95).toFixed(2).padStart(9)}` +
        `${r.samples.handlerMs.toFixed(3).padStart(10)}` +
        `${(r.samples.body.length / 1024).toFixed(0).padStart(8)}`,
    );
  }

  console.log("\nwhat the feature costs, per response (ms):");
  for (const shape of new Set(rows.map((r) => r.shape))) {
    const find = (tree: Row["tree"], arm: Arm) =>
      rows.find((r) => r.shape === shape && r.tree === tree && r.arm === arm);
    const before = find("before", "none");
    const none = find("after", "none");
    const arranged = find("after", "arranged");
    if (!none || !arranged) continue;
    const p50 = (r: Row) => quantile(r.samples.ms, 0.5);
    console.log(`  ${shape}`);
    if (before) {
      console.log(
        `    ${"a reader with NO preference".padEnd(34)}${(p50(none) - p50(before)).toFixed(3)}` +
          `   (handler ${(none.samples.handlerMs - before.samples.handlerMs).toFixed(3)})`,
      );
    }
    console.log(
      `    ${"a reader WITH one".padEnd(34)}${(p50(arranged) - p50(none)).toFixed(3)}` +
        `   (handler ${(arranged.samples.handlerMs - none.samples.handlerMs).toFixed(3)})`,
    );
  }
}

// --- the run ---------------------------------------------------------------

/** How to boot one tree, for one shape of the page, on one port. */
function bootFor(
  args: Args,
  tree: string,
  dataDir: string,
  shape: Shape,
  port: number,
): () => Promise<Instance> {
  return () =>
    boot({
      tree,
      dataDir,
      port,
      env: {
        // `--red anon` is exactly this flag being off: the route answers a fast 401 instead.
        FINDERR_NO_AUTH: args.red === "anon" ? "" : "1",
        FINDERR_KEEP_SHELVES_FRESH: shape === "held" ? "1" : "",
      },
    });
}

/**
 * The timed arms for one shape of the page, against a data dir nobody has arranged yet.
 *
 * Every expectation is derived from what the server ACTUALLY serves rather than from a list
 * written here, so a shelf that came back empty and dropped out cannot fail the run spuriously
 * -- while a page that ignored the arrangement still fails on its very first shelf.
 */
async function measureShape(
  args: Args,
  here: string,
  beforeTree: string | null,
  fixture: Fixture,
  shape: Shape,
): Promise<Row[]> {
  const { dataDir } = fixture;
  seedDataDir(dataDir, fixture.index);
  const rows: Row[] = [];
  const after = await bootFor(args, here, dataDir, shape, args.port)();
  try {
    if (shape === "held") await waitForHeldPage(after.url);
    const shipped = await discover(after.url);
    if (shipped.status !== 200) {
      throw new Error(`/api/discover answered ${shipped.status}, not 200 -- measuring a refusal`);
    }
    const page = shelvesOf(shipped.body);
    const noPreference: Expected = { shelves: page.length, first: page[0]?.id ?? "", absent: [] };

    rows.push({
      shape,
      arm: "none",
      tree: "after",
      samples: await sample(after.url, noPreference, args.runs),
    });

    if (beforeTree) {
      const before = await bootFor(args, beforeTree, dataDir, shape, args.port + 1)();
      try {
        if (shape === "held") await waitForHeldPage(before.url);
        const samples = await sample(before.url, noPreference, args.runs);
        /*
          BYTE FOR BYTE, ASSERTED. The promise to everybody who ignores this feature is not
          "an equivalent page" -- it is the same answer. Two live servers, one data directory,
          one string comparison.
        */
        if (samples.body !== shipped.body) {
          throw new Error(
            `the page changed for a reader with no preference: ` +
              `${samples.body.length} bytes on ${args.before}, ${shipped.body.length} on HEAD`,
          );
        }
        rows.push({ shape, arm: "none", tree: "before", samples });
      } finally {
        await before.stop();
      }
    }

    // `--red unapplied` skips exactly this, so the arranged arm then measures the default page
    // -- which is what "personalisation silently does nothing" looks like.
    const arrangement = arrange(page);
    if (args.red !== "unapplied") {
      const saved = await putPreference(after.url, arrangement.body);
      if (saved.status !== 200) throw new Error(`PUT ${PREFERENCE_PATH} answered ${saved.status}`);
    }
    rows.push({
      shape,
      arm: "arranged",
      tree: "after",
      samples: await sample(
        after.url,
        { shelves: arrangement.shelves, first: arrangement.first, absent: arrangement.hidden },
        args.runs,
      ),
    });
  } finally {
    await after.stop();
  }
  return rows;
}

/** The acceptance, on a fresh dir, because it starts from "nobody has arranged anything". */
async function runAcceptance(args: Args, here: string, fixture: Fixture): Promise<void> {
  seedDataDir(fixture.dataDir, fixture.index);
  const make = bootFor(args, here, fixture.dataDir, "held", args.port);
  const server = await make();
  let shipped: string;
  try {
    shipped = (await discover(server.url)).body;
  } finally {
    await server.stop();
  }
  await acceptance(make, arrange(shelvesOf(shipped)), shipped);
  console.log("\nacceptance: every check passed against a live server, across a restart");
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const here = join(import.meta.dir, "../..");
  // The index is resolved from the AMBIENT config, before the scratch dir exists -- see
  // `resolveIndex` for why that ordering is the whole of it.
  const fixture: Fixture = { dataDir: join(args.scratch, "data"), index: resolveIndex() };
  mkdirSync(args.scratch, { recursive: true });

  console.log(
    `# host: ${hostname()} ${process.platform}/${process.arch} ${navigator.hardwareConcurrency}cpu ` +
      `ram=${Math.round(totalmem() / 1e9)}GB bun=${Bun.version}`,
  );
  console.log(`# date: ${new Date().toISOString()}  runs=${args.runs}  head=${here}`);
  console.log(`# index: ${fixture.index} (${(Bun.file(fixture.index).size / 1e9).toFixed(2)} GB)`);
  if (args.red) console.log(`# RED PROOF (${args.red}): this run MUST exit non-zero`);

  const beforeTree = args.before
    ? await materialiseTree(args.before, join(args.scratch, "before"), here)
    : null;
  if (beforeTree) console.log(`# before: ${args.before} extracted to ${beforeTree}`);

  const rows: Row[] = [];
  for (const shape of shapesFor(args)) {
    rows.push(...(await measureShape(args, here, beforeTree, fixture, shape)));
  }
  await runAcceptance(args, here, fixture);

  report(rows);
  console.log(`\nscratch left at ${args.scratch} -- it is inside the worktree and goes with it`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
