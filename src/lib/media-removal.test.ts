import { describe, expect, test } from "bun:test";
import { isRemovable } from "./media-removal";
import { isWithdrawable } from "./request-withdrawal";
import type { RequestStatus } from "./store";

/**
 * The two rules that decide which destructive verb a request row earns, asserted TOGETHER.
 *
 * Separately they are each one comparison and hardly worth a test. What is worth pinning is
 * the relationship: a reader must never be offered both Withdraw and Remove on one row, and
 * the pair must never leave a live request with neither. Those are properties of the two
 * functions at once, and neither file can state it alone.
 */

const EVERY_STATUS: RequestStatus[] = [
  "queued",
  "sent",
  "grabbed",
  "downloading",
  "available",
  "failed",
  "no_release",
  "manual_import",
  "removed",
];

describe("which requests have media to take back out", () => {
  test("only one that arrived", () => {
    expect(isRemovable("available")).toBe(true);
  });

  /*
    A partly-downloaded series has files on disk and is still an ask in flight. Offering to
    delete it would offer to delete a work in progress, and calling it off is what Withdraw
    already does -- without touching anything on a disk.
  */
  test("nothing still in flight, and nothing that already went", () => {
    for (const status of EVERY_STATUS) {
      if (status === "available") continue;
      expect(isRemovable(status), status).toBe(false);
    }
  });
});

describe("the two verbs partition the lifecycle", () => {
  /*
    THE DEFECT THIS PINS: a row offering both, which would let one click call off an ask and
    the next delete the file it just stopped waiting for. They are opposite ends of a
    request's life and no status is at both ends.
  */
  test("no status is both withdrawable and removable", () => {
    for (const status of EVERY_STATUS) {
      expect(isWithdrawable(status) && isRemovable(status), status).toBe(false);
    }
  });

  /*
    `removed` is the ONE status with neither, and that is the design rather than a gap: the
    media is gone and the row is the record of an admin having removed it. Withdrawing would
    delete the log entry that explains where a household's film went, and there is nothing
    left to remove. Asking for the title again is what revives it.
  */
  test("every status except `removed` earns exactly one of them", () => {
    for (const status of EVERY_STATUS) {
      const offered = Number(isWithdrawable(status)) + Number(isRemovable(status));
      expect(offered, status).toBe(status === "removed" ? 0 : 1);
    }
  });
});
