/**
 * THE TURN, DRAWN AS IT HAPPENED.
 *
 * One question used to produce one bubble after thirty seconds of nothing, and the loop
 * behind it -- think, look something up, read the result, think again -- was thrown away.
 * aannarr, 2026-09-05: *"i want to see reasoning + thinking + tool calls (nicely rendered!)"*.
 * This is that. `../lib/agent-transcript.ts` owns what the entries MEAN; this file owns what
 * they look like, and holds no rules of its own.
 *
 * > [!IMPORTANT] THE ANSWER IS WHAT THE EYE LANDS ON, and the machinery is one click away
 * > Reasoning and raw arguments are SECONDARY. Both are collapsed by default and drawn in
 * > the smallest, quietest type on the screen -- an answer buried under a stack of
 * > diagnostics is a worse answer. But neither is hidden: a reader who wants to know why it
 * > said something must be able to open the lookups it did, which is the difference between
 * > a fact about this library and a plausible sentence.
 *
 * > [!CAUTION] A tool call that never finished says so; it does NOT spin forever
 * > A `start` frame whose `end` never arrived is `unfinished`, and it wears a struck-through
 * > icon and the words "did not finish". An animated spinner outliving the request it is
 * > reporting on is a lie that costs nothing to tell and cannot be caught from the outside.
 */

import { Brain, Check, ChevronRight, CircleSlash, LoaderCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { isStreamingEntry, type ToolEntry, type TranscriptEntry } from "../lib/agent-transcript";
import {
  disclosureFor,
  disclosureOpen,
  formatDuration,
  syncDisclosure,
  toggleDisclosure,
  toolArgFields,
  toolLabel,
  toolResultText,
  toolSubject,
} from "../lib/assistant-view";
import type { ResolvedMention } from "../lib/mentions";
import { Markdown } from "./Markdown";

/**
 * The whole transcript, in arrival order.
 *
 * `entries` is drawn in the order it was built and never sorted -- the ORDER IS THE
 * CONTENT here, and a stable sort by anything else would be a second, wrong story about
 * what the agent did.
 */
export function AssistantTranscript({
  entries,
  mentions,
  streaming = false,
}: {
  entries: readonly TranscriptEntry[];
  /** Resolved ids for this turn, so prose the transcript owns links like the answer does. */
  mentions?: readonly ResolvedMention[];
  /**
   * The turn is still running -- the bubble's own `pending`.
   *
   * Only the thinking blocks read it, and only to decide whether THIS one is the one being
   * written right now. Passing it down rather than deriving it here because a transcript
   * cannot tell a live turn from a settled one on its own: both are just arrays.
   */
  streaming?: boolean;
}) {
  if (entries.length === 0) return null;
  // A turn divider is drawn only when there IS more than one turn. Labelling a single pass
  // "Step 1" is chrome around a thing that has no second half to be told apart from.
  const multiTurn = new Set(entries.map((e) => e.turn)).size > 1;
  let seen = -1;

  return (
    <div className="space-y-1.5">
      {entries.map((e) => {
        const opensTurn = multiTurn && e.turn !== seen;
        seen = e.turn;
        return (
          <div key={e.key} className="space-y-1.5">
            {opensTurn && <TurnDivider n={e.turn} />}
            <Entry entry={e} mentions={mentions} live={isStreamingEntry(entries, e.key, streaming)} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where one pass of the loop ends and the next begins.
 *
 * Turn 2's tokens are NOT a continuation of turn 1's sentence -- they are a new block after
 * a tool result came back -- and without a visible seam the transcript reads as one
 * run-on paragraph interrupted by machinery.
 */
function TurnDivider({ n }: { n: number }) {
  return (
    <p className="flex items-center gap-2 pt-1 text-[0.65rem] font-medium tracking-wider text-muted/70 uppercase">
      <span className="h-px flex-1 bg-line" />
      Step {n}
      <span className="h-px flex-1 bg-line" />
    </p>
  );
}

function Entry({
  entry,
  mentions,
  live,
}: {
  entry: TranscriptEntry;
  mentions?: readonly ResolvedMention[];
  /** This entry is the one currently being written. Only `Reasoning` acts on it. */
  live: boolean;
}) {
  if (entry.kind === "tool") return <ToolCall entry={entry} />;
  if (entry.kind === "reasoning") return <Reasoning text={entry.text} live={live} />;
  return <Markdown text={entry.text} mentions={mentions} />;
}

/**
 * The model thinking out loud: OPEN WHILE IT IS THINKING, collapsed the moment it stops.
 *
 * A `<details>` rather than a state flag: it is the browser's own disclosure, keyboard
 * operable for free, and `summary` is a button in the accessibility tree with nothing here
 * saying so. Same choice `AgentToolCalls` makes, for the same reasons.
 *
 * > [!IMPORTANT] The default is not one state, it is two, and `live` picks between them
 * > aannarr, 2026-09-05: the thinking should be expanded *while* the tokens are arriving, so
 * > a reader can watch the reasoning happen, and minimised once it is done. Collapsed-always
 * > hid the only part of a thirty-second wait that shows anything is happening -- the reader
 * > got a summary line that never moved. Open-always is the other failure: a settled answer
 * > buried under paragraphs of working, which is the rule the file header states.
 * >
 * > So the block is open exactly while it is the entry being appended to (`isStreamingEntry`
 * > owns that question) and folds itself away the instant a tool call, a token or the next
 * > turn lands after it.
 *
 * **A reader's own click outranks both, until the stream contradicts it.** `override` is
 * `null` until somebody touches the disclosure, so a block opened to re-read the working
 * does not slam shut on the next frame, and one closed mid-stream stays closed while the
 * tokens keep coming. Every CHANGE in `live` clears it, which is the half that has to be
 * there.
 *
 * > [!CAUTION] Without that reset every thinking block stays open forever, and no test sees it
 * > Measured in a browser 2026-09-05, on a phone-width viewport, three blocks open under a
 * > settled answer. `<details>` fires `toggle` when the ATTRIBUTE changes, not only when a
 * > human clicks -- so React opening a live block fires it, `override` latches `true`, and
 * > the block can never fold again. The reasoning that says it is harmless ("it only writes
 * > back the value it just drove") is exactly wrong: writing back a non-null value is what
 * > freezes it. There is no `isTrusted` to filter on either, because a programmatic `toggle`
 * > and a real one are indistinguishable here.
 * >
 * > The reset is the documented "adjust state during render" pattern rather than an effect,
 * > so the fold happens in the same commit that ends the thinking. An effect would paint one
 * > frame with the block still open.
 *
 * **An empty reasoning block is never drawn.** Most models emit no reasoning at all and
 * that is the ordinary case rather than a failure -- a "Thinking" disclosure over nothing
 * would advertise a capability this deployment does not have.
 */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [disclosure, setDisclosure] = useState(() => disclosureFor(live));
  // Adjust-during-render rather than an effect, so the block folds in the SAME commit that
  // ends the thinking. An effect would paint one frame with it still open.
  const synced = syncDisclosure(disclosure, live);
  if (synced !== disclosure) setDisclosure(synced);
  if (text.trim().length === 0) return null;
  return (
    <details
      className="group"
      open={disclosureOpen(synced, live)}
      onToggle={(e) => {
        // Read it HERE, not inside the updater: `currentTarget` is only valid for the
        // duration of the handler, and the updater runs on the next render.
        const isOpen = e.currentTarget.open;
        setDisclosure((d) => toggleDisclosure(d, isOpen));
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[0.7rem] text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
        <ChevronRight
          className="size-3 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <Brain
          // It PULSES while the thinking is live and is still once it is not, which is the
          // same promise `ToolIcon` makes: nothing on this page animates over work that has
          // already finished. `live` rather than `open`, so a reader who folds it away
          // mid-stream still has one moving thing telling them the turn is running.
          className={`size-3 shrink-0${live ? " animate-pulse text-accent motion-reduce:animate-none" : ""}`}
          aria-hidden="true"
        />
        Thinking
      </summary>
      {/* Italic, muted, and one step in from the answer: this is not what it said, it is
          what it was working out on the way there. */}
      <div className="mt-1 border-l border-line pl-2.5 text-[0.7rem] text-muted italic">
        <Markdown text={text} className="text-[0.7rem] leading-relaxed" />
      </div>
    </details>
  );
}

/** The state badge. Four states, four glyphs, and none of them animates once it is settled. */
function ToolIcon({ entry }: { entry: ToolEntry }) {
  if (entry.state === "running") {
    return (
      <LoaderCircle
        className="size-3 shrink-0 animate-spin text-accent motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (entry.state === "unfinished") {
    return <CircleSlash className="size-3 shrink-0 text-muted" aria-hidden="true" />;
  }
  if (entry.error) return <TriangleAlert className="size-3 shrink-0 text-warn" aria-hidden="true" />;
  return <Check className="size-3 shrink-0 text-muted" aria-hidden="true" />;
}

/**
 * One lookup: what it was, what it was asked about, and what came back.
 *
 * The head line is the whole point -- `Title search · "Heat"` followed by `3 matches · 12ms`
 * is a sentence a reader can follow without opening anything. `toolLabel`, `toolSubject`
 * and `toolResultText` own each of those three phrasings and none of them is re-derived
 * here; the raw arguments live in the disclosure below, where diagnostics belong.
 */
function ToolCall({ entry }: { entry: ToolEntry }) {
  const fields = toolArgFields(entry.args);
  const head = <ToolHead entry={entry} />;

  // No arguments to show means no disclosure to open. That happens for a call whose `start`
  // frame was lost -- an `end` with nothing to expand is still a fact worth drawing.
  if (fields.length === 0) {
    return <div className="rounded-lg border border-line bg-surface/60 px-2.5 py-1.5">{head}</div>;
  }

  return (
    <details className="group rounded-lg border border-line bg-surface/60">
      <summary className="cursor-pointer list-none px-2.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {head}
      </summary>
      {/*
        A definition list rather than a JSON blob. `{"tconst":"tt0944947","season":2}` is a
        string a reader has to parse; `title "tt0944947"` on its own line is one they can
        read. `formatArgValue` is the owner of every value's spelling.
      */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-line px-2.5 py-1.5 text-[0.7rem]">
        {fields.map((f) => (
          <div key={f.label} className="contents">
            <dt className="text-muted">{f.label}</dt>
            <dd className="break-all text-ink/80">{f.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function ToolHead({ entry }: { entry: ToolEntry }) {
  const subject = toolSubject(entry.name, entry.args);
  const result = toolResultText(entry.summary, entry.error);
  return (
    <p className="flex items-baseline gap-1.5 text-[0.7rem] leading-relaxed">
      <span className="flex size-3 shrink-0 translate-y-px items-center">
        <ToolIcon entry={entry} />
      </span>
      <span className="font-medium text-ink">{toolLabel(entry.name)}</span>
      {subject && <span className="min-w-0 flex-1 truncate text-muted">{subject}</span>}
      <span className="ml-auto shrink-0 pl-1 text-right text-muted/80">
        {entry.state === "unfinished" ? (
          // The honest report of a `start` with no `end`: the run died and this call's
          // outcome is unknown. Not "failed", which would be a claim, and not a spinner.
          <span className="italic">did not finish</span>
        ) : (
          <>
            {result && <span className={entry.error ? "text-warn" : undefined}>{result}</span>}
            {result && entry.ms !== undefined && " · "}
            {entry.ms !== undefined && <span className="tabular-nums">{formatDuration(entry.ms)}</span>}
          </>
        )}
      </span>
    </p>
  );
}
