/**
 * Render the brand SVGs in assets/brand/ into the raster favicon/PWA set under
 * web/public/.
 *
 * The SVGs are the source of truth and the PNGs are derived, so a change to the
 * mark is one edit plus one `bun run icons:build` -- never a hand-resize of nine
 * files that then drift apart. This is the single owner of WHICH sizes exist;
 * adding one is a line in SIZES, not a new command somebody has to remember.
 *
 * It shells out to rsvg-convert and ImageMagick rather than rasterising in
 * process: this runs on a developer's Mac at authoring time, not in the
 * container and not on the render path, so a host dependency is the cheap
 * answer. It refuses loudly rather than silently emitting a blank PNG, which is
 * exactly what ImageMagick's own internal SVG renderer does with a stroke-only
 * file.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..", "..");
const BRAND = join(ROOT, "assets", "brand");
const OUT = join(ROOT, "web", "public");

/** Square PNGs rendered straight from one of the brand SVGs. */
const SIZES: Array<{ src: string; name: string; px: number }> = [
  // Favicons. 48 is not used by a <link> but is the third frame of the .ico,
  // which Windows still reaches for on the taskbar.
  { src: "finderr-icon.svg", name: "favicon-16.png", px: 16 },
  { src: "finderr-icon.svg", name: "favicon-32.png", px: 32 },
  { src: "finderr-icon.svg", name: "favicon-48.png", px: 48 },
  // iOS home screen. Always opaque and always square -- iOS applies its own
  // corner radius on top, so ours just has to be no rounder than theirs.
  { src: "finderr-icon.svg", name: "apple-touch-icon.png", px: 180 },
  // PWA / Android.
  { src: "finderr-icon.svg", name: "icon-192.png", px: 192 },
  { src: "finderr-icon.svg", name: "icon-512.png", px: 512 },
  { src: "finderr-maskable.svg", name: "icon-maskable-512.png", px: 512 },
];

/** The .ico is built from these, largest last. */
const ICO_FRAMES = ["favicon-16.png", "favicon-32.png", "favicon-48.png"];

async function requireTool(name: string): Promise<string> {
  const path = Bun.which(name);
  if (!path) {
    throw new Error(
      `${name} is not on PATH. Install it (brew install librsvg imagemagick) ` +
        `and re-run. Do not substitute ImageMagick's built-in SVG renderer -- ` +
        `it renders a stroke-only SVG as a blank image without erroring.`,
    );
  }
  return path;
}

async function main(): Promise<void> {
  await requireTool("rsvg-convert");
  await requireTool("magick");
  await mkdir(OUT, { recursive: true });

  // The SVG favicon is served as-is: it is the only one that stays sharp on a
  // high-DPI tab strip, and every browser that ignores it falls back to the ico.
  const iconSvg = join(BRAND, "finderr-icon.svg");
  await Bun.write(join(OUT, "favicon.svg"), Bun.file(iconSvg));

  for (const { src, name, px } of SIZES) {
    const from = join(BRAND, src);
    const to = join(OUT, name);
    await mkdir(dirname(to), { recursive: true });
    await $`rsvg-convert -w ${px} -h ${px} ${from} -o ${to}`.quiet();
    console.log(`  ${name}  ${px}x${px}`);
  }

  const frames = ICO_FRAMES.map((f) => join(OUT, f));
  await $`magick ${frames} ${join(OUT, "favicon.ico")}`.quiet();
  console.log(`  favicon.ico  ${ICO_FRAMES.length} frames`);
}

await main();
