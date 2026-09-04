/**
 * Printing an instant.
 *
 * Every assertion passes an explicit locale: `Intl` with none follows whatever machine is
 * running the suite, so a string comparison is otherwise green here and red on a colleague's
 * laptop.
 */

import { describe, expect, test } from "bun:test";
import { formatAge, formatStamp } from "./timestamps";

const NOW = new Date("2026-09-04T12:00:00.000Z");

describe("a stamp as a date", () => {
  /*
    Matched rather than compared, and the reason is worth knowing before tightening it:
    the abbreviated month is the ICU data's call, not ours. Bun's bundled ICU prints "Sep"
    for `en-GB` where a browser's prints "Sept", so an equality assertion here is green in
    the suite and red in the product -- or the other way round on a colleague's build.
  */
  test("prints the calendar date in the reader's own language", () => {
    expect(formatStamp("2026-09-04T12:00:00.000Z", "—", "en-GB")).toMatch(/^4 Sept?\.? 2026$/);
  });

  /*
    The fallback is a PARAMETER because the honest answer differs per caller: a session that
    has never been used is "never", an empty cell in a table is a dash. That difference is
    what used to be three copies of this function.
  */
  test("an absent stamp reads as whatever the caller says it means", () => {
    expect(formatStamp(null, "never", "en-GB")).toBe("never");
    expect(formatStamp(undefined, "—", "en-GB")).toBe("—");
  });

  /** `Intl` prints "Invalid Date" for a bad string, which is a bug report rendered as content. */
  test("an unparseable stamp falls back rather than printing Invalid Date", () => {
    expect(formatStamp("not a date", "—", "en-GB")).toBe("—");
  });
});

describe("a stamp as an age", () => {
  test("counts back in the largest unit that is still true", () => {
    expect(formatAge("2026-09-01T12:00:00.000Z", NOW, "en-GB")).toBe("3 days ago");
    expect(formatAge("2026-09-04T09:00:00.000Z", NOW, "en-GB")).toBe("3 hours ago");
    expect(formatAge("2026-08-04T12:00:00.000Z", NOW, "en-GB")).toBe("last month");
  });

  /** Anything we could print here is stale by the time it is read. */
  test("under a minute is just now, in both directions", () => {
    expect(formatAge("2026-09-04T11:59:30.000Z", NOW, "en-GB")).toBe("just now");
    expect(formatAge("2026-09-04T12:00:30.000Z", NOW, "en-GB")).toBe("just now");
  });

  /** A request for an unreleased title can carry a date ahead of the clock. */
  test("a future instant reads forwards, not as a negative age", () => {
    expect(formatAge("2026-09-06T12:00:00.000Z", NOW, "en-GB")).toBe("in 2 days");
  });

  test("no stamp is null, so a caller can draw nothing rather than a dash it did not choose", () => {
    expect(formatAge(null, NOW, "en-GB")).toBe(null);
    expect(formatAge("not a date", NOW, "en-GB")).toBe(null);
  });
});
