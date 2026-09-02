/**
 * The vocabulary, the derivation, and the fuzzy join -- the three places this feature can
 * ship a confident lie.
 *
 * Everything under test is pure, so there is no store, no server and no clock here.
 */

import { describe, expect, test } from "bun:test";
import type { QueueItem } from "./arr";
import type { ProwlarrHistoryRecord } from "./prowlarr";
import {
  downloadProgressOf,
  evidenceLine,
  formatRemaining,
  matchesRequestedTitle,
  type RequestDiagnostic,
  type RequestVerdict,
  requestStateOf,
  searchEvidenceFor,
  VERDICT_COPY,
  verdictFor,
} from "./request-diagnostics";
import type { MediaRequest, RequestStatus } from "./store";

const req = (status: RequestStatus) => ({ status }) as Pick<MediaRequest, "status">;

describe("the verdict vocabulary", () => {
  test("every verdict has words -- nothing reaches a reader as a raw enum string", () => {
    for (const [verdict, copy] of Object.entries(VERDICT_COPY)) {
      expect(copy.label.length, verdict).toBeGreaterThan(0);
      expect(copy.sentence.length, verdict).toBeGreaterThan(0);
    }
  });

  /**
   * The one claim the copy is not entitled to make. Prowlarr's history is keyed by query
   * string, so a count is fuzzy by construction -- see `matchesRequestedTitle`.
   */
  test("no sentence claims a number of searches", () => {
    for (const [verdict, copy] of Object.entries(VERDICT_COPY)) {
      expect(copy.sentence, verdict).not.toMatch(/\d/);
    }
  });
});

describe("deriving a verdict from status and evidence", () => {
  test("the statuses that need no evidence", () => {
    const expected: [RequestStatus, RequestVerdict][] = [
      ["queued", "queued"],
      ["sent", "searching"],
      ["grabbed", "downloading"],
      ["downloading", "downloading"],
      ["available", "imported"],
      ["failed", "failed"],
    ];
    for (const [status, verdict] of expected) {
      expect(verdictFor(req(status), null), status).toBe(verdict);
    }
  });

  test("a given-up request with releases on the indexers is NOT 'nothing exists'", () => {
    expect(verdictFor(req("no_release"), { releases_seen: 12 })).toBe("nothing_accepted");
  });

  test("a given-up request the indexers genuinely had nothing for", () => {
    expect(verdictFor(req("no_release"), { releases_seen: 0 })).toBe("no_releases");
  });

  /**
   * The honesty limit, pinned: an unknown count must never become the confident verdict.
   * Both shapes of "we do not know" -- no diagnostic row at all, and a row whose count
   * never arrived -- fall back to the narrower answer.
   */
  test("an unknown release count falls back to the narrow verdict, never the confident one", () => {
    expect(verdictFor(req("no_release"), null)).toBe("no_releases");
    expect(verdictFor(req("no_release"), { releases_seen: null })).toBe("no_releases");
  });

  /**
   * The 24-hour patience rule lives in the worker. A request that is still `sent` says so
   * however much evidence has piled up -- otherwise "long enough to give up" would have
   * two definitions.
   */
  test("evidence never overrules a request that is still being worked on", () => {
    expect(verdictFor(req("sent"), { releases_seen: 40 })).toBe("searching");
    expect(verdictFor(req("sent"), { releases_seen: 0 })).toBe("searching");
  });
});

describe("the one supporting fact under a verdict", () => {
  const evidence = (over: Partial<RequestDiagnostic> = {}): RequestDiagnostic =>
    ({ grabbed_quality: null, indexers_searched: null, ...over }) as RequestDiagnostic;

  test("a download says what was taken", () => {
    expect(evidenceLine("downloading", evidence({ grabbed_quality: "Bluray-1080p" }))).toBe(
      "Grabbed as Bluray-1080p",
    );
    expect(evidenceLine("imported", evidence({ grabbed_quality: "WEBDL-1080p" }))).toBe(
      "Grabbed as WEBDL-1080p",
    );
  });

  /** "No releases found" is a claim; how many indexers were asked is what backs it. */
  test("a dead end says how many indexers were asked, and counts one properly", () => {
    expect(evidenceLine("no_releases", evidence({ indexers_searched: 3 }))).toBe("Asked 3 indexers");
    expect(evidenceLine("nothing_accepted", evidence({ indexers_searched: 1 }))).toBe("Asked 1 indexer");
  });

  test("nothing to say is null, never an empty line", () => {
    expect(evidenceLine("searching", evidence({ indexers_searched: 3 }))).toBeNull();
    expect(evidenceLine("downloading", evidence())).toBeNull();
    expect(evidenceLine("no_releases", evidence({ indexers_searched: 0 }))).toBeNull();
    expect(evidenceLine("no_releases", null)).toBeNull();
  });

  /**
   * A COUNT and never the NAMES. finderr is internet-facing and somebody's private
   * trackers are the same class of fact as the root folder paths `safeArrMessage` keeps
   * off the wire, so nothing here may grow a name.
   */
  test("the indexers are counted, never named", () => {
    expect(evidenceLine("no_releases", evidence({ indexers_searched: 2 }))).not.toMatch(/[A-Z][a-z]+bits/);
  });
});

describe("the whole view of one request", () => {
  test("a title nobody asked for is all nulls, not an absent object", () => {
    expect(requestStateOf(null, null)).toEqual({
      requestVerdict: null,
      requestProgress: null,
      requestEtaAt: null,
      requestEvidence: null,
    });
  });

  test("verdict, bar, ETA and the supporting fact, in one shape", () => {
    const diagnostic = {
      download_progress: 0.62,
      eta_at: "2026-09-02T14:06:00Z",
      grabbed_quality: "Bluray-1080p",
      indexers_searched: 2,
      releases_seen: 7,
    } as RequestDiagnostic;

    expect(requestStateOf(req("downloading"), diagnostic)).toEqual({
      requestVerdict: "downloading",
      requestProgress: 0.62,
      requestEtaAt: "2026-09-02T14:06:00Z",
      requestEvidence: "Grabbed as Bluray-1080p",
    });
  });

  test("a request with no evidence row still has a verdict", () => {
    expect(requestStateOf(req("sent"), null).requestVerdict).toBe("searching");
  });
});

describe("live download progress", () => {
  const item = (size: number, sizeleft: number, eta?: string): QueueItem =>
    ({ id: 1, title: "x", status: "downloading", size, sizeleft, estimatedCompletionTime: eta }) as QueueItem;

  test("the fraction already downloaded, with the arr's own completion instant", () => {
    const { progress, etaAt } = downloadProgressOf([item(1000, 380, "2026-09-02T14:06:00Z")]);
    expect(progress).toBeCloseTo(0.62, 5);
    expect(etaAt).toBe("2026-09-02T14:06:00Z");
  });

  test("a size we cannot divide by yields no bar rather than a wrong one", () => {
    expect(downloadProgressOf([item(0, 0)]).progress).toBeNull();
    expect(downloadProgressOf([]).progress).toBeNull();
  });

  /** An arr briefly reports sizeleft above size while verifying; -3% is a bug report. */
  test("clamped at both ends", () => {
    expect(downloadProgressOf([item(1000, 1200)]).progress).toBe(0);
    expect(downloadProgressOf([item(1000, -50)]).progress).toBe(1);
  });

  test("no completion estimate is null, not a guess", () => {
    expect(downloadProgressOf([item(1000, 500)]).etaAt).toBeNull();
  });

  /** Four episodes of one series are one ask, so they are one bar. */
  test("several queue rows for one item sum into a single bar", () => {
    const { progress } = downloadProgressOf([item(1000, 0), item(1000, 500), item(2000, 2000)]);
    expect(progress).toBeCloseTo(1500 / 4000, 5);
  });

  test("the ETA is the LAST of them to land, compared as instants and not as text", () => {
    const { etaAt } = downloadProgressOf([
      item(1000, 500, "2026-09-02T21:00:00+07:00"), // 14:00Z
      item(1000, 500, "2026-09-02T15:00:00Z"),
    ]);
    expect(etaAt).toBe("2026-09-02T15:00:00Z");
  });
});

describe("saying how long is left", () => {
  test("rounds to units a person would use", () => {
    expect(formatRemaining(20_000)).toBe("under a minute");
    expect(formatRemaining(4 * 60_000)).toBe("4 min");
    expect(formatRemaining(60 * 60_000)).toBe("1 h");
    expect(formatRemaining(72 * 60_000)).toBe("1 h 12 min");
    expect(formatRemaining(50 * 60 * 60_000)).toBe("about 2 days");
  });

  /** A stalled download's estimate expires. Counting up past it reads as broken. */
  test("an estimate already in the past draws nothing", () => {
    expect(formatRemaining(-1)).toBeNull();
    expect(formatRemaining(0)).toBeNull();
    expect(formatRemaining(Number.NaN)).toBeNull();
  });
});

describe("joining a Prowlarr query to a requested title", () => {
  test("the query as the arrs actually send it", () => {
    expect(matchesRequestedTitle("Sicario", "Sicario")).toBe(true);
    expect(matchesRequestedTitle("Sicario", "Sicario 2015")).toBe(true);
    expect(matchesRequestedTitle("Preacher", "Preacher S01E02")).toBe(true);
    expect(matchesRequestedTitle("The Matrix", "Matrix 1999")).toBe(true);
  });

  test("punctuation and accents fold on both sides", () => {
    expect(matchesRequestedTitle("WALL·E", "Wall E 2008")).toBe(true);
    expect(matchesRequestedTitle("Låt den rätte komma in", "Lat den ratte komma in 2008")).toBe(true);
  });

  /**
   * A KNOWN MISS, pinned so it is a documented limit rather than a surprise. `normalize`
   * folds "Alien³" to "alien3" with no space, while an arr searches "Alien 3" -- so the
   * prefix never matches and this title's verdict stays at the narrower `searching`.
   * Under-reporting is the safe direction, which is why it is documented rather than
   * patched with a rule about digits next to letters.
   */
  test("a superscript numeral folded against a spaced one does not join", () => {
    expect(matchesRequestedTitle("Alien³", "Alien 3")).toBe(false);
  });

  test("a different title does not match", () => {
    expect(matchesRequestedTitle("Sicario", "Arrival 2016")).toBe(false);
    // A word boundary is required, or every "Us" would match every "Usual Suspects".
    expect(matchesRequestedTitle("Us", "Usual Suspects")).toBe(false);
  });

  test("short titles join as reliably as long ones", () => {
    expect(matchesRequestedTitle("Us", "Us 2019")).toBe(true);
  });

  /**
   * The accepted mis-attribution, pinned so nobody 'fixes' it into a threshold. It is why
   * the copy says "has anything been found" and never "searched N times".
   */
  test("a title that prefixes another WILL claim its searches -- documented, not a bug", () => {
    expect(matchesRequestedTitle("Sicario", "Sicario Day of the Soldado")).toBe(true);
  });

  test("an empty side never matches", () => {
    expect(matchesRequestedTitle("Sicario", undefined)).toBe(false);
    expect(matchesRequestedTitle("", "Sicario")).toBe(false);
  });
});

describe("reading Prowlarr's history for one title", () => {
  const query = (over: Partial<ProwlarrHistoryRecord> = {}): ProwlarrHistoryRecord => ({
    eventType: "indexerQuery",
    date: "2026-09-02T12:00:00Z",
    indexerId: 1,
    data: { query: "Sicario 2015", queryResults: "0" },
    ...over,
  });
  const target = { title: "Sicario", sinceIso: "2026-09-02T10:00:00Z" };

  test("counts distinct indexers and keeps the largest result count", () => {
    const ev = searchEvidenceFor(
      [
        query({ indexerId: 1, data: { query: "Sicario 2015", queryResults: "3" } }),
        query({ indexerId: 2, data: { query: "Sicario 2015", queryResults: "7" } }),
        query({ indexerId: 2, data: { query: "Sicario 2015", queryResults: "5" } }),
      ],
      target,
    );
    expect(ev.indexers).toBe(2);
    // The MAX, never the sum: the same release comes back from every indexer that has it.
    expect(ev.releasesSeen).toBe(7);
  });

  test("an RSS poll is not a search anybody asked for", () => {
    const ev = searchEvidenceFor([query({ eventType: "indexerRss" })], target);
    expect(ev).toEqual({ indexers: 0, releasesSeen: null });
  });

  test("a search for another title is ignored", () => {
    const ev = searchEvidenceFor([query({ data: { query: "Arrival 2016", queryResults: "9" } })], target);
    expect(ev.releasesSeen).toBeNull();
  });

  test("a search that ran before the request cannot be about it", () => {
    const ev = searchEvidenceFor([query({ date: "2026-09-01T09:00:00Z" })], target);
    expect(ev.indexers).toBe(0);
  });

  /** `"0"` is a real answer; a missing key is not. Only the first may become a verdict. */
  test("a zero count is evidence, a missing count is not", () => {
    expect(searchEvidenceFor([query()], target).releasesSeen).toBe(0);
    expect(searchEvidenceFor([query({ data: { query: "Sicario 2015" } })], target).releasesSeen).toBeNull();
  });

  test("an undated record is dropped rather than assumed recent", () => {
    expect(searchEvidenceFor([query({ date: undefined })], target).indexers).toBe(0);
  });
});
