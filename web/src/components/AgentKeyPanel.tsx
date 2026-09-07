/**
 * Your agent keys, on the account page.
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
 * > [!NOTE] IT WAS ONE KEY PER USER until 2026-09-07, and the list is what names buy
 * > With one key, two agents shared a credential: revoking the one that leaked killed the
 * > one that had not, and "last used" answered for both at once. A name is what turns a row
 * > into something you can decide about, which is why aannarr asked for one -- and a name
 * > only means anything when there is more than one thing to tell apart.
 */

import { Bot } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { type AgentKeySummary, getAgentKeys, renameAgentKey, revokeAgentKey } from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { ConfirmAction } from "./ConfirmAction";
import { ACTION_COL, Empty, Row, Rows, Section } from "./settings/Section";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The create flow, LAZY.
 *
 * It is the rarest thing on `/account` and it pulls in the whole Radix dialog; a reader who
 * never makes a key never downloads it. `lazy` at module scope rather than inside the
 * component, or every render would start a new import.
 */
const AgentKeyDialog = lazy(() => import("./AgentKeyDialog"));

/** What a key is CALLED, falling back to what it can do. Never an id -- that is plumbing. */
function keyTitle(key: AgentKeySummary): string {
  return key.name ?? (key.readOnly ? "Read-only key" : "Read and write key");
}

function AgentKeyRow({
  agentKey,
  onRename,
  onRevoke,
}: {
  agentKey: AgentKeySummary;
  onRename: () => void;
  onRevoke: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  /*
    The KIND moves into the metadata line once a key has a name, because the title is then
    the name and the kind is a fact about it. Without a name the title IS the kind, and
    repeating it underneath would be the row saying one thing twice.
  */
  const kind = agentKey.name ? (agentKey.readOnly ? "read-only" : "read and write") : null;

  return (
    <Row
      icon={<Bot aria-hidden="true" />}
      title={keyTitle(agentKey)}
      meta={
        asking ? (
          <span className="text-ink">Anything using it stops working immediately.</span>
        ) : (
          [
            kind,
            `added ${formatStamp(agentKey.createdAt, "never")}`,
            `last used ${formatStamp(agentKey.lastUsedAt, "never")}`,
          ]
            .filter(Boolean)
            .join(" · ")
        )
      }
      // The one thing on this page that can act WITHOUT a browser, stated where the key is
      // rather than in a paragraph under the section.
      note={
        !agentKey.readOnly ? "It can start real downloads on your behalf, in that agent's history" : undefined
      }
      action={
        <>
          {!asking && (
            <Button type="button" size="sm" variant="ghost" onClick={onRename}>
              Rename
            </Button>
          )}
          <ConfirmAction
            variant="inline"
            onAskingChange={setAsking}
            label="Revoke"
            question="Anything using it stops working immediately."
            confirmLabel="Yes, revoke"
            busyLabel="Revoking…"
            onConfirm={onRevoke}
          />
        </>
      }
    />
  );
}

export function AgentKeyPanel() {
  const [keys, setKeys] = useState<AgentKeySummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which key is being renamed, and to what. Null means nothing is being edited. */
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys((await getAgentKeys()).keys);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveName = async () => {
    if (!editing) return;
    const { id, name } = editing;
    setEditing(null);
    setError(null);
    try {
      // Empty CLEARS the name rather than storing "", the same rule the passkey rename
      // follows -- one spelling of "no name", and the row falls back to its kind.
      await renameAgentKey(id, name.trim() || null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!loaded) return null;

  return (
    <Section
      label="Automation"
      /*
        ZONE 1: additive only, and UNDER the list. Two things moved on 2026-09-07 and both
        were placement bugs the zone rules made nameable:

        - REVOKE was up here beside Create. A destructive verb on a section's rule is the one
          control a reader can press having read a noun and nothing else. It is a row action
          now, beside the key it destroys.
        - CREATE was pinned top-right, two thousand pixels from this list on a wide screen.
          See the zone-1 caution in `settings/Section.tsx`.
      */
      add={
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          {keys.length > 0 ? "Create another key" : "Create a key"}
        </Button>
      }
    >
      {keys.length === 0 ? (
        /*
          ONE sentence, and the button beneath it is the call to action.

          What used to be here was three stacked paragraphs and a floating `Read-only`
          checkbox whose Create button was off at the other edge of the screen -- aannarr,
          2026-09-07: *"is this readonly, what is that? is that not PER KEY?"*. It is per key,
          and everything about the key being made now lives in the dialog that makes it.
        */
        <Empty>
          No keys yet. One lets a script or an AI agent search, browse and request on your behalf, without a
          browser.
        </Empty>
      ) : (
        <Rows>
          {keys.map((k) =>
            editing?.id === k.id ? (
              <li key={k.id} className="border-b border-line/60 py-3 last:border-0">
                <form
                  className="flex items-center gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveName();
                  }}
                >
                  <Input
                    // Autofocused because this field opens on an explicit Rename click, never on
                    // page load. Not a suppression: `noAutofocus` only analyses the DOM `input`
                    // element and never a component, so a `biome-ignore` here suppresses nothing
                    // and biome reports it as unused.
                    autoFocus
                    value={editing.name}
                    maxLength={60}
                    placeholder="What is it for?"
                    onChange={(e) => setEditing({ id: k.id, name: e.target.value })}
                    // Blur saves rather than discarding: clicking away from a rename is far
                    // more often "done" than "cancel", and the value is one word.
                    onBlur={() => void saveName()}
                    aria-label="Key name"
                    className="min-w-0 flex-1"
                  />
                  {/* Same column as every other row, so the field ends where they end. */}
                  <div className={ACTION_COL}>
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                  </div>
                </form>
              </li>
            ) : (
              <AgentKeyRow
                key={k.id}
                agentKey={k}
                onRename={() => setEditing({ id: k.id, name: k.name ?? "" })}
                onRevoke={async () => {
                  // NOT caught: the inline confirm shows the server's refusal on the row that
                  // provoked it.
                  await revokeAgentKey(k.id);
                  await load();
                }}
              />
            ),
          )}
        </Rows>
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
          <AgentKeyDialog open={creating} onOpenChange={setCreating} onCreated={load} />
        </Suspense>
      )}
    </Section>
  );
}
