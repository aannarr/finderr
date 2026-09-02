/**
 * A secret the server cannot show again. Here it is, copy it now.
 *
 * Two screens hand out a credential that exists exactly once -- the invite link an admin
 * mints, and the agent-key bootstrap snippet -- and both owe the reader the same three
 * things: the value, a warning that this is the only time they will see it, and a way to get
 * it onto the clipboard. Written twice they would drift, and the half that drifts is the
 * warning.
 *
 * `whitespace-pre-wrap` because one of the two callers is multi-line and the other is not,
 * which is a difference in the VALUE rather than a reason for two components.
 */

import { LINK_BUTTON } from "../lib/ui";

export function ShowOnceSecret({ note, value }: { note: string; value: string }) {
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface px-3 py-2">
      <p className="text-xs text-muted">{note}</p>
      <code className="mt-1 block whitespace-pre-wrap break-all text-sm">{value}</code>
      {/*
        Optional chaining rather than a feature check that hides the button: the clipboard
        API needs a secure context, and finderr typically runs on a plain-http LAN address
        where it is simply absent. The value is selectable text either way, so the fallback
        is the reader's own hands rather than a missing control.
      */}
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(value)}
        className={LINK_BUTTON}
      >
        Copy
      </button>
    </div>
  );
}
