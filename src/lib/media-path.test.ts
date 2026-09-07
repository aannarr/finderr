import { describe, expect, it } from "bun:test";
import { LIMITS } from "./input-guards";
import { type MediaFs, type MediaVolume, mapMediaPath, parseVolumes, resolveMediaFile } from "./media-path";

const IDENTITY: MediaVolume[] = [{ arr: "/plex", local: "/plex" }];
const REMAPPED: MediaVolume[] = [{ arr: "/plex", local: "/Volumes/media" }];

describe("parseVolumes", () => {
  it("reads one pair", () => {
    expect(parseVolumes("/plex=/plex")).toEqual([{ arr: "/plex", local: "/plex" }]);
  });

  it("reads several and trims whitespace", () => {
    expect(parseVolumes(" /plex = /a , /archive = /b ")).toEqual([
      { arr: "/archive", local: "/b" },
      { arr: "/plex", local: "/a" },
    ]);
  });

  /**
   * The sort is the whole reason a nested volume works. Written with the SPECIFIC entry
   * second, which is the order an operator would naturally type it.
   */
  it("puts the longest arr prefix first so a nested volume wins", () => {
    const v = parseVolumes("/plex=/general,/plex/movie=/specific");
    expect(v[0]?.arr).toBe("/plex/movie");
    expect(mapMediaPath("/plex/movie/a.mkv", v)).toEqual({
      ok: true,
      path: "/specific/a.mkv",
      volume: { arr: "/plex/movie", local: "/specific" },
    });
    expect(mapMediaPath("/plex/tv/b.mkv", v)).toEqual({
      ok: true,
      path: "/general/tv/b.mkv",
      volume: { arr: "/plex", local: "/general" },
    });
  });

  it("drops a malformed pair rather than throwing", () => {
    expect(parseVolumes("nonsense")).toEqual([]);
    expect(parseVolumes("=/local")).toEqual([]);
    expect(parseVolumes("/arr=")).toEqual([]);
    expect(parseVolumes("")).toEqual([]);
    expect(parseVolumes(undefined)).toEqual([]);
  });

  it("refuses a relative prefix on either side", () => {
    expect(parseVolumes("plex=/local")).toEqual([]);
    expect(parseVolumes("/plex=local")).toEqual([]);
  });

  it("normalises away a trailing slash so the segment test stays honest", () => {
    expect(parseVolumes("/plex/=/media/")).toEqual([{ arr: "/plex", local: "/media" }]);
  });
});

describe("mapMediaPath rewrites a path inside a volume", () => {
  it("is an identity when the map is an identity", () => {
    expect(mapMediaPath("/plex/movie/Heat (1995)/heat.mkv", IDENTITY)).toEqual({
      ok: true,
      path: "/plex/movie/Heat (1995)/heat.mkv",
      volume: IDENTITY[0] as MediaVolume,
    });
  });

  it("swaps the prefix when the mount differs", () => {
    expect(mapMediaPath("/plex/movie/heat.mkv", REMAPPED)).toMatchObject({
      ok: true,
      path: "/Volumes/media/movie/heat.mkv",
    });
  });

  it("accepts the volume root itself", () => {
    expect(mapMediaPath("/plex", REMAPPED)).toMatchObject({ ok: true, path: "/Volumes/media" });
  });
});

describe("mapMediaPath refuses everything outside the allow-list", () => {
  /**
   * THE TRAVERSAL CASE. This is the one that decides whether the guard is real, so it is
   * spelled out in several shapes rather than once.
   *
   * Each of these begins with the literal characters `/plex`, so a `startsWith` allow-list
   * accepts every one of them. After normalisation none of them is inside the volume.
   */
  it.each([
    ["/plex/../etc/passwd", "no-volume"],
    ["/plex/movie/../../etc/passwd", "no-volume"],
    ["/plex/./../../root/.ssh/id_ed25519", "no-volume"],
    ["/plex/movie/../../../../../../etc/shadow", "no-volume"],
  ])("refuses traversal %s", (input, reason) => {
    expect(mapMediaPath(input, IDENTITY)).toEqual({ ok: false, reason: reason as never });
  });

  /**
   * THE SEGMENT-BOUNDARY CASE. `/plexsecrets` is a different directory that happens to
   * share a prefix; a naive `startsWith("/plex")` hands it over.
   */
  it.each(["/plexsecrets/keys.txt", "/plex-backup/db.sqlite", "/plexus"])(
    "refuses the prefix-collision %s",
    (input) => {
      expect(mapMediaPath(input, IDENTITY)).toEqual({ ok: false, reason: "no-volume" });
    },
  );

  it("refuses a NUL, which truncates a path at the C boundary", () => {
    expect(mapMediaPath("/plex/ok\0/../../etc/passwd", IDENTITY)).toEqual({
      ok: false,
      reason: "illegal-characters",
    });
    expect(mapMediaPath("/plex/movie/a\0.mkv", IDENTITY)).toEqual({
      ok: false,
      reason: "illegal-characters",
    });
  });

  it("refuses other control characters, which break every log line and playlist", () => {
    for (const bad of ["/plex/a\nb.mkv", "/plex/a\rb.mkv", "/plex/a\tb.mkv", "/plex/a\x1b[31m.mkv"]) {
      expect(mapMediaPath(bad, IDENTITY)).toEqual({ ok: false, reason: "illegal-characters" });
    }
  });

  it("refuses a relative path", () => {
    expect(mapMediaPath("plex/movie/a.mkv", IDENTITY)).toEqual({ ok: false, reason: "not-absolute" });
    expect(mapMediaPath("../plex/a.mkv", IDENTITY)).toEqual({ ok: false, reason: "not-absolute" });
  });

  it("refuses a non-string, an empty string and an over-long one", () => {
    expect(mapMediaPath(null, IDENTITY)).toEqual({ ok: false, reason: "wrong-type" });
    expect(mapMediaPath(42, IDENTITY)).toEqual({ ok: false, reason: "wrong-type" });
    expect(mapMediaPath("", IDENTITY)).toEqual({ ok: false, reason: "empty" });
    expect(mapMediaPath(`/plex/${"a".repeat(LIMITS.mediaPath)}.mkv`, IDENTITY)).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("refuses everything when no volume is configured", () => {
    expect(mapMediaPath("/plex/movie/a.mkv", [])).toEqual({ ok: false, reason: "no-volume" });
  });
});

/** A fake filesystem, so the symlink cases need no disk and no privileges. */
function fakeFs(links: Record<string, string>, files: Iterable<string>): MediaFs {
  const fileSet = new Set(files);
  return {
    async realpath(p) {
      const resolved = links[p];
      if (resolved !== undefined) return resolved;
      // A path with no entry at all is absent, which is what the real realpath says too.
      if (!fileSet.has(p) && !Object.values(links).includes(p)) throw new Error("ENOENT");
      return p;
    },
    async isFile(p) {
      return fileSet.has(p);
    },
  };
}

describe("resolveMediaFile catches what a string test cannot", () => {
  it("passes a real file through", async () => {
    const fs = fakeFs({ "/plex": "/plex" }, ["/plex/movie/a.mkv"]);
    await expect(resolveMediaFile("/plex/movie/a.mkv", IDENTITY, fs)).resolves.toMatchObject({
      ok: true,
      path: "/plex/movie/a.mkv",
    });
  });

  /**
   * THE SYMLINK CASE, which is the entire reason this second half exists. The path is
   * inside the volume by every lexical test there is, and the file it names is not.
   */
  it("refuses a symlink that points out of the volume", async () => {
    const fs = fakeFs({ "/plex": "/plex", "/plex/movie/evil.mkv": "/etc/shadow" }, [
      "/etc/shadow",
      "/plex/movie/evil.mkv",
    ]);
    expect(mapMediaPath("/plex/movie/evil.mkv", IDENTITY).ok).toBe(true);
    await expect(resolveMediaFile("/plex/movie/evil.mkv", IDENTITY, fs)).resolves.toEqual({
      ok: false,
      reason: "escapes-volume",
    });
  });

  /**
   * The mount point being a symlink is the ORDINARY case on macOS, so resolving only the
   * file and not the root would refuse every real path on a dev machine.
   */
  it("resolves the volume root too, so a symlinked mount point still works", async () => {
    const volumes: MediaVolume[] = [{ arr: "/plex", local: "/Volumes/media" }];
    const fs = fakeFs(
      {
        "/Volumes/media": "/System/Volumes/Data/media",
        "/Volumes/media/movie/a.mkv": "/System/Volumes/Data/media/movie/a.mkv",
      },
      ["/System/Volumes/Data/media/movie/a.mkv"],
    );
    await expect(resolveMediaFile("/plex/movie/a.mkv", volumes, fs)).resolves.toMatchObject({
      ok: true,
      path: "/System/Volumes/Data/media/movie/a.mkv",
    });
  });

  it("refuses a directory", async () => {
    const fs = fakeFs({ "/plex": "/plex", "/plex/movie": "/plex/movie" }, []);
    await expect(resolveMediaFile("/plex/movie", IDENTITY, fs)).resolves.toEqual({
      ok: false,
      reason: "not-a-file",
    });
  });

  it("refuses a file the arr claims exists and does not", async () => {
    const fs = fakeFs({ "/plex": "/plex" }, []);
    await expect(resolveMediaFile("/plex/movie/gone.mkv", IDENTITY, fs)).resolves.toEqual({
      ok: false,
      reason: "not-a-file",
    });
  });

  it("refuses without touching the filesystem when the lexical half already said no", async () => {
    let touched = 0;
    const fs: MediaFs = {
      async realpath(p) {
        touched++;
        return p;
      },
      async isFile() {
        touched++;
        return true;
      },
    };
    await expect(resolveMediaFile("/plex/../etc/passwd", IDENTITY, fs)).resolves.toEqual({
      ok: false,
      reason: "no-volume",
    });
    expect(touched).toBe(0);
  });
});
