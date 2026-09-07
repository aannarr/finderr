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

const MACHINE_ID = "0123456789abcdef0123456789abcdef01234567";

const SECTIONS = [
  { key: "1", type: "movie", title: "Movies" },
  { key: "2", type: "show", title: "TV Shows" },
  // Real on this server and correctly skipped: no tconst has ever been in a photo set.
  { key: "4", type: "photo", title: "Photos" },
];

const MOVIES = [
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
];

const SHOWS = [
  {
    ratingKey: "10643",
    title: "3 Body Problem",
    guid: "plex://show/5f57bdaf782ab300435487d0",
    Guid: [{ id: "imdb://tt13016388" }, { id: "tvdb://411959" }],
  },
];

/** One fake PMS. Anything omitted 404s, which is how a "server is down" case is written. */
interface FakeServer {
  machineIdentifier?: string;
  sections?: { key: string; type: string; title?: string }[];
  /** Section key -> that section's whole `Metadata` list. A missing key 404s. */
  items?: Record<string, unknown[]>;
  /**
   * Answer `/all` with the whole section and NO `totalSize`, which is exactly what the live
   * server does when the paging parameters are absent -- and therefore what a server that
   * IGNORED them would do. The walk has to terminate against this shape too.
   */
  ignorePaging?: boolean;
  /** Section keys whose SECOND page fails, for "a walk that dies halfway". */
  failAfterFirstPage?: string[];
}

/**
 * A stand-in PMS that pages the way the real one was measured to page on 2026-09-07: the
 * response echoes `offset`, reports `size` for the slice it returned and `totalSize` for the
 * whole section -- and reports `totalSize` ONLY when the request asked for a page.
 */
function fakePlex(server: FakeServer, onCall?: (path: string) => void): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    onCall?.(`${url.pathname}${url.search}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const missing = new Response("not found", { status: 404 });

    if (url.pathname === "/identity") {
      return server.machineIdentifier === undefined
        ? missing
        : json({ MediaContainer: { machineIdentifier: server.machineIdentifier } });
    }
    if (url.pathname === "/library/sections") {
      return server.sections === undefined
        ? missing
        : json({ MediaContainer: { Directory: server.sections } });
    }

    const section = /^\/library\/sections\/([^/]+)\/all$/.exec(url.pathname)?.[1];
    const all = section === undefined ? undefined : server.items?.[section];
    if (all === undefined) return missing;

    const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
    if (start > 0 && server.failAfterFirstPage?.includes(section as string)) {
      return new Response("boom", { status: 500 });
    }
    if (server.ignorePaging) return json({ MediaContainer: { size: all.length, Metadata: all } });

    const size = Number(url.searchParams.get("X-Plex-Container-Size") ?? String(all.length));
    const page = all.slice(start, start + size);
    return json({
      MediaContainer: { offset: start, size: page.length, totalSize: all.length, Metadata: page },
    });
  }) as typeof fetch;
}

const SERVER: FakeServer = {
  machineIdentifier: MACHINE_ID,
  sections: SECTIONS,
  items: { "1": MOVIES, "2": SHOWS },
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
      const client = new PlexClient("http://plex.test:32400", "tok", fakePlex(SERVER));
      const res = await syncPlex(store, client);

      expect(res.error).toBeUndefined();
      expect(res.items).toBe(3);
      expect(store.plexMap().get("tt0092494")).toBe("27807");
      expect(store.plexMap().get("tt13016388")).toBe("10643");
      expect(store.plexMachineIdentifier()).toBe(MACHINE_ID);
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
      const client = new PlexClient("http://plex.test:32400", "tok", fakePlex(SERVER));
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
        fakePlex(SERVER, (p) => calls.push(p)),
      );
      await syncPlex(store, client);
      expect(calls.filter((c) => c.includes("/all")).map((c) => c.split("?")[0])).toEqual([
        "/library/sections/1/all",
        "/library/sections/2/all",
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
        fakePlex(SERVER, (p) => calls.push(p)),
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
      const good = new PlexClient("http://plex.test:32400", "tok", fakePlex(SERVER));
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
      await syncPlex(store, new PlexClient("http://x:32400", "tok", fakePlex(SERVER)));
      expect(store.plexMap().has("tt0322259")).toBe(true);

      const fewer: FakeServer = { ...SERVER, items: { ...SERVER.items, "1": [MOVIES[0]] } };
      await syncPlex(store, new PlexClient("http://x:32400", "tok", fakePlex(fewer)));

      expect(store.plexMap().has("tt0322259")).toBe(false);
      expect(store.plexMap().has("tt0092494")).toBe(true);
    } finally {
      cleanup();
    }
  });

  // --- the walk is paged, and every way it can end -------------------------

  /**
   * Twelve hundred items so the walk has to make three requests at `PAGE_SIZE` 500, plus one
   * that is deliberately unmatched -- a page boundary is exactly where an off-by-one would
   * silently drop or duplicate a title.
   */
  const many = Array.from({ length: 1200 }, (_, i) => ({
    ratingKey: String(100000 + i),
    Guid: [{ id: `imdb://tt${String(9000000 + i)}` }],
  }));

  test("a section larger than one page is walked whole, in order and without repeats", async () => {
    const { store, cleanup } = tempStore();
    const calls: string[] = [];
    try {
      const server: FakeServer = { ...SERVER, items: { "1": many, "2": [] } };
      await syncPlex(
        store,
        new PlexClient(
          "http://x:32400",
          "tok",
          fakePlex(server, (p) => calls.push(p)),
        ),
      );

      expect(store.plexCount()).toBe(1200);
      expect(store.plexMap().get("tt9000000")).toBe("100000");
      expect(store.plexMap().get("tt9001199")).toBe("101199");

      // Three pages for section 1, one for the empty section 2. The empty section still costs
      // one request -- there is no way to know it is empty without asking.
      expect(calls.filter((c) => c.startsWith("/library/sections/1/all"))).toHaveLength(3);
      expect(calls.filter((c) => c.includes("X-Plex-Container-Start=0"))).toHaveLength(2);
      expect(calls.some((c) => c.includes("X-Plex-Container-Start=500"))).toBe(true);
      expect(calls.some((c) => c.includes("X-Plex-Container-Start=1000"))).toBe(true);
      expect(calls.some((c) => c.includes("X-Plex-Container-Start=1200"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  /**
   * THE LOOP MUST TERMINATE AGAINST A SERVER THAT IGNORES THE PARAMETERS.
   *
   * The live PMS honours them (measured 2026-09-07) but an older one, or something proxying
   * for it, may not -- and the failure shape there is not a wrong answer, it is asking for
   * offset 500 of a list it already has in full, forever. Falling back to what the response
   * actually held is what makes that case one request and a correct mirror.
   */
  test("a server that ignores the paging parameters is asked exactly once per section", async () => {
    const { store, cleanup } = tempStore();
    const calls: string[] = [];
    try {
      const server: FakeServer = { ...SERVER, items: { "1": many, "2": [] }, ignorePaging: true };
      await syncPlex(
        store,
        new PlexClient(
          "http://x:32400",
          "tok",
          fakePlex(server, (p) => calls.push(p)),
        ),
      );

      expect(store.plexCount()).toBe(1200);
      expect(calls.filter((c) => c.startsWith("/library/sections/1/all"))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  /**
   * Paging gives the walk more places to fail, so the rule the whole mirror rests on is
   * asserted at the new one too: a second page that 500s must leave the mirror it already
   * had, not a half-written one.
   */
  test("a page that fails midway leaves the previous mirror standing", async () => {
    const { store, cleanup } = tempStore();
    try {
      await syncPlex(store, new PlexClient("http://x:32400", "tok", fakePlex(SERVER)));
      expect(store.plexCount()).toBe(3);

      const flaky: FakeServer = {
        ...SERVER,
        items: { "1": many, "2": [] },
        failAfterFirstPage: ["1"],
      };
      const res = await syncPlex(store, new PlexClient("http://x:32400", "tok", fakePlex(flaky)));

      expect(res.error).toContain("plex");
      expect(store.plexCount()).toBe(3);
      expect(store.plexMap().get("tt0092494")).toBe("27807");
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
    return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: MACHINE_ID } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  await client.machineIdentifier();

  expect(seen[0]?.token).toBe("s3cret");
  expect(seen[0]?.url).not.toContain("s3cret");
});
