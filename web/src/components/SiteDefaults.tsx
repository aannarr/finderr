/**
 * The settings that apply to EVERYBODY, on `/admin`.
 *
 * The per-person twins live on `/admin/users/:id` and use the same two controls, so the only
 * thing that differs here is what the words say the number binds. Both were env-only before
 * this screen existed, which meant editing a file on the host and restarting the container to
 * lower a daily limit.
 *
 * > [!IMPORTANT] Saving a value here takes the environment out of the decision, permanently
 * > `FINDERR_REQUEST_QUOTA_PER_DAY` SEEDS the quota and stops mattering the moment an operator
 * > saves one. That is the trade a settable setting makes -- a value you can change from a web
 * > page cannot also be one a container restart silently overrules -- and the hint under the
 * > field says so, because the alternative is somebody editing `.env` and watching it do
 * > nothing. `src/lib/site-settings.ts` owns the rule.
 *
 * Renders from PROPS and returns the save to the caller, like `AdminUserView`: what it draws
 * can then be asserted without a fetch, and the page above it owns the reload.
 */

import type { SiteSettings } from "../lib/auth-api";
import { AdminCard } from "./admin/AdminCard";
import { QuotaField, ToggleSetting } from "./SettingControls";
import { Separator } from "./ui/separator";

export function SiteDefaults(props: {
  settings: SiteSettings;
  /** Save a partial change and redraw. Rejecting puts the server's words on the control. */
  save: (changes: Partial<SiteSettings>) => Promise<void>;
}) {
  const { requestQuotaPerDay, assistantAllowedByDefault } = props.settings;

  return (
    <AdminCard
      title="Site defaults"
      description="What applies to everybody who has no allowance of their own."
    >
      <div className="flex flex-col gap-5">
        {/*
          NO `inheritLabel`, and that is the one difference between the two callers: there is
          nothing above a site default for it to follow.
        */}
        <QuotaField
          id="site-quota"
          label="Daily request limit"
          value={requestQuotaPerDay}
          save={(n) => props.save({ requestQuotaPerDay: n ?? 0 })}
        >
          Applies to everybody without an allowance of their own; administrators are never limited. Saving
          this replaces whatever FINDERR_REQUEST_QUOTA_PER_DAY was set to on the host.
        </QuotaField>

        <Separator />

        <ToggleSetting
          label="Assistant for new accounts"
          on={assistantAllowedByDefault}
          action={(on) => (on ? "Turn off for new accounts" : "Turn on for new accounts")}
          save={(on) => props.save({ assistantAllowedByDefault: on })}
        >
          {assistantAllowedByDefault
            ? "Somebody who joins can ask the assistant, which sends their question to a model outside this house."
            : "Somebody who joins gets no assistant until you turn it on for them."}{" "}
          {/*
          THE SURPRISING HALF, said out loud rather than left to be discovered. `assistant_allowed`
          is NOT NULL on every existing row, so there is no state meaning "follow the site" for
          this switch to reach -- it decides what the NEXT account starts at and nothing else.
        */}
          This applies to accounts made from now on; everybody already here keeps what they have, which you
          change on their own page.
        </ToggleSetting>
      </div>
    </AdminCard>
  );
}
