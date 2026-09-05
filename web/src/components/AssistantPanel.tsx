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
 *
 * > [!IMPORTANT] IT SLIDES IN, AND IT OWNS ONLY THE ARRIVAL
 * > The enter is the `fdr-drawer-in` keyframe in `styles.css`, which runs the moment this
 * > element exists and needs no state, no ref and no `requestAnimationFrame` -- see that
 * > rule for why a transition is the wrong tool for a mount. The DEPARTURE is not this
 * > component's decision, because a panel cannot animate itself out of a tree it has
 * > already been removed from: `Assistant` sets `retracting`, this draws the slide, and
 * > `Assistant` unmounts once `DRAWER_MS` has passed. All three timings are one number.
 */

import { Eraser, SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentRefusal } from "../lib/agent-api";
import type { StoredMessage } from "../lib/agent-store";
import { hasProse } from "../lib/agent-transcript";
import { formatCost, formatDuration, retryPhrase, toolCallSummary } from "../lib/assistant-view";
import { isRichMarkdown } from "../lib/markdown";
import { type QueuedMessage, refusalText } from "../lib/use-assistant-chat";
import { AgentEpisodes, AgentProblems, AgentRequests, AgentTitles, AgentToolCalls } from "./AssistantResults";
import { AssistantTranscript } from "./AssistantTranscript";
import { InertChip } from "./Chip";
import { Skeleton } from "./FacetPane";
import { Markdown } from "./Markdown";
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
  /** Typed while a turn was running. Not sent yet, and not part of the conversation. */
  queued?: readonly QueuedMessage[];
  /** The drain stopped on a failure; nothing goes out until the reader says so. */
  queueHalted?: boolean;
  onSend: (message: string) => void;
  onCancelQueued?: (id: string) => void;
  onResumeQueue?: () => void;
  onClear: () => void;
  onClose: () => void;
  /**
   * Slide out to the right; `Assistant` unmounts this shortly after setting it.
   *
   * A prop rather than local state because the element has to OUTLIVE the decision to close
   * by exactly the length of the animation, and only the parent that renders it can grant
   * that. Defaults false so a test rendering the panel directly gets it on screen.
   */
  retracting?: boolean;
}

export function AssistantPanel({
  messages,
  busy,
  refusal,
  queued = [],
  queueHalted = false,
  onSend,
  onCancelQueued,
  onResumeQueue,
  onClear,
  onClose,
  retracting = false,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  // The caret goes to the box on open, so `⌘.` is one gesture rather than a keystroke and
  // then a click. Same rule `/` follows for the search box.
  useEffect(() => {
    composer.current?.focus();
  }, []);

  /*
    PIN TO THE BOTTOM whenever the thread changes -- BUT ONLY IF THE READER IS ALREADY THERE.

    A chat reads from the bottom, so a new turn arriving above the fold is a turn nobody
    sees. That was the whole rule while an answer landed in one piece. Now the answer
    ARRIVES OVER SECONDS, and an unconditional pin becomes a scroll position that fights
    anybody trying to read back over the transcript while the rest of it streams in --
    every token would yank them to the floor again.

    So: pin when within `STICK_PX` of the bottom, which is what "following along" looks like,
    and leave the viewport alone otherwise. `tailLength` is in the dependency list because
    streaming grows the LAST message in place, so neither the count nor `busy` changes when
    the text actually moves.

    `scrollTop` on Radix's ROOT would do nothing -- the element that scrolls is the viewport
    inside it, which is why `ScrollArea` takes a `viewportRef` the registry's version has no
    reason to.
  */
  const tailLength = messages.length > 0 ? messages[messages.length - 1].text.length : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not reads -- the body touches only the ref, and these are exactly what should move it
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const STICK_PX = 96;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length, tailLength, busy, queued.length]);

  /*
    NO `busy` GUARD, and that is the queue's whole point.

    Sending while a turn is in flight used to be silently refused, so a reader who typed a
    follow-up watched their sentence sit in the box doing nothing. `useAssistantChat` decides
    what happens to it -- queued in order and sent one at a time -- and the box's job is
    only to hand it over and clear itself.
  */
  const send = () => {
    if (!draft.trim()) return;
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
      /*
        `w-full sm:w-[26rem]` is where "the drawer covers everything" is DECIDED, and
        `SM_QUERY` in `drawer-motion.ts` is the same boundary asked in JavaScript so the
        retract-on-navigation rule fires exactly where the panel starts hiding the page.
        Move one and move the other.

        THE MOTION IS `fdr-drawer*` IN `styles.css` AND NOT A UTILITY HERE. It has to be:
        under `prefers-reduced-motion` the slide becomes a cross-fade, and overriding the
        stylesheet's blanket `!important` floor takes a class selector plus an `!important`
        of its own -- neither of which a Tailwind arbitrary value can express. That block
        also explains why the enter is a keyframe and the exit a transition.
      */
      className={`fdr-drawer fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-bg pt-[var(--safe-top)] sm:w-[26rem] ${
        retracting ? "fdr-drawer-out" : "fdr-drawer-in"
      }`}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <h2 className="text-sm font-semibold tracking-tight">Assistant</h2>
        {/* The one honest label for a preview that can spend money. */}
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
          {messages.length === 0 && queued.length === 0 ? (
            <EmptyState onPick={(text) => setDraft(text)} />
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
          {/* The queue sits at the END of the thread, where it will be answered, rather than
              beside the composer -- it is the next few turns, in the reader's own order. */}
          {queued.length > 0 && (
            <QueuedTurns
              items={queued}
              halted={queueHalted}
              onCancel={onCancelQueued}
              onResume={onResumeQueue}
            />
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
        {/*
          THE COMPOSER RENDERS MARKDOWN TOO -- aannarr asked for both ends, and this is the
          writing end. It appears only when the draft actually CONTAINS markdown
          (`isRichMarkdown`), which is what makes it deliberate rather than decorative:
          somebody typing an ordinary sentence is shown nothing new, and somebody typing
          `**bold**` finds out what that becomes before spending a turn on it.

          A live-styled contenteditable was the alternative and loses: it fights the caret,
          it cannot be a `<textarea>`, and `styles.css` floors every textarea at 16px
          specifically to keep iOS from zooming on focus -- a rule a div would not inherit.
        */}
        {isRichMarkdown(draft) && (
          <div className="mb-2 max-h-40 overflow-y-auto rounded-lg border border-line bg-surface/60 px-2.5 py-1.5">
            <p className="mb-1 text-[0.65rem] font-medium tracking-wider text-muted uppercase">Preview</p>
            <Markdown text={draft} />
          </div>
        )}
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
            // NOT disabled while busy. Typing during a turn is queued rather than refused,
            // and a box that goes dead mid-thought loses the sentence somebody was writing.
            placeholder={busy ? "Ask something else — it will be sent next…" : "Ask about the library…"}
            aria-label="Ask the assistant"
          />
          <Button
            size="icon"
            onClick={send}
            disabled={draft.trim().length === 0}
            aria-label={busy ? "Queue this message" : "Send"}
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

  const hasTranscript = (m.transcript?.length ?? 0) > 0;
  /*
    WHO DRAWS THE PROSE, and there is exactly one owner at any instant.

    A transcript carrying `text` entries has the answer interleaved between the lookups, in
    the order it arrived -- that is the streaming view, and the view a turn that died keeps.
    A settled turn has none, because `settleTranscript` drops them in favour of the
    authoritative `text`. Rendering both printed every streamed sentence twice on screen.
  */
  const transcriptOwnsProse = hasProse(m.transcript ?? []);

  return (
    <div className="space-y-2.5" aria-busy={m.pending || undefined}>
      {/*
        THE TRANSCRIPT COMES FIRST, because it happened first. Reasoning and lookups are how
        the answer was arrived at, and reading them under the conclusion would be reading the
        turn backwards.
      */}
      {/* `pending` is what tells the transcript that its last entry is still growing -- a
          thinking block opens itself while it is being written and folds away when it is
          not, and without this every restored transcript would claim to still be thinking. */}
      {m.transcript && (
        <AssistantTranscript entries={m.transcript} mentions={m.mentions} streaming={m.pending ?? false} />
      )}

      {/*
        THINKING, and only while there is nothing to read AND nothing to watch.

        `pending` with text is what a token stream looks like: the words are already
        arriving, so the skeleton is gone and the prose is what moves. A transcript counts
        too -- once tool rows are on screen the reader can see exactly what is happening, and
        a grey placeholder beside them would be reporting the same wait twice.
      */}
      {m.pending && m.text.length === 0 && !hasTranscript ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        // MARKDOWN, not `whitespace-pre-wrap` text. `Markdown` renders React elements and
        // never HTML -- see its header; this is model output and that is an injection path.
        !transcriptOwnsProse && m.text.length > 0 && <Markdown text={m.text} mentions={m.mentions} />
      )}

      {/*
        A turn that failed keeps its place in the thread rather than vanishing with the
        question that provoked it. An INCOMPLETE one is a different claim and wears a
        different colour: the words above it are real but unfinished, so it is a warning
        about the answer rather than a report that there is none.
      */}
      {m.error &&
        (m.incomplete && m.text.length > 0 ? (
          <p className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-2 text-xs text-ink">
            This answer is incomplete. {m.error}
          </p>
        ) : (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-ink">
            {m.error}
          </p>
        ))}

      {m.requested && <AgentRequests requested={m.requested} />}
      {m.titles && <AgentTitles titles={m.titles} />}
      {m.episodes && <AgentEpisodes episodes={m.episodes} />}
      {m.problems && <AgentProblems problems={m.problems} />}
      {/*
        The old collapsed lookup list, for a bubble that has NO transcript -- which now means
        one restored from `localStorage` that was written before the transcript existed.
        Drawing both would list every call twice, because `settleTranscript` already folds
        `toolCalls` in when the stream carried none of its own.
      */}
      {!hasTranscript && m.toolCalls && (
        <AgentToolCalls calls={m.toolCalls} summary={toolCallSummary(m.toolCalls)} />
      )}

      {/* What the turn cost, in the smallest type on the screen. It is here because the
          person spending against the daily budget is the one who should see it go. */}
      {m.usage && (
        <p className="text-[0.7rem] tabular-nums text-muted/70">
          {formatCost(m.usage.costUsd)} · {formatDuration(m.usage.ms)}
        </p>
      )}
    </div>
  );
}

/**
 * WHAT WAS TYPED WHILE A TURN WAS RUNNING, waiting its turn.
 *
 * > [!IMPORTANT] They are drawn as PENDING, never as sent
 * > A queued message that looked like an ordinary user bubble would read as a question the
 * > assistant had ignored. Dashed, dimmed, labelled, and each one carries the control that
 * > removes it -- because the honest answer to "I did not mean to send that" is a button,
 * > not an apology in the next answer.
 *
 * The HALTED state is the interesting one. The drain stops on a failure rather than firing
 * the rest at a server that just refused, so the queue can sit here indefinitely; saying
 * WHY and offering the one control that resumes it is what stops that being a mystery.
 */
function QueuedTurns({
  items,
  halted,
  onCancel,
  onResume,
}: {
  items: readonly QueuedMessage[];
  halted: boolean;
  onCancel?: (id: string) => void;
  onResume?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-2 text-[0.7rem] text-muted">
        {halted ? "Not sent — the last turn failed." : `Waiting to send (${items.length})`}
        {halted && onResume && (
          <Button variant="outline" size="sm" onClick={onResume} className="h-6 px-2 text-[0.7rem]">
            Send now
          </Button>
        )}
      </p>
      {items.map((q) => (
        <div key={q.id} className="flex justify-end gap-1">
          <p className="max-w-[85%] rounded-xl rounded-br-sm border border-dashed border-line px-3 py-2 text-sm whitespace-pre-wrap text-muted">
            {q.text}
          </p>
          {onCancel && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onCancel(q.id)}
              aria-label={`Cancel "${q.text.slice(0, 40)}"`}
              title="Do not send this"
              className="self-center"
            >
              <X />
            </Button>
          )}
        </div>
      ))}
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
