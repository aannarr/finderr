/**
 * Turning a path an ARR reported into a path THIS process may open.
 *
 * Radarr and Sonarr describe files by the path they see inside their own container --
 * `/plex/movie/...`, because their compose block mounts the media share at `/plex`. finderr
 * runs in a different container with a different mount, so every path off the arr API needs
 * translating before anything opens it.
 *
 * > [!IMPORTANT] THE TRANSLATION IS AN ALLOW-LIST, AND THAT IS THE ONLY REASON IT IS SAFE
 * > A path arriving over HTTP is an input off the wire (the fifth rule), and this one gets
 * > handed to a file open and to an ffmpeg argv. So the volume map is not a convenience --
 * > it is the ENUMERATION of every directory this process will ever open a media file from.
 * > A path that does not land inside one is REFUSED, never repaired and never truncated.
 *
 * **The cheapest correct deployment maps the arr path to ITSELF.** Radarr mounts
 * `/volume1/plex:/plex`; give finderr the same `/volume1/plex:/plex:ro` and the map is
 * `/plex=/plex`, an identity. Nothing to keep in step, nothing to drift. The map exists for
 * the deployments that cannot do that -- a dev machine, a different mount point.
 *
 * ## The split, and why there are two functions
 *
 * `mapMediaPath` is PURE and does the lexical half: bound, reject, normalise, match a
 * volume, rewrite. `resolveMediaFile` does the half that needs the filesystem: `realpath`
 * and a stat. They are separate because **the lexical half is where the interesting
 * mistakes are** and a pure function can be tested against a hundred hostile strings in
 * milliseconds with no temp directories.
 *
 * Both halves are needed and neither is sufficient:
 *
 * - Lexical alone is beaten by a SYMLINK. `/plex/movie/evil -> /etc` is inside the volume
 *   by every string test there is, and opening it is not.
 * - `realpath` alone is beaten by nothing, but it is a syscall per check and it cannot
 *   refuse a path before touching the disk -- so a hostile caller gets to make us stat
 *   whatever it names. The lexical half refuses those for free.
 */

import { posix } from "node:path";
import { LIMITS } from "./input-guards";

/**
 * One mount translation: what the ARR calls a directory, and what WE call it.
 *
 * Both are absolute POSIX paths with no trailing slash (`parseVolumes` normalises them).
 */
export interface MediaVolume {
  /** The prefix as the arr reports it, e.g. `/plex`. */
  arr: string;
  /** The prefix as this process sees it, e.g. `/plex` or `/Volumes/media`. */
  local: string;
}

/**
 * Why a path was refused. A CODE rather than a message, for the same reason
 * `RefusalReason` is: the caller decides what to say, and the detail stays in the log.
 */
export type PathRefusal =
  | "too-long"
  | "wrong-type"
  | "empty"
  | "not-absolute"
  | "illegal-characters"
  | "no-volume"
  | "escapes-volume"
  | "not-a-file";

export type MappedPath = { ok: true; path: string; volume: MediaVolume } | { ok: false; reason: PathRefusal };

/**
 * Parse `FINDERR_MEDIA_VOLUMES` into a map.
 *
 * Format is `arrPath=localPath`, comma separated: `/plex=/plex` or
 * `/plex=/Volumes/media,/archive=/mnt/archive`. Chosen over JSON because it goes in a
 * `.env` file beside a dozen other scalars and a quoted JSON blob in a dotenv is a
 * quoting bug waiting to happen.
 *
 * **The result is sorted longest-arr-prefix first**, so a more specific volume wins over a
 * more general one. With `/plex=/a,/plex/movie=/b`, a path under `/plex/movie` must resolve
 * through `/b` -- and iteration order in the env string is the operator's typing order,
 * which is not a thing to depend on.
 *
 * A malformed entry is DROPPED rather than throwing, and the caller logs the count: one
 * typo in one pair should not stop the server booting, and a volume that silently does not
 * exist fails closed (every path under it is refused) rather than open.
 */
export function parseVolumes(spec: string | undefined | null): MediaVolume[] {
  if (!spec) return [];
  const out: MediaVolume[] = [];
  for (const pair of spec.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const arr = tidyPrefix(pair.slice(0, eq));
    const local = tidyPrefix(pair.slice(eq + 1));
    if (!arr || !local) continue;
    out.push({ arr, local });
  }
  // Longest first. Ties are impossible (a duplicate arr prefix is the same string), so the
  // sort is total and the result does not depend on the input order.
  return out.sort((a, b) => b.arr.length - a.arr.length);
}

/** Trim, require absolute, normalise, drop any trailing slash. Empty string means refuse. */
function tidyPrefix(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith("/")) return "";
  if (hasIllegalPathChars(s)) return "";
  const n = posix.normalize(s);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * A NUL or a control character in a path is never legitimate and is dangerous twice over.
 *
 * A NUL TRUNCATES the string at the C boundary, so `"/plex/ok\0/../../etc/passwd"` passes
 * every JavaScript prefix test on the whole string and names `/plex/ok` to the kernel --
 * or the reverse, depending on which layer truncates. A newline breaks any place the path
 * is written to a log or a playlist line. Neither is worth trying to sanitise: unlike
 * display text, there is no "cleaned" version of a path that is still the right file, so
 * the answer is refusal.
 */
function hasIllegalPathChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * The lexical half: an arr path in, a local path out, or a refusal.
 *
 * PURE -- no filesystem, no clock, no config read. Everything it needs is an argument.
 *
 * > [!CAUTION] NORMALISE BEFORE MATCHING, OR THE ALLOW-LIST IS DECORATION
 * > `/plex/../etc/passwd` starts with `/plex` and is not in `/plex`. `posix.normalize`
 * > resolves the `..` first (and clamps at `/`, so no amount of `..` escapes upward past
 * > root), and the prefix test then runs on something that means what it says.
 *
 * > [!CAUTION] THE PREFIX TEST IS ON A SEGMENT BOUNDARY, NOT ON `startsWith`
 * > A bare `startsWith("/plex")` accepts `/plexsecrets/keys`, which is a different
 * > directory that merely shares six characters. The test is "equal to the volume, or
 * > begins with the volume plus a slash".
 */
export function mapMediaPath(arrPath: unknown, volumes: readonly MediaVolume[]): MappedPath {
  if (typeof arrPath !== "string") return { ok: false, reason: "wrong-type" };
  if (arrPath.length === 0) return { ok: false, reason: "empty" };
  if (arrPath.length > LIMITS.mediaPath) return { ok: false, reason: "too-long" };
  if (hasIllegalPathChars(arrPath)) return { ok: false, reason: "illegal-characters" };
  if (!arrPath.startsWith("/")) return { ok: false, reason: "not-absolute" };

  const normalised = posix.normalize(arrPath);
  // normalize() cannot introduce a control character and cannot leave a relative path from
  // an absolute input, so the two checks above still hold. It CAN leave a trailing slash,
  // which would name a directory -- `resolveMediaFile`'s stat is what refuses that.

  for (const volume of volumes) {
    if (!underPrefix(normalised, volume.arr)) continue;
    const rest = normalised.slice(volume.arr.length); // "" or "/something"
    const local = posix.normalize(volume.local + rest);
    // Belt and braces: the rewrite cannot escape, because `rest` is already normalised and
    // begins with a slash -- but this is the one place a future edit could quietly break
    // the whole guarantee, so it is asserted rather than reasoned about.
    if (!underPrefix(local, volume.local)) return { ok: false, reason: "escapes-volume" };
    return { ok: true, path: local, volume };
  }
  return { ok: false, reason: "no-volume" };
}

/** True when `path` IS `prefix` or sits under it, on a segment boundary. */
function underPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  return path.startsWith(prefix === "/" ? "/" : `${prefix}/`);
}

/** What the filesystem half needs, injected so tests need no disk. */
export interface MediaFs {
  realpath(p: string): Promise<string>;
  isFile(p: string): Promise<boolean>;
}

/**
 * The filesystem half: everything `mapMediaPath` decided, plus the two things only the disk
 * can answer -- does a symlink take this OUT of the volume, and is it actually a file?
 *
 * **The volume root is realpath'd too, and it has to be.** Comparing a resolved file path
 * against an UNRESOLVED root gives a false refusal on any deployment whose mount point is
 * itself a symlink -- `/Volumes/media -> /System/Volumes/Data/media` on macOS is the
 * ordinary case, not an exotic one. Both sides resolved, then compared.
 *
 * A missing file is `not-a-file` rather than its own code: from a caller's point of view
 * "the arr says this exists and it does not" and "this is a directory" lead to the same
 * place, which is that there is nothing here to play.
 */
export async function resolveMediaFile(
  arrPath: unknown,
  volumes: readonly MediaVolume[],
  fs: MediaFs = nodeMediaFs,
): Promise<MappedPath> {
  const mapped = mapMediaPath(arrPath, volumes);
  if (!mapped.ok) return mapped;

  let real: string;
  let realRoot: string;
  try {
    real = await fs.realpath(mapped.path);
    realRoot = await fs.realpath(mapped.volume.local);
  } catch {
    // ENOENT on either side. The file is not there, or the volume is not mounted; both are
    // "nothing to play" and neither is worth a distinct code the caller would not act on.
    return { ok: false, reason: "not-a-file" };
  }

  if (!underPrefix(real, realRoot)) return { ok: false, reason: "escapes-volume" };
  if (!(await fs.isFile(real))) return { ok: false, reason: "not-a-file" };
  return { ok: true, path: real, volume: mapped.volume };
}

const nodeMediaFs: MediaFs = {
  async realpath(p) {
    const { realpath } = await import("node:fs/promises");
    return realpath(p);
  },
  async isFile(p) {
    const { stat } = await import("node:fs/promises");
    try {
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  },
};
