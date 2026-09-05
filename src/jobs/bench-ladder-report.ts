/**
 * The memory ladder as ONE table: a row per cell, ordered by budget.
 *
 * ```bash
 * bun src/jobs/bench-ladder-report.ts results/nas-*.json --md
 * ```
 *
 * `bench-compare.ts` puts SCENARIOS side by side, which is the right shape for "did this index
 * change help `browse.genreRank`". The ladder asks the opposite question -- *what happens to the
 * whole system as one knob moves* -- so the interesting axis is the cell and the scenarios
 * collapse into suite totals. Two questions, two tables; neither is the other with a flag.
 *
 * The columns are chosen so the prefault decision can be read straight off the table: retention
 * says whether the read stayed, `firstIO` says whether the disk was touched anyway, and `warm`
 * says whether the steady state noticed. A rule that trades those against each other needs all
 * three next to each other.
 */

import { readFileSync } from "node:fs";

interface Cell {
  label: string;
  budgetMb: number;
  prefault: boolean;
  prefaultMs: number | null;
  prefaultReadMb: number | null;
  stamp: { indexMb: number; cpus: number; host: string; arch: string };
  residency: Record<string, { cacheMb: number | null; rssMb: number | null; failcnt: number | null }>;
  results: { firstTouchMs: number; firstTouchIo: number | null; p50: number; p99: number }[];
}

function load(path: string): Cell | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Cell;
  } catch (err) {
    console.error(`# skipping ${path}: ${(err as Error).message}`);
    return null;
  }
}

const files = Bun.argv.slice(2).filter((a) => !a.startsWith("--"));
const md = Bun.argv.includes("--md");
const cells = files
  .map(load)
  .filter((c): c is Cell => c !== null)
  // Descending budget: the ladder reads as a descent, and the top rung is the reference.
  .sort((a, b) => b.budgetMb - a.budgetMb || Number(a.prefault) - Number(b.prefault));

if (cells.length === 0) throw new Error("no readable cells given");

const rows = cells.map((c) => {
  const sumFirst = c.results.reduce((a, r) => a + r.firstTouchMs, 0);
  const sumWarm = c.results.reduce((a, r) => a + r.p50, 0);
  const io = c.results.reduce((a, r) => a + (r.firstTouchIo ?? 0), 0);
  const anyIo = c.results.some((r) => r.firstTouchIo !== null);
  // Residency AFTER THE SUITE, not after the prefault: the drop between the two is the page
  // cache being reclaimed under the cap, which is the effect the deployment could not see.
  const kept = c.residency.afterSuite?.cacheMb ?? null;
  const keptPf = c.residency.afterPrefault?.cacheMb ?? null;
  return {
    label: c.label,
    budget: c.budgetMb,
    index: c.stamp.indexMb,
    pct: Math.round((c.stamp.indexMb / c.budgetMb) * 100),
    pf: c.prefault,
    pfMs: c.prefaultMs,
    retention: keptPf === null || !c.prefaultReadMb ? null : Math.round((keptPf / c.prefaultReadMb) * 100),
    residentMb: kept,
    first: sumFirst,
    warm: sumWarm,
    io: anyIo ? io / 1e6 : null,
    failcnt: c.residency.afterSuite?.failcnt ?? null,
  };
});

const head = [
  "cell",
  "budget",
  "index/budget",
  "prefault",
  "prefault s",
  "retention",
  "resident",
  "first-touch",
  "first I/O",
  "warm",
  "failcnt",
];
const body = rows.map((r) => [
  r.label,
  `${r.budget} MB`,
  `${r.pct}%`,
  r.pf ? "on" : "off",
  r.pfMs === null ? "-" : (r.pfMs / 1000).toFixed(2),
  r.retention === null ? "-" : `${r.retention}%`,
  r.residentMb === null ? "?" : `${r.residentMb} MB`,
  `${r.first.toFixed(0)} ms`,
  r.io === null ? "-" : `${r.io.toFixed(0)} MB`,
  `${r.warm.toFixed(1)} ms`,
  r.failcnt === null ? "?" : String(r.failcnt),
]);

if (md) {
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  for (const b of body) console.log(`| ${b.join(" | ")} |`);
} else {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  console.log(head.map((h, i) => h.padEnd(w[i])).join("  "));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const b of body) console.log(b.map((v, i) => v.padEnd(w[i])).join("  "));
}
