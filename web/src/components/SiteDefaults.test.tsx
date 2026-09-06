/**
 * The site defaults block, as markup.
 *
 * The controls themselves are driven in `SettingControls.test.tsx`; what belongs here is the
 * WORDS, because the words are the whole difference between this block and the per-person one
 * on `/admin/users/:id`, and two of them mislead an operator about what they just did if they
 * are wrong:
 *
 * - the assistant default applies to accounts made FROM NOW ON and to nobody who is already
 *   here, which nothing about a toggle labelled "Assistant" would suggest;
 * - saving the quota takes `FINDERR_REQUEST_QUOTA_PER_DAY` out of the decision permanently,
 *   so an operator who later edits `.env` and restarts sees nothing happen.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SiteSettings } from "../lib/auth-api";
import { SiteDefaults } from "./SiteDefaults";

const draw = (settings: SiteSettings) =>
  renderToStaticMarkup(<SiteDefaults settings={settings} save={async () => {}} />);

const settings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  requestQuotaPerDay: 5,
  assistantAllowedByDefault: true,
  ...over,
});

describe("the request quota", () => {
  test("the field holds the current value", () => {
    expect(draw(settings())).toContain('value="5"');
  });

  test("zero is drawn as a value and explained as no limit rather than as an empty field", () => {
    const html = draw(settings({ requestQuotaPerDay: 0 }));
    expect(html).toContain('value="0"');
    expect(html).toContain("Nobody is limited");
  });

  /** Otherwise an operator edits `.env`, restarts, and watches nothing happen. */
  test("it says that saving supersedes the environment variable", () => {
    expect(draw(settings())).toContain("FINDERR_REQUEST_QUOTA_PER_DAY");
  });
});

describe("the assistant default", () => {
  test("the button says who it affects, not just on or off", () => {
    expect(draw(settings({ assistantAllowedByDefault: true }))).toContain("Turn off for new accounts");
    expect(draw(settings({ assistantAllowedByDefault: false }))).toContain("Turn on for new accounts");
  });

  /**
   * THE SURPRISING HALF. `app_user.assistant_allowed` is NOT NULL, so there is no "follow the
   * site" state for existing accounts to sit in -- this decides what the NEXT account starts
   * at and touches nobody else. A toggle that did not say so would read as a switch for
   * everybody.
   */
  test("it says existing accounts are untouched, and where to change them", () => {
    const html = draw(settings());
    expect(html).toContain("accounts made from now on");
    expect(html).toContain("their own page");
  });
});
