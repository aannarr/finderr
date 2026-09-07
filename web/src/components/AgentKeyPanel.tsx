/**
 * Your one agent key, on the account page.
 *
 * > [!IMPORTANT] The deliverable is the SNIPPET, not the token
 * > What a person wants from this screen is something they can hand to an agent, so the
 * > server returns one copyable block: a sentence, and a `curl` that fetches the manifest
 * > with the key in an `Authorization` header. Everything else -- the operations, the
 * > examples, the rate limits, the quota -- is discovered from that one call, so nothing
 * > here restates any of it. A screen that listed the endpoints would be a second,
 * > hand-maintained copy of the API shape, which is exactly what the manifest exists to
 * > prevent.
 *
 * A `curl` rather than a bare URL is also the safer artefact: a bare URL is a thing people
 * paste into a browser, a chat or an issue without registering that they just published a
 * credential.
 *
 * ONE key per user, so there is no list here and no id anywhere -- creating replaces, which
 * is what "Replace" says on the button. The plaintext is shown exactly once, at that moment,
 * and the warning is on THIS screen rather than only in the manifest because the moment to
 * warn somebody is while the thing is still in front of them.
 */

import { useCallback, useEffect, useState } from "react";
import { type AgentKeySummary, createAgentKey, getAgentKey, revokeAgentKey } from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { AdminCard } from "./admin/AdminCard";
import { ConfirmAction } from "./ConfirmAction";
import { ShowOnceSecret } from "./ShowOnceSecret";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export function AgentKeyPanel() {
  const [key, setKey] = useState<AgentKeySummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  /** The bootstrap block, held only until this page is left. It is not fetchable again. */
  const [snippet, setSnippet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = (await getAgentKey()).key;
      setKey(found);
      // The box starts where the existing key already is, so "Replace" without touching it
      // keeps the kind you chose last time rather than silently promoting a read-only key.
      if (found) setReadOnly(found.readOnly);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await createAgentKey({ readOnly });
      setSnippet(made.snippet);
      setKey(made.key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setError(null);
    try {
      await revokeAgentKey();
      // The snippet goes with it. Leaving a dead credential on screen invites somebody to
      // copy one that no longer authenticates and then debug the wrong thing.
      setSnippet(null);
      setKey(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!loaded) return null;

  return (
    <AdminCard
      title="Agent key"
      action={
        <span className="flex shrink-0 gap-2">
          <Button type="button" size="sm" onClick={create} disabled={busy}>
            {key ? "Replace" : "Create"}
          </Button>
          {key && (
            /*
              The one destructive verb here, and it asks. Revoking is instant and total --
              whatever is holding that key stops working mid-run -- and it was one unguarded
              click beside a Replace button of identical weight.
            */
            <ConfirmAction
              label="Revoke"
              question="Revoke this key? Anything using it stops working immediately."
              confirmLabel="Yes, revoke"
              busyLabel="Revoking…"
              onConfirm={revoke}
            />
          )}
        </span>
      }
    >
      <p className="text-sm text-muted">
        {key
          ? `A ${key.readOnly ? "read-only" : "read-write"} key, added ${formatStamp(key.createdAt, "never")} · last used ${formatStamp(key.lastUsedAt, "never")}.`
          : "Lets a script or an AI agent search, browse and request on your behalf, without a browser."}
      </p>

      {/*
        The choice belongs BEFORE the key exists, because it is fixed for that key's life:
        one key per person means read-only is a property of the key rather than something to
        toggle later. Replacing with the box in the other state is how it changes.

        Control LEFT, words right -- the rule `SettingControls` states for these screens.
      */}
      <div className="mt-3 flex items-start gap-2.5">
        <Checkbox
          id="agent-key-read-only"
          checked={readOnly}
          onCheckedChange={(v) => setReadOnly(v === true)}
          className="mt-0.5 shrink-0"
        />
        <label htmlFor="agent-key-read-only" className="text-sm leading-5">
          Read-only — it can look, but it cannot request anything
        </label>
      </div>

      {snippet && (
        <ShowOnceSecret
          // One sentence differs between a read-only key and a read-write one, so it is a
          // clause rather than a second string: two nearly identical warnings are two
          // warnings to keep in step, and the one nobody updates is the scarier one.
          note={[
            "Give this to your agent now.",
            key?.readOnly ? null : "It can start real downloads on your behalf.",
            "It is shown once and cannot be recovered -- if it is lost, Replace makes a new one and the old key stops working immediately.",
          ]
            .filter(Boolean)
            .join(" ")}
          value={snippet}
        />
      )}

      {/*
        Said where it is true rather than only in the manifest: the person handing over a key
        is the one who can decide not to, and they cannot decide that after the fact.
      */}
      <p className="mt-2 text-xs text-muted">
        The key carries your access but never administration, and giving it to an agent puts it in that
        agent&rsquo;s history. Replace it if you stop trusting where it went.
      </p>

      {/* A refusal, drawn as one -- it was the same grey as the two explanatory lines above. */}
      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </AdminCard>
  );
}
