/**
 * Studio and network logo lookup.
 *
 * The IMDb index carries no studio, but Radarr and Sonarr return one in the SAME
 * lookup that already resolves a poster (`studio` for movies, `network` for series).
 * Kometa publishes a logo set whose filenames are the same TVDB/TMDB vocabulary the
 * arrs speak, so matching is a filename lookup rather than a crosswalk.
 *
 * The import job renames every file to its slug on the way in, so nothing at runtime
 * needs a name->file map: slugify the arr's string and you have the path.
 */

import { normalize } from "./normalize";

export type LogoKind = "network" | "studio" | "streaming" | "rating";

export const LOGO_KINDS: readonly LogoKind[] = ["network", "studio", "streaming", "rating"] as const;

/**
 * Fold a studio or network name to its on-disk slug.
 *
 * Built on `normalize()` so a logo folds exactly like a title does -- one folding
 * rule for the whole product, and the ligature map that turns "Stöð 2" into "stod 2"
 * comes along for free.
 *
 * The two substitutions are NOT cosmetic. `normalize()` collapses every non-alphanumeric
 * run to a space, which would make `AMC` and `AMC+` the same slug -- and then the import
 * would silently overwrite one logo with the other. Measured across Kometa's 765 names,
 * a naive fold collides 17 times and every collision is a distinct service being merged
 * into its parent brand: AMC/AMC+, Apple TV/Apple TV+, BET/BET+, Discovery/discovery+,
 * Lionsgate/Lionsgate+. Spelling `+` and `&` out keeps them apart.
 */
export function slugifyLogo(name: string | null | undefined): string {
  if (!name) return "";
  return normalize(name.replace(/\+/g, " plus ").replace(/&/g, " and ")).replace(/ /g, "-");
}

/** Written by `src/jobs/import-logos.ts`, read once at boot. */
export interface LogoManifest {
  /** The Kometa commit the set was built from. Pinned, never a moving ref. */
  commit: string;
  generatedAt: string;
  /** Slugs only -- the file is always `<slug>.png` under the kind's directory. */
  sets: Record<LogoKind, string[]>;
}

/**
 * O(1) membership over the manifest.
 *
 * A card render must never stat the filesystem, so the slug set is held in memory.
 * At 765 entries that is tens of kilobytes.
 */
export class LogoIndex {
  private readonly sets: Record<LogoKind, Set<string>>;
  readonly commit: string;

  // Built by walking LOGO_KINDS rather than naming each kind, so adding one is a single
  // entry in that array -- the alternative is four hand-maintained lists that drift.
  constructor(manifest: LogoManifest) {
    this.commit = manifest.commit;
    this.sets = Object.fromEntries(LOGO_KINDS.map((k) => [k, new Set(manifest.sets[k] ?? [])])) as Record<
      LogoKind,
      Set<string>
    >;
  }

  /** An empty index -- what the server runs with when the import has never been run. */
  static empty(): LogoIndex {
    return new LogoIndex({
      commit: "",
      generatedAt: "",
      sets: Object.fromEntries(LOGO_KINDS.map((k) => [k, [] as string[]])) as Record<LogoKind, string[]>,
    });
  }

  get size(): number {
    return LOGO_KINDS.reduce((n, k) => n + this.sets[k].size, 0);
  }

  /** Does this exact slug exist? The rating marks are a fixed vocabulary, addressed directly. */
  has(kind: LogoKind, slug: string): boolean {
    return this.sets[kind].has(slug);
  }

  /**
   * Public URL for a name's logo, or `null` if we have no logo for it.
   *
   * `null` is the common case and is not an error -- most of IMDb's long tail is
   * produced by outfits nobody has ever made a logo for. The card renders no badge.
   */
  urlFor(kind: LogoKind, name: string | null | undefined): string | null {
    const slug = slugifyLogo(name);
    if (!slug || !this.sets[kind].has(slug)) return null;
    return `/logos/${kind}/${slug}.png`;
  }

  /**
   * Which set to look in. Series carry a network, movies carry a studio -- they are
   * different vocabularies and live in different directories, so a series must never
   * fall back to the studio set.
   *
   * `kind` is IMDb's `titleType`, matching how the rest of the server branches.
   */
  urlForTitle(kind: string | null | undefined, name: string | null | undefined): string | null {
    const isSeries = kind === "tvSeries" || kind === "tvMiniSeries";
    return this.urlFor(isSeries ? "network" : "studio", name);
  }
}

/**
 * Load the manifest written by `src/jobs/import-logos.ts`.
 *
 * A missing manifest is NOT an error: the import is a separate build-time step, and a
 * checkout that has never run it should still start and serve everything else. It just
 * renders no badges. Read once at boot -- never on a request path.
 */
export async function loadLogoIndex(
  path = `${import.meta.dir}/../logos.json`,
  log: (m: string) => void = () => {},
): Promise<LogoIndex> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    log("logos: no manifest -- badges disabled. Run 'bun run logos:import'.");
    return LogoIndex.empty();
  }
  try {
    const index = new LogoIndex((await file.json()) as LogoManifest);
    log(`logos: ${index.size} marks from Kometa@${index.commit.slice(0, 8)}`);
    return index;
  } catch (err) {
    // A corrupt manifest must not take the server down over a cosmetic feature.
    log(`logos: manifest unreadable (${(err as Error).message}) -- badges disabled`);
    return LogoIndex.empty();
  }
}
