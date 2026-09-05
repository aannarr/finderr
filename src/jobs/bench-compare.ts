/**
 * Put N bench runs side by side, so a hardware or index-shape question has ONE table.
 *
 * ```bash
 * bun src/jobs/bench-compare.ts a.json b.json           # every metric, a column per run
 * bun src/jobs/bench-compare.ts *.json --metric cold    # just the one that matters
 * bun src/jobs/bench-compare.ts *.json --md             # markdown, for pasting into a doc
 * ```
 *
 * `bench-index.ts --json` writes the inputs. The first file given is the BASELINE and every
 * ratio is against it, so the argument order is the question: put the machine or profile you
 * are arguing FROM first.
 *
 * ## Why this is a separate tool rather than a flag on the runner
 *
 * The runs it compares happen on DIFFERENT MACHINES, minutes or hours apart, and one of them
 * is inside a container on a NAS. There is no process that could hold both, so the only thing
 * that can join them is a file format -- which makes the joiner its own program. That also
 * means a comparison can be re-derived later from JSON somebody kept, without re-running a
 * suite that takes an hour on the slow side.
 *
 * ## What it deliberately does not do
 *
 * No pass/fail, no threshold, no "regression detected". Two machines are not two revisions of
 * one machine, and the honest output of comparing them is a table a human reads. The gate on
 * query PLANS lives in `../lib/query-plans.test.ts`, where a categorical answer belongs.
 */

import { readFileSync } from "node:fs";

interface Result {
  id: string;
  surface: string;
  p50: number;
  p95: number;
  p99: number;
  max?: number;
  cold: number;
  coldMin?: number;
  coldMax?: number;
  coldIo?: number | null;
  prefaultMs?: number | null;
  rows: number;
  sorts: number;
  scans: number;
}

interface Run {
  label?: string;
  stamp?: Record<string, unknown>;
  profile?: string | null;
  prefault?: boolean;
  pragmas?: { mmap: number | null; cache: number | null };
  coldRuns?: number;
  runs: number;
  results: Result[];
  /** Filled in by the loader so an error can name the file rather than the label. */
  _file: string;
}

/** The metrics worth a column, and how to read one out of a result row. */
const METRICS: Record<string, { of: (r: Result) => number | null; unit: string; what: string }> = {
  p50: { of: (r) => r.p50, unit: "ms", what: "warm median -- the steady state, everything cached" },
  p99: { of: (r) => r.p99, unit: "ms", what: "warm tail" },
  max: { of: (r) => r.max ?? null, unit: "ms", what: "worst warm sample -- the stall, on a sync server" },
  cold: { of: (r) => r.cold, unit: "ms", what: "median of N samples on a never-read inode" },
  coldIo: { of: (r) => (r.coldIo == null ? null : r.coldIo / 1e6), unit: "MB", what: "bytes off the device" },
};

function parse(argv: string[]): { files: string[]; metrics: string[]; md: boolean } {
  const files: string[] = [];
  let metrics: string[] = ["p50", "cold"];
  let md = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--metric") metrics = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--all") metrics = Object.keys(METRICS);
    else if (a === "--md") md = true;
    else files.push(a);
  }
  if (files.length === 0) throw new Error("give at least one bench --json file");
  for (const m of metrics) if (!METRICS[m]) throw new Error(`unknown --metric ${m}`);
  return { files, metrics, md };
}

function load(file: string): Run {
  const run = JSON.parse(readFileSync(file, "utf8")) as Run;
  if (!Array.isArray(run.results)) throw new Error(`${file}: not a bench --json file`);
  run._file = file;
  return run;
}

/** A column heading that says what the cell IS, since a bare filename does not. */
function labelOf(run: Run): string {
  if (run.label) return run.label;
  const host = (run.stamp?.host as string) ?? run._file;
  return [host, run.profile, run.prefault ? "pf" : null].filter(Boolean).join("/");
}

function fmt(v: number | null, unit: string): string {
  if (v === null) return "-";
  if (unit === "MB") return v.toFixed(1);
  if (v >= 1000) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * The ratio a reader is actually after: how many times worse is this column than the first?
 *
 * Printed rather than a delta because these numbers span five orders of magnitude across the
 * suite -- `topGenres` at 13 ms warm and 4,635 ms cold is the same row. A difference in
 * milliseconds is unreadable across that range and a multiple is not.
 */
function ratio(base: number | null, v: number | null): string {
  if (base === null || v === null || base === 0) return "";
  const x = v / base;
  if (x >= 100) return `${x.toFixed(0)}x`;
  if (x >= 10) return `${x.toFixed(0)}x`;
  if (x >= 1.05 || x <= 0.95) return `${x.toFixed(2)}x`;
  return "=";
}

function main(): void {
  const { files, metrics, md } = parse(Bun.argv.slice(2));
  const runs = files.map(load);
  const labels = runs.map(labelOf);

  console.log("# runs compared\n");
  for (const [i, run] of runs.entries()) {
    const s = run.stamp ?? {};
    console.log(
      `  ${i === 0 ? "BASE " : "     "}${labels[i].padEnd(28)} ${run._file}\n` +
        `        ${s.platform ?? "?"}/${s.arch ?? "?"} ${s.cpus ?? "?"}cpu ram=${s.totalMemMb ?? "?"}MB ` +
        `index=${s.indexBytes ? ((s.indexBytes as number) / 1e6).toFixed(0) : "?"}MB ` +
        `profile=${run.profile ?? "as-is"} prefault=${run.prefault ?? false} ` +
        `mmap=${run.pragmas?.mmap ?? "default"} cache=${run.pragmas?.cache ?? "default"} ` +
        `warm-runs=${run.runs} cold-runs=${run.coldRuns ?? 1}`,
    );
  }

  // Only scenarios EVERY run has. A run that skipped one (an older index with no `episode`
  // table, a --filter) must not silently contribute a blank that reads as a zero.
  const sets = runs.map((r) => new Set(r.results.map((x) => x.id)));
  const common = new Set([...(sets[0] ?? [])].filter((id) => sets.every((s) => s.has(id))));
  const dropped = new Set(runs.flatMap((r) => r.results.map((x) => x.id))).size - common.size;
  if (dropped > 0) console.log(`\n  (${dropped} scenario(s) not present in every run -- omitted)`);

  for (const metric of metrics) {
    const m = METRICS[metric];
    console.log(`\n\n## ${metric} (${m.unit}) -- ${m.what}\n`);
    const rows = [...common]
      .map((id) => ({
        id,
        vals: runs.map((run) => {
          const r = run.results.find((x) => x.id === id);
          return r ? m.of(r) : null;
        }),
      }))
      // Sorted by the BASELINE's value: the expensive questions first, because those are the
      // ones a profile decision is about.
      .sort((a, b) => (b.vals[0] ?? 0) - (a.vals[0] ?? 0));

    const head = ["scenario", ...labels.map((l, i) => (i === 0 ? l : `${l}  (vs base)`))];
    if (md) {
      console.log(`| ${head.join(" | ")} |`);
      console.log(`|${head.map(() => "---").join("|")}|`);
    } else {
      console.log(
        `${head[0].padEnd(26)}${head
          .slice(1)
          .map((h) => h.padStart(22))
          .join("")}`,
      );
      console.log("-".repeat(26 + 22 * (head.length - 1)));
    }
    for (const row of rows) {
      const cells = row.vals.map((v, i) =>
        i === 0 ? fmt(v, m.unit) : `${fmt(v, m.unit)} ${ratio(row.vals[0], v)}`.trim(),
      );
      if (md) console.log(`| ${row.id} | ${cells.join(" | ")} |`);
      else console.log(`${row.id.padEnd(26)}${cells.map((c) => c.padStart(22)).join("")}`);
    }

    // The suite total, which is the number a decision gets made on. Summed over the COMMON
    // scenarios only, for the same reason the table is.
    const totals = runs.map((run) =>
      [...common].reduce((a, id) => {
        const r = run.results.find((x) => x.id === id);
        const v = r ? m.of(r) : null;
        return a + (v ?? 0);
      }, 0),
    );
    const totalCells = totals.map((t, i) =>
      i === 0 ? fmt(t, m.unit) : `${fmt(t, m.unit)} ${ratio(totals[0], t)}`,
    );
    if (md) console.log(`| **TOTAL** | ${totalCells.join(" | ")} |`);
    else console.log(`${"TOTAL".padEnd(26)}${totalCells.map((c) => c.padStart(22)).join("")}`);
  }

  console.log("");
}

main();
