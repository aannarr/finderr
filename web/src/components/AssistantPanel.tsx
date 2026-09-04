/**
 * The assistant panel: a thread, a composer, and the rich blocks under each answer.
 *
 * PRESENTATIONAL. Every piece of state it draws is owned by `useAssistantChat`, which lives
 * a level up in `Assistant` -- so closing the panel mid-turn does not abandon the answer,
 * and the whole thing can be rendered in a test from a plain array of messages.
 *
 * > [!IMPORTANT] A DRAWER, not a floating bubble
 * > finderr's chrome is a sticky header and full-width content; a rounded card hovering over
 * > the bottom-right corner would be the one element in the product that belongs to a
 * > different app. The drawer takes the right edge, keeps the page readable beside it on a
 * > desktop, and goes full width on a phone where 400px IS the screen.
 *
 * > [!CAUTION] It is `fixed`, so it carries the top inset ITSELF
 * > `body` is padded for the display cutouts and `fixed` descendants are positioned against
 * > the viewport instead, so nothing on `body` reaches this. Without `--safe-top` the
 * > panel's own header renders under the status bar on an installed iPhone -- the same
 * > defect the sticky header and the toast stack each carry their own inset for, and
 * > `styles.test.ts` pins all three.
 */

import { Eraser, SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentRefusal } from "../lib/agent-api";
import type { StoredMessage } from "../lib/agent-store";
import { formatCost, formatDuration, retryPhrase, toolCallSummary } from "../lib/assistant-view";
import { refusalText } from "../lib/use-assistant-chat";
import { AgentEpisodes, AgentProblems, AgentRequests, AgentTitles, AgentToolCalls } from "./AssistantResults";
import { InertChip } from "./Chip";
import { Skeleton } from "./FacetPane";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";

/**
 * What the empty panel suggests, and it is three REAL questions rather than a feature list.
 *
 * They are examples of the shape that works here -- a library question with a constraint --
 * and clicking one fills the box rather than sending it, so nobody spends a turn on a
 * prompt they did not read.
 */
const EXAMPLES = [
  "What should I watch tonight, under two hours?",
  "Which seasons of The Wire am I missing?",
  "Find the best-rated sci-fi from the 90s I do not have",
];

export interface AssistantPanelProps {
  messages: readonly StoredMessage[];
  busy: boolean;
  refusal: AgentRefusal | null;
  onSend: (message: string) => void;
  onClear: () => void;
  onClose: () => void;
}

export function AssistantPanel({ messages, busy, refusal, onSend, onClear, onClose }: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  // The caret goes to the box on open, so `⌘.` is one gesture rather than a keystroke and
  // then a click. Same rule `/` follows for the search box.
  useEffect(() => {
    composer.current?.focus();
  }, []);

  /*
    PIN TO THE BOTTOM whenever the thread changes.

    A chat reads from the bottom, so a new turn arriving above the fold is a turn nobody
    sees. `busy` is in the dependency list as well as the length: the answer replaces an
    empty bubble in place, so the count does not change when the text actually lands.

    `scrollTop` on Radix's ROOT would do nothing -- the element that scrolls is the viewport
    inside it, which is why `ScrollArea` takes a `viewportRef` the registry's version has no
    reason to.
  */
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not reads -- the body touches only the ref, and these two are exactly what should move it
  useEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  const send = () => {
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <aside
      role="dialog"
      aria-label="finderr assistant"
      /*
        NOT `aria-modal`. The page behind stays operable on a desktop -- a reader following
        a title link out of an answer is the point of drawing those links -- and claiming
        modality without trapping focus tells a screen reader something false.

        Escape is handled HERE and stopped from bubbling: `back` and `clearFilters` are both
        bound to Escape on `window`, so without this, closing the panel from the title page
        would also navigate back. The same collision `JumpKeysProvider` solves in the capture
        phase; a bubble-phase stop is enough here because the caret is inside the panel.
      */
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-bg pt-[var(--safe-top)] sm:w-[26rem]"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <h2 className="text-sm font-semibold tracking-tight">Assistant</h2>
        {/* The one honest label for an admin-only preview that can spend money. */}
        <InertChip label="beta" />
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClear}
            disabled={messages.length === 0}
            aria-label="Clear this conversation"
            title="Clear this conversation"
          >
            <Eraser />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close the assistant">
            <X />
          </Button>
        </span>
      </header>

      <ScrollArea viewportRef={viewport} className="min-h-0 flex-1">
        <div className="space-y-4 px-3 py-3">
          {messages.length === 0 ? (
            <EmptyState onPick={(text) => setDraft(text)} />
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-line px-3 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        {/*
          The refusal sits ABOVE the box, where somebody about to type will see it, rather
          than up the thread with the turn that provoked it. A budget spent at 14:20 is still
          spent for the next attempt, which is a fact about the box and not about that turn.
        */}
        {refusal && <RefusalNote refusal={refusal} />}
        <div className="flex items-end gap-2">
          <Textarea
            ref={composer}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            /*
              Enter sends, Shift+Enter is a newline -- the convention every chat box in the
              world uses, and the one a reader will try first.

              It is a LOCAL handler on purpose and is not in `KEYMAP`: the global table binds
              plain Enter to `loadMore`, whose `firesWhileTyping` is false precisely so a
              caret swallows it. Adding a second global Enter would put the two in a race
              that depends on listener order.
            */
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) return;
              e.preventDefault();
              send();
            }}
            disabled={busy}
            placeholder="Ask about the library…"
            aria-label="Ask the assistant"
          />
          <Button
            size="icon"
            onClick={send}
            disabled={busy || draft.trim().length === 0}
            aria-label="Send"
            className="mb-0.5"
          >
            <SendHorizontal />
          </Button>
        </div>
        <p className="mt-1.5 text-[0.7rem] text-muted">
          It can start real downloads. Kept on this device only.
        </p>
      </div>
    </aside>
  );
}

/**
 * Nothing asked yet.
 *
 * Deliberately three sentences and three buttons, with no icon grid and no feature list:
 * what a reader needs here is one example of a question that works, and the fastest way to
 * give them that is a question they can click.
 */
function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="pt-6">
      <p className="text-sm text-ink">Ask about anything in the library.</p>
      <p className="mt-1 text-xs text-muted">
        It can search the index, read what a title is about, and request something you do not have yet.
      </p>
      <ul className="mt-3 space-y-1.5">
        {EXAMPLES.map((example) => (
          <li key={example}>
            {/* Fills the box rather than sending. A turn costs money and nobody should spend
                one on a sentence they have not read. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPick(example)}
              className="h-auto w-full justify-start whitespace-normal px-2.5 py-1.5 text-left leading-snug"
            >
              {example}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One turn.
 *
 * The reader's own words get a filled bubble on the right, the assistant's get the page's
 * own background and full width -- because an answer carries poster cards and episode rows,
 * and a chat bubble around a grid is a box inside a box.
 */
function Bubble({ message: m }: { message: StoredMessage }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-xl rounded-br-sm bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap">
          {m.text}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5" aria-busy={m.pending || undefined}>
      {/*
        THINKING, and only while there is nothing to read yet.

        `pending` with text is what a token stream looks like: the words are already
        arriving, so the skeleton is gone and the prose is what moves. Nothing else in this
        component changes when that lands.
      */}
      {m.pending && m.text.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        m.text.length > 0 && <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.text}</p>
      )}

      {/* A turn that failed keeps its place in the thread rather than vanishing with the
          question that provoked it. */}
      {m.error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-ink">
          {m.error}
        </p>
      )}

      {m.requested && <AgentRequests requested={m.requested} />}
      {m.titles && <AgentTitles titles={m.titles} />}
      {m.episodes && <AgentEpisodes episodes={m.episodes} />}
      {m.problems && <AgentProblems problems={m.problems} />}
      {m.toolCalls && <AgentToolCalls calls={m.toolCalls} summary={toolCallSummary(m.toolCalls)} />}

      {/* What the turn cost, in the smallest type on the screen. It is here because an
          admin-only beta with a daily budget is one somebody is watching the spend of. */}
      {m.usage && (
        <p className="text-[0.7rem] tabular-nums text-muted/70">
          {formatCost(m.usage.costUsd)} · {formatDuration(m.usage.ms)}
        </p>
      )}
    </div>
  );
}

/**
 * The standing note above the composer, one per refusal kind.
 *
 * `over-limit` is the only one that adds anything to the server's own sentence, and what it
 * adds is WHEN -- a budget that refills is a wait rather than a wall, and saying so is the
 * difference between somebody trying again and somebody giving up on the feature.
 */
function RefusalNote({ refusal }: { refusal: AgentRefusal }) {
  const when = refusal.kind === "over-limit" ? retryPhrase(refusal.retryAfterSeconds) : null;
  return (
    <p
      // `alert` because it appears in response to an action the reader just took and is not
      // where they are looking -- the caret is in the box below it.
      role="alert"
      className="mb-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-ink"
    >
      {refusalText(refusal)}
      {when && ` Try again ${when}.`}
    </p>
  );
}
