/**
 * Creating an agent key, as a guided two-step rather than a checkbox on a page.
 *
 * > [!IMPORTANT] THE CHECKBOX HAD NO ZONE, and that is why this dialog exists
 * > `Read-only -- it can look, but it cannot request anything` sat under the section's empty
 * > state, floating, while the Create button that CONSUMES it was up on the section rule a
 * > screen-width away. aannarr, 2026-09-07: *"is this readonly, what is that? is that not PER
 * > KEY?"* -- and it is per key, which was exactly the thing the placement failed to say.
 * >
 * > The three action zones in `settings/Section.tsx` are what makes the defect nameable: a
 * > control whose subject is THE THING YOU ARE ABOUT TO MAKE is not the section, not a row
 * > and not the page. It has no zone because it does not belong on the page at all. It
 * > belongs in the flow that creates the thing, which is this.
 *
 * TWO STEPS, and the second is the whole reason a key is worth creating: the deliverable is
 * the SNIPPET, not the token. Somebody who dismissed the page before copying has to make a
 * second key, so the snippet gets the dialog to itself with nothing else competing for the
 * click -- and the dialog cannot be dismissed by clicking away while it is on screen.
 *
 * LAZY-LOADED by `AgentKeyPanel`, on aannarr's instruction. It is the rarest thing on
 * `/account` and it pulls in the whole Radix dialog; a reader who never creates a key never
 * downloads it.
 */

import { useState } from "react";
import { createAgentKey } from "../lib/auth-api";
import { ShowOnceSecret } from "./ShowOnceSecret";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";

/**
 * What a key may do, as two named choices with their consequences written out.
 *
 * NOT a checkbox. A checkbox states one option and leaves the other implied, so the reader has
 * to work out what NOT ticking it means -- and here the un-ticked state is the powerful one,
 * which is the wrong way round for a box somebody skims past. Two radios put both outcomes on
 * screen at the same weight, and the dangerous one says so in its own words.
 *
 * The default is `write`, because requesting is what an agent key is FOR -- a read-only
 * default would be a safer-looking dialog that most people have to correct. The mitigation is
 * that the consequence is stated rather than hidden.
 */
type Scope = "write" | "read";

const SCOPES: { value: Scope; label: string; detail: string }[] = [
  {
    value: "write",
    label: "Search and request",
    detail: "It can start real downloads on your behalf, spending your daily allowance.",
  },
  {
    value: "read",
    label: "Read-only",
    detail: "It can search and browse. It cannot request anything.",
  },
];

export default function AgentKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Told once the key exists, so the section behind can redraw its list. */
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("write");
  const [snippet, setSnippet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await createAgentKey({ name: name.trim() || null, readOnly: scope === "read" });
      setSnippet(made.snippet);
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Closing RESETS, so the next Create is a fresh decision rather than the last one's state. */
  const close = () => {
    onOpenChange(false);
    setSnippet(null);
    setScope("write");
    setName("");
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="sm:max-w-lg"
        // While the token is on screen there is no accidental way out: it cannot be shown
        // again, so a stray click on the scrim would cost a second key.
        onPointerDownOutside={(e) => snippet && e.preventDefault()}
        onEscapeKeyDown={(e) => snippet && e.preventDefault()}
      >
        {snippet ? (
          <>
            <DialogHeader>
              <DialogTitle>Your key, once</DialogTitle>
              <DialogDescription>
                finderr stores only a hash of this, so it cannot be shown again. If it is lost, make another —
                the old one stops working the moment you do.
              </DialogDescription>
            </DialogHeader>

            {/*
              The SNIPPET rather than the bare token: it is a `curl` that fetches the manifest
              with the key in an Authorization header, so an agent discovers everything else
              from that one call. A bare URL is also the thing people paste into a chat or an
              issue without registering that they have just published a credential.
            */}
            <ShowOnceSecret
              note={
                scope === "read"
                  ? "Give this to your agent now."
                  : "Give this to your agent now. It can start real downloads on your behalf."
              }
              value={snippet}
            />

            <DialogFooter>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create an agent key</DialogTitle>
              <DialogDescription>
                A key lets a script or an AI agent search, browse and request on your behalf, without a
                browser. Any keys you already have keep working.
              </DialogDescription>
            </DialogHeader>

            {/*
              THE NAME IS FIRST AND IT IS OPTIONAL, which is the right way round for a field
              whose value is only felt later. It is what turns a list of identical rows into
              rows somebody can decide about -- so the placeholder asks the question the name
              answers rather than saying "Name".

              Not required: a person making their first key does not yet know they will make
              a second, and blocking them to collect a label they cannot see the point of is
              how a guided flow becomes an obstacle. The row falls back to the key's kind.
            */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-key-name">Name (optional)</Label>
              <Input
                id="agent-key-name"
                value={name}
                maxLength={60}
                disabled={busy}
                placeholder="What is it for? e.g. home-assistant"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-medium">What may it do?</legend>
              <RadioGroup
                value={scope}
                onValueChange={(v) => setScope(v as Scope)}
                disabled={busy}
                className="mt-1 gap-3"
              >
                {SCOPES.map((s) => (
                  // Control LEFT, words right -- the rule these screens follow everywhere.
                  <div key={s.value} className="flex items-start gap-2.5">
                    <RadioGroupItem value={s.value} id={`scope-${s.value}`} className="mt-0.5 shrink-0" />
                    <label htmlFor={`scope-${s.value}`} className="leading-5">
                      <span className="block text-sm text-ink">{s.label}</span>
                      <span className="block text-xs text-muted">{s.detail}</span>
                    </label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>

            {/*
              The one limit that is TRUE WHICHEVER choice is made, so it sits outside them --
              said here because the person handing a key over is the one who can decide not
              to, and they cannot decide that afterwards.
            */}
            <p className="text-xs text-muted">
              A key never carries administration, whoever you are. Giving it to an agent puts it in that
              agent’s history.
            </p>

            {error && (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={create} disabled={busy}>
                {busy ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
