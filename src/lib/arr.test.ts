import { afterEach, describe, expect, test } from "bun:test";
import { RadarrClient, SonarrClient } from "./arr";
import type { ArrService } from "./config";

/**
 * WHAT ACTUALLY GOES ON THE WIRE when finderr stops searching for something.
 *
 * The withdraw feature's whole safety claim is "it never deletes anything", and that claim
 * lives in an HTTP verb rather than in a branch anybody can read. So it is asserted at the
 * transport: the real client, a stubbed `fetch`, and the recorded method, URL and body.
 * Testing `withdrawRequest` against a mock client cannot see any of that -- it would prove
 * only that we called the method we named.
 */

const svc: ArrService = { url: "http://arr.test:7878", apiKey: "k", rootFolder: "/m", qualityProfileId: 4 };

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Swap `fetch` for a recorder that answers every call with an arr's empty 200. */
function recording(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return sent;
}

describe("unmonitor is a PUT to the editor, and cannot express a delete", () => {
  test("Radarr is asked to unmonitor one movie id", async () => {
    const sent = recording();

    await new RadarrClient(svc).unmonitor(42);

    expect(sent).toEqual([
      {
        method: "PUT",
        url: "http://arr.test:7878/api/v3/movie/editor",
        body: { movieIds: [42], monitored: false },
      },
    ]);
  });

  test("Sonarr is asked to unmonitor one series id", async () => {
    const sent = recording();

    await new SonarrClient({ ...svc, url: "http://arr.test:8989" }).unmonitor(7);

    expect(sent).toEqual([
      {
        method: "PUT",
        url: "http://arr.test:8989/api/v3/series/editor",
        body: { seriesIds: [7], monitored: false },
      },
    ]);
  });

  /*
    THE ACCEPTANCE THIS CARD WAS WRITTEN AROUND.

    Radarr's `MovieEditorController` and Sonarr's `SeriesEditorController` both expose the
    destructive form of this path as `[HttpDelete]`, a separate action that alone reads
    `deleteFiles`. So the two facts below -- the verb is PUT, and no delete-shaped field is
    ever sent -- are together the whole proof that withdrawing cannot remove media.
  */
  test("no request carries DELETE, deleteFiles or an import exclusion", async () => {
    const sent = recording();

    await new RadarrClient(svc).unmonitor(42);
    await new SonarrClient({ ...svc, url: "http://arr.test:8989" }).unmonitor(7);

    for (const call of sent) {
      expect(call.method).toBe("PUT");
      expect(Object.keys(call.body as object)).toEqual(expect.not.arrayContaining(["deleteFiles"]));
      expect(Object.keys(call.body as object)).toEqual(
        expect.not.arrayContaining(["addImportExclusion", "addImportListExclusion"]),
      );
    }
  });
});

/**
 * The OTHER half of that claim: the one call in this file that CAN delete, asserted at the
 * same transport and for the same reason. `removeMedia` against a mock client would prove
 * only that we called the method we named -- what matters is the verb, the id in the path,
 * and which flags ride along in the query.
 */
describe("removing media is a DELETE, and it never adds an import exclusion", () => {
  const sonarrSvc: ArrService = { ...svc, url: "http://arr.test:8989" };

  test("Radarr is asked to delete one movie, files and all", async () => {
    const sent = recording();

    await new RadarrClient(svc).remove(42, { deleteFiles: true });

    expect(sent).toEqual([
      {
        method: "DELETE",
        url: "http://arr.test:7878/api/v3/movie/42?deleteFiles=true&addImportExclusion=false",
        body: undefined,
      },
    ]);
  });

  test("Sonarr is asked to delete one series and KEEP the files", async () => {
    const sent = recording();

    await new SonarrClient(sonarrSvc).remove(7, { deleteFiles: false });

    expect(sent).toEqual([
      {
        method: "DELETE",
        url: "http://arr.test:8989/api/v3/series/7?deleteFiles=false&addImportListExclusion=false",
        body: undefined,
      },
    ]);
  });

  /*
    THE FLAG THAT WOULD BE INVISIBLE IF IT LEAKED.

    An import exclusion is permanent, undoable only in the arr's own settings, and its effect
    -- a later request for the title silently getting nothing -- looks exactly like an indexer
    having no release. Both arrs default it to false, so a regression here would ship green;
    sending it explicitly is what makes the intent assertable.
  */
  test("neither service is ever asked to blocklist the title", async () => {
    const sent = recording();

    await new RadarrClient(svc).remove(42, { deleteFiles: true });
    await new SonarrClient(sonarrSvc).remove(7, { deleteFiles: true });

    for (const call of sent) {
      expect(new URL(call.url).searchParams.get("addImportExclusion")).not.toBe("true");
      expect(new URL(call.url).searchParams.get("addImportListExclusion")).not.toBe("true");
    }
  });
});

/** Answer one GET with a body, so a holdings read has something to parse. */
function answering(body: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(input), body: undefined });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return sent;
}

describe("what the arr says it is holding, for the confirmation", () => {
  test("Radarr answers a film as one file with a size and a quality name", async () => {
    answering({
      hasFile: true,
      sizeOnDisk: 13_000_000_000,
      movieFile: { quality: { quality: { name: "Bluray-1080p" } } },
    });

    expect(await new RadarrClient(svc).holdings(42)).toEqual({
      files: 1,
      bytes: 13_000_000_000,
      quality: "Bluray-1080p",
    });
  });

  /*
    A series holds one quality per episode file, so there is no single answer and inventing
    one would be a fact about ninety other files. Null is the honest reading.
  */
  test("Sonarr answers a series from its statistics, with no quality at all", async () => {
    answering({ statistics: { episodeFileCount: 62, sizeOnDisk: 400_000_000_000 } });

    expect(await new SonarrClient({ ...svc, url: "http://arr.test:8989" }).holdings(7)).toEqual({
      files: 62,
      bytes: 400_000_000_000,
      quality: null,
    });
  });

  /*
    A 404 is the arr saying it does not hold that row -- somebody removed it by hand. That is
    an ANSWER, and the caller about to delete it needs it rather than an exception.
  */
  test("a row the arr no longer has reads as null rather than throwing", async () => {
    answering({ message: "NotFound" }, 404);

    expect(await new RadarrClient(svc).holdings(42)).toBeNull();
  });

  test("a film with no file at all is zero files, not a missing answer", async () => {
    answering({ hasFile: false, sizeOnDisk: 0 });

    expect(await new RadarrClient(svc).holdings(42)).toEqual({ files: 0, bytes: 0, quality: null });
  });
});
