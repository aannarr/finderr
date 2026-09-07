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

import { Bot } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { type AgentKeySummary, getAgentKey, revokeAgentKey } from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { ConfirmAction } from "./ConfirmAction";
import { Empty, Row, Rows, Section } from "./settings/Section";
import { Button } from "./ui/button";

/**
 * The one key, as a row -- so Revoke sits beside the thing it destroys rather than on the
 * section's rule, and so the shape is already right when there are several of them.
 */
function AgentKeyRow({ agentKey, onRevoke }: { agentKey: AgentKeySummary; onRevoke: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  return (
    <Row
      icon={<Bot aria-hidden="true" />}
      title={agentKey.readOnly ? "Read-only key" : "Read and write key"}
      meta={
        asking ? (
          <span className="text-ink">Anything using it stops working immediately.</span>
        ) : (
          `added ${formatStamp(agentKey.createdAt, "never")} · last used ${formatStamp(agentKey.lastUsedAt, "never")}`
        )
      }
      // The one thing on this page that can act WITHOUT a browser, stated where the key is
      // rather than in a paragraph under the section.
      note={
        !agentKey.readOnly ? "It can start real downloads on your behalf, in that agent's history" : undefined
      }
      action={
        <ConfirmAction
          variant="inline"
          onAskingChange={setAsking}
          label="Revoke"
          question="Anything using it stops working immediately."
          confirmLabel="Yes, revoke"
          busyLabel="Revoking…"
          onConfirm={onRevoke}
        />
      }
    />
  );
}

/**
 * The create flow, LAZY.
 *
 * It is the rarest thing on `/account` and it pulls in the whole Radix dialog; a reader who
 * never makes a key never downloads it. `lazy` at module scope rather than inside the
 * component, or every render would start a new import.
 */
const AgentKeyDialog = lazy(() => import("./AgentKeyDialog"));

export function AgentKeyPanel() {
  const [key, setKey] = useState<AgentKeySummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKey((await getAgentKey()).key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    setError(null);
    await revokeAgentKey();
    setKey(null);
  };

  if (!loaded) return null;

  return (
    <Section
      label="Automation"
      /*
        ZONE 1: additive only, and UNDER the list. Two things moved here on 2026-09-07 and
        both were placement bugs the zone rules made nameable:

        - REVOKE was up here beside Create. A destructive verb on a section's rule is the one
          control a reader can press having read a noun and nothing else. It is a row action
          now, beside the key it destroys.
        - CREATE was pinned top-right, two thousand pixels from this list on a wide screen.
          See the zone-1 caution in `settings/Section.tsx`.
      */
      add={
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          {key ? "Replace this key" : "Create a key"}
        </Button>
      }
    >
      {key ? (
        <Rows>
          <AgentKeyRow agentKey={key} onRevoke={revoke} />
        </Rows>
      ) : (
        /*
          ONE sentence, and the button underneath is the call to action.

          What used to be here was three stacked paragraphs and a floating `Read-only`
          checkbox whose Create button was off at the other edge of the screen -- aannarr,
          2026-09-07: *"is this readonly, what is that? is that not PER KEY?"*. It is per key,
          and everything about the key being made now lives in the dialog that makes it.
        */
        <Empty>
          No key yet. One lets a script or an AI agent search, browse and request on your behalf, without a
          browser.
        </Empty>
      )}

      {/* A refusal, drawn as one -- it was the same grey as the explanatory lines around it. */}
      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {/*
        Mounted only once somebody has asked for it, so the chunk is fetched on the click
        rather than on every page load. No fallback: the dialog IS the visible response to
        pressing the button, and a spinner in its place would be a second thing appearing.
      */}
      {creating && (
        <Suspense fallback={null}>
          <AgentKeyDialog
            open={creating}
            replacing={key !== null}
            onOpenChange={setCreating}
            onCreated={load}
          />
        </Suspense>
      )}
    </Section>
  );
}
