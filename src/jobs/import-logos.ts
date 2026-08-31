#!/usr/bin/env bun
/**
 * Import studio and network logos from Kometa.
 *
 * A BUILD-TIME job, not a scheduled one. Logos change approximately never, so this
 * runs by hand when the pinned commit is bumped -- unlike the index, which rebuilds
 * daily. Output is committed, so an upstream change shows up as a reviewable diff
 * instead of silently altering what the app serves.
 *
 * Why Kometa: its filenames are the same TVDB/TMDB vocabulary Radarr and Sonarr
 * return, so `studio: "Castle Rock Entertainment"` finds
 * `Castle Rock Entertainment.png` with no crosswalk. Verified against our own arrs.
 *
 *   bun src/jobs/import-logos.ts            # fetch, transform, write
 *   bun src/jobs/import-logos.ts --dry-run  # report only, touch nothing
 *
 * Licence: the Kometa repo is MIT. The logos remain their trademark holders'
 * property and are used here the way every media-centre project uses them -- for
 * identification, in a private non-commercial tool.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { LOGO_KINDS, type LogoKind, type LogoManifest, slugifyLogo } from "../lib/logos";

/**
 * PINNED. Never `master` -- a moving ref would make the build non-reproducible and
 * let an upstream rename silently change which logo a card shows.
 */
const KOMETA_COMMIT = "0f564beba5e23667f32c251fc0a5ebc3fbf051f1";
const KOMETA_REPO = "Kometa-Team/Kometa";

/**
 * One variant per kind, so the public path stays `/logos/<kind>/<slug>.png`.
 *
 * `color` is a slight misnomer upstream: measured, it is brand colour only where the
 * brand HAS one (Netflix reads 126,16,25) and a white or grey knockout otherwise
 * (HBO 216, AMC 96, Disney+ 82). `studio/standard` is greyscale+alpha throughout.
 *
 * **Consequence for the UI: most marks are near-white on transparent, so the badge
 * needs a dark backing to be visible at all.** Fine on finderr's dark surface; it
 * would disappear on a light chip. Kometa also ships `white` (full knockout) and
 * `bigger` if the design ever wants them.
 *
 * Heights are not uniform either -- 185 of 277 networks are 85px, the rest 50-82 --
 * so the badge must constrain height and let width run auto.
 */
/**
 * One variant per kind, so the public path stays `/logos/<kind>/<slug>.png`.
 *
 * `null` means the kind's PNGs sit directly in its directory with no variant level --
 * which is how upstream ships `rating`, and the reason this is not a plain string.
 */
const VARIANT: Record<LogoKind, string | null> = {
  network: "color",
  studio: "standard",
  streaming: "color",
  // Score marks: IMDb, TMDb, Metacritic, Trakt, and separate fresh/rotten art for the
  // RT critics and audience halves. One flat directory, no variants.
  rating: null,
};

/** The kind's directory inside the tarball, variant level included only when there is one. */
function kindPath(kind: LogoKind): string {
  const variant = VARIANT[kind];
  return variant ? `${kind}/${variant}` : kind;
}

/**
 * Name groups that are genuinely the same brand spelled two ways upstream, so
 * collapsing them onto one slug is correct.
 *
 * Asserted as the PAIR, not as a count. `HBO Max`/`HBO-Max` appears in both the
 * network and the streaming set, so a count would have to be "2" today and would
 * quietly need bumping every time an existing dupe showed up in one more set --
 * which is exactly how a real brand collision slips through. Matching on the names
 * means an unknown pair fails no matter how many times it occurs.
 */
const KNOWN_DUPLICATES: readonly string[] = ["HBO Max|HBO-Max"];

const dupKey = (names: string[]) => [...names].sort().join("|");

export class LogoCollisionError extends Error {
  constructor(collisions: Map<string, string[]>) {
    const lines = [...collisions].map(([slug, names]) => `  ${slug}  <-  ${names.join("  |  ")}`);
    super(
      `${collisions.size} unrecognised slug collision(s):\n${lines.join("\n")}\n` +
        "Two different names folded to one filename, so one logo would overwrite the other.\n" +
        "If they are genuinely the same brand, add the pair to KNOWN_DUPLICATES.\n" +
        "If they are not, fix slugifyLogo() -- do NOT widen the exception.",
    );
    this.name = "LogoCollisionError";
  }
}

/**
 * The PNGs go under `web/public`, which Vite copies into `web/dist` -- the only web
 * directory the runtime image contains.
 *
 * The manifest goes under `src` instead, because the SERVER resolves logo URLs (so
 * the client is handed a ready path and never needs the slug set). `src` is copied
 * into the runtime image; `web/src` is not, so a manifest there would exist in dev
 * and be missing in production.
 */
const OUT_ROOT = "web/public/logos";
const MANIFEST_PATH = "src/logos.json";

function log(msg: string) {
  console.log(`[logos] ${msg}`);
}

/**
 * Download the repo tarball and extract only the six directories we want.
 *
 * `Bun.Archive` filters on extract with a Glob, so the non-matching 99% of the
 * tarball is discarded as it streams rather than landing on disk.
 */
async function fetchLogos(tmpDir: string): Promise<void> {
  const url = `https://codeload.github.com/${KOMETA_REPO}/tar.gz/${KOMETA_COMMIT}`;
  log(`fetching ${KOMETA_REPO}@${KOMETA_COMMIT.slice(0, 8)}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball fetch failed: ${res.status} ${res.statusText}`);

  const bytes = await res.arrayBuffer();
  log(`downloaded ${(bytes.byteLength / 1048576).toFixed(1)} MB, extracting`);

  const globs = LOGO_KINDS.map((k) => `*/defaults/overlays/images/${kindPath(k)}/*.png`);
  await new Bun.Archive(bytes).extract(tmpDir, { glob: globs });
}

/** Where the extracted tree put a kind's files. The tarball root is `Kometa-<sha>/`. */
async function extractedDir(tmpDir: string, kind: LogoKind): Promise<string | null> {
  const roots = await readdir(tmpDir, { withFileTypes: true });
  for (const r of roots) {
    if (!r.isDirectory()) continue;
    const p = join(tmpDir, r.name, "defaults/overlays/images", kindPath(kind));
    if (existsSync(p)) return p;
  }
  return null;
}

interface KindResult {
  kind: LogoKind;
  slugs: string[];
  bytes: number;
  collisions: Map<string, string[]>;
  skipped: string[];
}

/** Slugify every file in one set, detect collisions, and write the renamed copies. */
async function importKind(srcDir: string, kind: LogoKind, dryRun: boolean): Promise<KindResult> {
  const files = (await readdir(srcDir)).filter((f) => f.toLowerCase().endsWith(".png"));

  const bySlug = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const file of files) {
    const name = file.replace(/\.png$/i, "");
    const slug = slugifyLogo(name);
    // A name that folds to nothing has no addressable filename. None exist today;
    // this is here so a future upstream oddity is reported rather than written as ".png".
    if (!slug) {
      skipped.push(name);
      continue;
    }
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)!).push(name);
  }

  const collisions = new Map([...bySlug].filter(([, names]) => names.length > 1));

  const outDir = join(OUT_ROOT, kind);
  if (!dryRun) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  }

  let bytes = 0;
  for (const [slug, names] of bySlug) {
    // Deterministic winner on a collision, so a re-run cannot flip which file wins.
    const chosen = [...names].sort()[0];
    const src = Bun.file(join(srcDir, `${chosen}.png`));
    bytes += src.size;
    if (!dryRun) await Bun.write(join(outDir, `${slug}.png`), src);
  }

  return { kind, slugs: [...bySlug.keys()].sort(), bytes, collisions, skipped };
}

export async function importLogos(opts: { dryRun?: boolean } = {}): Promise<LogoManifest> {
  const dryRun = opts.dryRun ?? false;
  const tmpDir = join(".claude/temp", `kometa-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    await fetchLogos(tmpDir);

    const results: KindResult[] = [];
    for (const kind of LOGO_KINDS) {
      const dir = await extractedDir(tmpDir, kind);
      if (!dir) {
        throw new Error(
          `no files extracted for "${kind}" (${kindPath(kind)}). ` +
            "Upstream may have reorganised -- check the paths before bumping the pin.",
        );
      }
      results.push(await importKind(dir, kind, dryRun));
    }

    // Every collision must be a KNOWN duplicate. An unrecognised one means two
    // different brands folded together and one logo is about to overwrite the other.
    const allCollisions = new Map<string, string[]>();
    const unknown = new Map<string, string[]>();
    for (const r of results) {
      for (const [slug, names] of r.collisions) {
        allCollisions.set(`${r.kind}/${slug}`, names);
        if (!KNOWN_DUPLICATES.includes(dupKey(names))) unknown.set(`${r.kind}/${slug}`, names);
      }
    }
    if (unknown.size > 0) throw new LogoCollisionError(unknown);

    for (const r of results) {
      const dup = r.collisions.size ? `, ${r.collisions.size} deduped` : "";
      const skip = r.skipped.length ? `, ${r.skipped.length} unsluggable` : "";
      log(`${r.kind}: ${r.slugs.length} logos, ${(r.bytes / 1048576).toFixed(1)} MB${dup}${skip}`);
    }
    for (const [slug, names] of allCollisions) log(`  deduped ${slug} <- ${names.join(" | ")}`);

    const manifest: LogoManifest = {
      commit: KOMETA_COMMIT,
      generatedAt: new Date().toISOString(),
      // Walks LOGO_KINDS for the same reason LogoIndex does: a new kind is one entry
      // in that array, not one more line to forget here.
      sets: Object.fromEntries(
        LOGO_KINDS.map((k) => [k, results.find((r) => r.kind === k)?.slugs ?? []]),
      ) as Record<LogoKind, string[]>,
    };

    const total = results.reduce((n, r) => n + r.slugs.length, 0);
    const mb = results.reduce((n, r) => n + r.bytes, 0) / 1048576;

    if (dryRun) {
      log(`DRY RUN -- ${total} logos / ${mb.toFixed(1)} MB, nothing written`);
    } else {
      await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
      log(`wrote ${total} logos (${mb.toFixed(1)} MB) to ${OUT_ROOT} + ${MANIFEST_PATH}`);
    }
    return manifest;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await importLogos({ dryRun: process.argv.includes("--dry-run") });
}
