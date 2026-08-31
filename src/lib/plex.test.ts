/**
 * The Plex mirror, against recorded responses -- no test touches the real server.
 *
 * The fixtures are trimmed copies of what a live PMS actually returned on 2026-08-31,
 * including the shapes that are easy to get wrong from memory:
 * `ratingKey` arrives as a STRING, the IMDb id is a `Guid` CHILD rather than the top-level
 * `guid`, and a section list contains types we must not walk.
 *
 * > [!CAUTION] The machineIdentifier below is INVENTED, and it must stay invented
 * > It is a hex placeholder, matching `FAKE_API_KEY` in `tmdb.test.ts`. A real one was
 * > pasted in here when this file was written and reached the public repo before anyone
 * > caught it -- it is not a credential, but it is the permanent, unique identity of one
 * > private server, which is exactly the class of fact this repository does not carry.
 * > Nothing about these assertions needs a real value: they pin URL TEMPLATES, and any
 * > 40-hex string exercises them identically.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { PlexClient, plexLinks, syncPlex } from "./plex";
import { Store } from "./store";

// --- the deeplink ----------------------------------------------------------

describe("plexLinks", () => {
  const machine = "0123456789abcdef0123456789abcdef01234567";

  /**
   * Both templates are Jellyseerr's `mediaUrl` and `iOSPlexUrl` verbatim. Pinning them
   * character-for-character is the point of this test: Plex documents neither, and a
   * deeplink that is subtly wrong does not fail -- it opens the server's home screen.
   */
  test("builds the two addresses exactly", () => {
    expect(plexLinks(machine, "27807")).toEqual({
      web: `https://app.plex.tv/desktop#!/server/${machine}/details?key=%2Flibrary%2Fmetadata%2F27807`,
      app: `plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F27807&server=${machine}`,
    });
  });

  /**
   * The slashes in the metadata path must arrive ENCODED. Raw, they are read as further
   * hash-route segments -- the silent version of the failure above.
   */
  test("the metadata path is encoded, never raw", () => {
    const links = plexLinks(machine, "27807");
    expect(links?.web).not.toContain("/library/metadata/");
    expect(links?.web).toContain("%2Flibrary%2Fmetadata%2F");
  });

  /** `/library/metadata/27807` means nothing without knowing whose library. */
  test("no machineIdentifier means no link, never a half-built one", () => {
    expect(plexLinks("", "27807")).toBeNull();
    expect(plexLinks(machine, "")).toBeNull();
  });
});

// --- the mirror ------------------------------------------------------------

const IDENTITY = {
  MediaContainer: { machineIdentifier: "0123456789abcdef0123456789abcdef01234567" },
};

const SECTIONS = {
  MediaContainer: {
    Directory: [
      { key: "1", type: "movie", title: "Movies" },
      { key: "2", type: "show", title: "TV Shows" },
      // Real on this server and correctly skipped: no tconst has ever been in a photo set.
      { key: "4", type: "photo", title: "Photos" },
    ],
  },
};

const MOVIES = {
  MediaContainer: {
    Metadata: [
      {
        // A STRING on the wire, even though it reads as a number.
        ratingKey: "27807",
        title: "*batteries not included",
        guid: "plex://movie/5d7768377228e5001f1ded62",
        Guid: [{ id: "imdb://tt0092494" }, { id: "tmdb://11548" }, { id: "tvdb://7001" }],
      },
      {
        ratingKey: "14450",
        title: "2 Fast 2 Furious",
        guid: "plex://movie/5d7768265af944001f1f6977",
        Guid: [{ id: "tmdb://584" }, { id: "imdb://tt0322259" }],
      },
      {
        // Matched by a LEGACY agent, so no imdb child at all. Real, and unreachable from
        // our index -- it must not become a row rather than becoming a wrong one.
        ratingKey: "99999",
        title: "Some Home Video",
        guid: "com.plexapp.agents.none://99999",
        Guid: null,
      },
    ],
  },
};

const SHOWS = {
  MediaContainer: {
    Metadata: [
      {
        ratingKey: "10643",
        title: "3 Body Problem",
        guid: "plex://show/5f57bdaf782ab300435487d0",
        Guid: [{ id: "imdb://tt13016388" }, { id: "tvdb://411959" }],
      },
    ],
  },
};

function fakePlex(routes: Record<string, unknown>, onCall?: (path: string) => void): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    onCall?.(path);
    const body = routes[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const ROUTES = {
  "/identity": IDENTITY,
  "/library/sections": SECTIONS,
  "/library/sections/1/all?includeGuids=1": MOVIES,
  "/library/sections/2/all?includeGuids=1": SHOWS,
};

/** A Store on its own scratch directory, the same shape `store.test.ts` uses. */
function tempStore(): { store: Store; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "finderr-plex-"));
  process.env.FINDERR_DATA_DIR = dir;
  const store = new Store(loadConfig(true));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      process.env.FINDERR_DATA_DIR = undefined;
    },
  };
}

describe("syncPlex", () => {
  test("mirrors every video section, keyed by our own tconst", async () => {
    const { store, cleanup } = tempStore();
    try {
      const client = new PlexClient("http://plex.test:32400", "tok", fakePlex(ROUTES));
      const res = await syncPlex(store, client);

      expect(res.error).toBeUndefined();
      expect(res.items).toBe(3);
      expect(store.plexMap().get("tt0092494")).toBe("27807");
      expect(store.plexMap().get("tt13016388")).toBe("10643");
      expect(store.plexMachineIdentifier()).toBe(IDENTITY.MediaContainer.machineIdentifier);
    } finally {
      cleanup();
    }
  });

  /**
   * A legacy-agent match carries no `imdb://` child. It is a real item we simply cannot
   * address from our index, and inventing a row for it would link the wrong title.
   */
  test("an item with no IMDb guid is dropped, not guessed at", async () => {
    const { store, cleanup } = tempStore();
    try {
      const client = new PlexClient("http://plex.test:32400", "tok", fakePlex(ROUTES));
      await syncPlex(store, client);
      expect(store.plexCount()).toBe(3); // not 4 -- "Some Home Video" is absent
    } finally {
      cleanup();
    }
  });

  /** A photo or music section has no titles in it and costs a request to find that out. */
  test("only movie and show sections are walked", async () => {
    const { store, cleanup } = tempStore();
    const calls: string[] = [];
    try {
      const client = new PlexClient(
        "http://plex.test:32400",
        "tok",
        fakePlex(ROUTES, (p) => calls.push(p)),
      );
      await syncPlex(store, client);
      expect(calls.filter((c) => c.includes("/all"))).toEqual([
        "/library/sections/1/all?includeGuids=1",
        "/library/sections/2/all?includeGuids=1",
      ]);
    } finally {
      cleanup();
    }
  });

  /**
   * `includeGuids=1` is the whole reason this works: without it Plex returns only the
   * agent's own `plex://` guid and there is nothing to crosswalk against our index.
   */
  test("always asks for the guids", async () => {
    const { store, cleanup } = tempStore();
    const calls: string[] = [];
    try {
      const client = new PlexClient(
        "http://plex.test:32400",
        "tok",
        fakePlex(ROUTES, (p) => calls.push(p)),
      );
      await syncPlex(store, client);
      expect(calls.filter((c) => c.includes("/all")).every((c) => c.includes("includeGuids=1"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  /**
   * A ratingKey is stable, so a stale mirror is a working link while an emptied one is a
   * page that quietly loses its Play buttons. Plex being down for a minute must not do
   * that -- the failing walk never reaches the store at all.
   */
  test("a failed walk leaves the previous mirror standing", async () => {
    const { store, cleanup } = tempStore();
    try {
      const good = new PlexClient("http://plex.test:32400", "tok", fakePlex(ROUTES));
      await syncPlex(store, good);
      expect(store.plexCount()).toBe(3);

      const dead = new PlexClient("http://plex.test:32400", "tok", fakePlex({}));
      const res = await syncPlex(store, dead);

      expect(res.error).toContain("plex");
      expect(store.plexCount()).toBe(3);
      expect(store.plexMap().get("tt0092494")).toBe("27807");
    } finally {
      cleanup();
    }
  });

  /** A title deleted from Plex has to lose its play link, which is why this is a swap. */
  test("a title gone from Plex leaves the mirror", async () => {
    const { store, cleanup } = tempStore();
    try {
      await syncPlex(store, new PlexClient("http://x:32400", "tok", fakePlex(ROUTES)));
      expect(store.plexMap().has("tt0322259")).toBe(true);

      const fewer = {
        ...ROUTES,
        "/library/sections/1/all?includeGuids=1": {
          MediaContainer: { Metadata: [MOVIES.MediaContainer.Metadata[0]] },
        },
      };
      await syncPlex(store, new PlexClient("http://x:32400", "tok", fakePlex(fewer)));

      expect(store.plexMap().has("tt0322259")).toBe(false);
      expect(store.plexMap().has("tt0092494")).toBe(true);
    } finally {
      cleanup();
    }
  });

  /** No Plex configured is the ordinary case, not an error. */
  test("no client is a no-op, not a failure", async () => {
    const { store, cleanup } = tempStore();
    try {
      expect(await syncPlex(store, undefined)).toEqual({});
      expect(store.plexCount()).toBe(0);
      expect(store.plexMachineIdentifier()).toBeNull();
    } finally {
      cleanup();
    }
  });
});

/**
 * The token goes in a header, never the query string.
 *
 * Same lesson `src/plugins/tmdb` bought with `?api_key=`: anything that logs a URL then
 * logs the credential. Here it cannot, because the URL never carries it.
 */
test("the token travels as a header, never in the URL", async () => {
  const seen: { url: string; token: string | null }[] = [];
  const client = new PlexClient("http://plex.test:32400", "s3cret", (async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    seen.push({
      url: String(input),
      token: new Headers(init?.headers).get("X-Plex-Token"),
    });
    return new Response(JSON.stringify(IDENTITY), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  await client.machineIdentifier();

  expect(seen[0]?.token).toBe("s3cret");
  expect(seen[0]?.url).not.toContain("s3cret");
});
