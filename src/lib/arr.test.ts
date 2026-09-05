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
