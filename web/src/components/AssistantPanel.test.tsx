/**
 * What the assistant panel puts on the page, per message shape.
 *
 * Rendered with `react-dom/server` like the other component tests here -- the assertions
 * are about WHICH markup appears for a given answer, and static markup answers that with no
 * DOM and no test-library dependency.
 *
 * > [!NOTE] It stands a real router up, unlike `TitlePanes.test.tsx`
 * > That file works around `<Link>` throwing outside a `RouterProvider` by asserting on
 * > class strings instead. It does not have to any more: `await router.load()` before the
 * > render is the missing step, and an eleven-line memory router is cheaper than the
 * > workaround AND stronger -- it renders real `href`s, so "does this row link to the
 * > SERIES rather than to the episode" is a fact these tests can check rather than assume.
 * > It is SHARED now (`../test/render-in-router`): four files had grown their own copy, and
 * > the line that used to stand here saying this was the only one that needed it is what
 * > every one of the other three read before writing a fifth.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { StoredMessage } from "../lib/agent-store";
import type { TranscriptEntry } from "../lib/agent-transcript";
import { renderInRouter } from "../test/render-in-router";
import { AssistantPanel, type AssistantPanelProps } from "./AssistantPanel";

/** Render anything that contains a `<Link>`. No child routes -- nothing here links anywhere. */
const renderRouted = (node: ReactNode) => renderInRouter(node, []);

const NOOP = () => {};

function panel(over: Partial<AssistantPanelProps> = {}): Promise<string> {
  return renderRouted(
    <AssistantPanel
      messages={[]}
      busy={false}
      refusal={null}
      onSend={NOOP}
      onClear={NOOP}
      onClose={NOOP}
      {...over}
    />,
  );
}

/** One assistant turn, with only the fields the case under test cares about. */
function answer(over: Partial<StoredMessage> = {}): StoredMessage {
  return { id: "a1", role: "assistant", text: "Here you go.", at: 1_700_000_000_000, ...over };
}

/*
  AN OPEN `<details>`, AS THIS RENDERER ACTUALLY SPELLS IT.

  Two tests asserted `not.toContain("<details open")` until 2026-09-05 and neither could ever
  have matched: `renderToStaticMarkup` writes the className first, so the markup is
  `<details class="group" open="">`. Both passed by checking nothing, and would have stayed
  green through a change that expanded every disclosure in the panel -- which is exactly the
  change made that day. Named once so the next assertion cannot get it wrong privately.
*/
const EXPANDED = 'open=""';

describe("with nothing asked yet", () => {
  test("says what it is for and offers a question to click", async () => {
    const html = await panel();
    expect(html).toContain("Ask about anything in the library");
    expect(html).toContain("What should I watch tonight");
  });

  /** Nothing to erase, so the control that erases it is off rather than absent. */
  test("clear is disabled rather than hidden", async () => {
    expect(await panel()).toContain("disabled");
  });

  /**
   * The two facts a reader should have BEFORE typing: it spends money on their behalf, and
   * the transcript is on this device.
   */
  test("warns that it can start downloads, on the composer rather than in a menu", async () => {
    expect(await panel()).toContain("It can start real downloads");
  });
});

describe("a turn in flight", () => {
  test("reserves the answer's space instead of an empty gap", async () => {
    const html = await panel({ messages: [answer({ text: "", pending: true })], busy: true });
    expect(html).toContain("animate-pulse");
    expect(html).toContain('aria-busy="true"');
  });

  /**
   * THE STREAMING SEAM. A `pending` bubble that already has text is what a token stream
   * looks like -- the skeleton must be gone and the prose must be what moves, or a stream
   * would render behind a placeholder for its whole duration.
   */
  test("a pending bubble that already has text draws the text, not the skeleton", async () => {
    const html = await panel({ messages: [answer({ text: "Looking at", pending: true })], busy: true });
    expect(html).toContain("Looking at");
    expect(html).not.toContain("animate-pulse");
  });
});

describe("titles in an answer", () => {
  const titles = [
    { tconst: "tt0113277", title: "Heat", year: 1995, kind: "movie", poster: "/img/t/tt0113277" },
  ];

  test("draw a card that links to the title page", async () => {
    const html = await panel({ messages: [answer({ titles })] });
    expect(html).toContain("Heat");
    expect(html).toContain('href="/title/tt0113277"');
    expect(html).toContain("1995");
  });

  /**
   * The image guard, on the least trustworthy path into this app: the payload is assembled
   * from what a MODEL referred to. `localImageUrl` refuses anything not same-origin, and a
   * refusal must fall back to the tile rather than putting an upstream host in an `<img>`.
   */
  test("an upstream poster URL never reaches an img tag", async () => {
    const html = await panel({
      messages: [answer({ titles: [{ ...titles[0], poster: "https://image.tmdb.org/x.jpg" }] })],
    });
    expect(html).not.toContain("image.tmdb.org");
    // Still a card, still a link -- the artwork is what was dropped, not the title.
    expect(html).toContain('href="/title/tt0113277"');
  });

  /** Protocol-relative is an absolute URL wearing a relative costume. */
  test("and neither does a protocol-relative one", async () => {
    const html = await panel({
      messages: [answer({ titles: [{ ...titles[0], poster: "//evil.example/x.jpg" }] })],
    });
    expect(html).not.toContain("evil.example");
  });
});

describe("episodes in an answer", () => {
  const episode = {
    tconst: "tt1480055",
    parent: "tt0944947",
    season: 2,
    number: 9,
    title: "Blackwater",
    rating: 9.6,
  };

  test("draw a padded code, the name and the score", async () => {
    const html = await panel({ messages: [answer({ episodes: [episode] })] });
    expect(html).toContain("S02E09");
    expect(html).toContain("Blackwater");
    expect(html).toContain("9.6");
  });

  /** finderr has a page for the series and none for the episode, so that is where it goes. */
  test("link to the SERIES, which is the page that exists", async () => {
    const html = await panel({ messages: [answer({ episodes: [episode] })] });
    expect(html).toContain('href="/title/tt0944947"');
    expect(html).not.toContain('href="/title/tt1480055"');
  });

  /**
   * THE RULE THIS WHOLE BLOCK EXISTS FOR. An unrated episode and one the internet hated
   * must never look the same. A zero here would be a claim about the episode that nobody
   * made.
   */
  test("a null score says so in words and never renders as 0", async () => {
    const html = await panel({ messages: [answer({ episodes: [{ ...episode, rating: null }] })] });
    expect(html).toContain("no score yet");
    expect(html).not.toContain(">0.0<");
  });
});

describe("something the assistant requested", () => {
  const requested = [{ tconst: "tt0113277", title: "Heat", kind: "movie" as const }];

  test("says a download STARTED, in a verb nobody can skim past", async () => {
    const html = await panel({ messages: [answer({ requested })] });
    expect(html).toContain("Started downloading 1 film");
    expect(html).toContain("Heat");
  });

  /** The outcome lands somewhere else, and a reader has to be told where. */
  test("points at the requests page, where the outcome actually shows up", async () => {
    expect(await panel({ messages: [answer({ requested })] })).toContain('href="/requests"');
  });

  /**
   * THE REGRESSION. The server reports five statuses and only `queued` spent anything --
   * `already_have`, `already_requested`, `not_found` and `refused` all mean no download.
   * This pane drew every entry under "Started downloading" until the server's real shape
   * was read, which turns a refusal into a claim a reader cannot check.
   */
  test("a refusal is NOT drawn as a download", async () => {
    const html = await panel({
      messages: [
        answer({
          requested: [{ tconst: "tt0113277", title: "Heat", kind: "movie", status: "already_have" }],
        }),
      ],
    });
    expect(html).not.toContain("Started downloading");
    expect(html).toContain("already in your library");
  });

  test("a mixed turn draws both halves and counts only the queued one", async () => {
    const html = await panel({
      messages: [
        answer({
          requested: [
            { tconst: "tt0944947", title: "Game of Thrones", kind: "series", status: "queued" },
            { tconst: "tt0113277", title: "Heat", kind: "movie", status: "not_found" },
          ],
        }),
      ],
    });
    expect(html).toContain("Started downloading 1 series");
    expect(html).toContain("not found");
  });

  /** An episode request says WHICH episode, not just that one was asked for. */
  test("an episode grain prints its code", async () => {
    const html = await panel({
      messages: [
        answer({
          requested: [
            {
              tconst: "tt0944947",
              title: "Game of Thrones",
              kind: "episode",
              season: 2,
              episode: 9,
              status: "queued",
            },
          ],
        }),
      ],
    });
    expect(html).toContain("S02E09");
  });
});

describe("what it did to answer", () => {
  const toolCalls = [
    { name: "search_titles", args: { q: "heist" }, ms: 12 },
    { name: "get_title", args: { tconst: "tt0113277" }, ms: 400 },
  ];

  /**
   * Collapsed by DEFAULT: this is diagnostics, and an answer that opens with a stack of
   * machinery buries the sentence somebody actually asked for.
   */
  test("is a disclosure that starts closed", async () => {
    const html = await panel({ messages: [answer({ toolCalls })] });
    expect(html).toContain("<details");
    expect(html).not.toContain(EXPANDED);
    expect(html).toContain("2 lookups · 412ms");
  });

  test("names each tool and its arguments once opened", async () => {
    const html = await panel({ messages: [answer({ toolCalls })] });
    expect(html).toContain("search_titles");
    expect(html).toContain("tt0113277");
  });

  test("no tool calls draws no disclosure at all", async () => {
    expect(await panel({ messages: [answer({ toolCalls: [] })] })).not.toContain("<details");
  });
});

describe("a failing addon", () => {
  /**
   * The same sentence a failed pane on the title page says, from `problemNote` -- one
   * vocabulary for "an addon is broken" rather than a second invented for the panel.
   */
  test("is named with a reason, in the words the title page already uses", async () => {
    const html = await panel({
      messages: [
        answer({ problems: [{ pluginId: "rotten-tomatoes", facet: "ratings", reason: "timeout" }] }),
      ],
    });
    expect(html).toContain("Unavailable:");
    expect(html).toContain("rotten-tomatoes");
  });
});

describe("refusals", () => {
  /**
   * ABOVE the composer, because a spent budget is still spent for the NEXT attempt -- it is
   * a fact about the box rather than about the turn that provoked it.
   */
  test("a spent budget says when it comes back, not just that it is gone", async () => {
    const html = await panel({
      refusal: {
        kind: "over-limit",
        message: "The daily budget is spent.",
        remainingUsd: 0,
        retryAfterSeconds: 720,
      },
    });
    expect(html).toContain("The daily budget is spent.");
    expect(html).toContain("in 12 minutes");
    expect(html).toContain('role="alert"');
  });

  test("a rate limit is the server's own sentence and nothing added", async () => {
    const html = await panel({ refusal: { kind: "rate-limited", message: "Slow down." } });
    expect(html).toContain("Slow down.");
  });

  /**
   * A turn that failed keeps its place in the thread. Dropping it would take the reader's
   * typing with it, and retyping a paragraph is worse than a visible failure.
   */
  test("a failed turn stays in the thread as a failure", async () => {
    const html = await panel({ messages: [answer({ text: "", error: "Could not reach finderr." })] });
    expect(html).toContain("Could not reach finderr.");
  });
});

describe("what a turn cost", () => {
  test("is printed under the answer, because a metered beta is one somebody is watching", async () => {
    const html = await panel({ messages: [answer({ usage: { costUsd: 0.0031, ms: 2400 } })] });
    expect(html).toContain("$0.0031");
    expect(html).toContain("2.4s");
  });
});

/**
 * THE TRANSCRIPT -- the reason this whole slice exists.
 *
 * One question used to produce one bubble after thirty seconds of nothing. These assert the
 * three things that make the difference visible on screen: a tool call is legible rather
 * than an identifier plus JSON, the machinery is one click away rather than in your face,
 * and a call that never came back says so instead of animating forever.
 */
describe("the transcript of a turn", () => {
  const lookup: TranscriptEntry[] = [
    { kind: "reasoning", key: "e1", turn: 1, text: "Which season is best?" },
    {
      kind: "tool",
      key: "e2",
      turn: 1,
      callId: "c1",
      name: "list_episodes",
      args: { tconst: "tt0944947", season: 2 },
      state: "done",
      ms: 8,
      summary: "24 episodes",
      error: null,
    },
  ];

  test("names the tool in human terms and says what came back", async () => {
    const html = await panel({ messages: [answer({ transcript: lookup })] });
    expect(html).toContain("Episode list");
    expect(html).toContain("24 episodes");
    expect(html).toContain("8ms");
    // The identifier is not what a reader is shown.
    expect(html).not.toContain("list_episodes");
  });

  /** Arguments are LEGIBLE, not `{"tconst":"tt0944947","season":2}`. */
  test("draws arguments as labelled fields rather than as JSON", async () => {
    const html = await panel({ messages: [answer({ transcript: lookup })] });
    expect(html).toContain("title");
    expect(html).toContain("tt0944947");
    expect(html).not.toContain('{"tconst"');
  });

  /**
   * SECONDARY MEANS COLLAPSED, ONCE IT HAS SETTLED. The answer is what the eye should land
   * on; reasoning and raw arguments are one click away, which is a `<details>` that starts
   * closed. The one exception is the block being written right now -- see below.
   */
  test("reasoning and arguments are collapsed on a finished turn", async () => {
    const html = await panel({ messages: [answer({ transcript: lookup })] });
    expect(html).toContain("Thinking");
    expect(html).not.toContain(EXPANDED);
  });

  /**
   * WHILE IT IS THINKING, THE THINKING IS OPEN.
   *
   * aannarr, 2026-09-05. Collapsed-always hid the only moving thing in a thirty-second wait:
   * the reader got a "Thinking" line that never changed and no evidence that tokens were
   * being generated at all. Open while live, folded the moment anything lands after it.
   */
  test("the thinking block being written is open, and pulses", async () => {
    const html = await panel({
      messages: [answer({ pending: true, text: "", transcript: [lookup[0]] })],
    });
    expect(html).toContain(EXPANDED);
    expect(html).toContain("animate-pulse");
  });

  /**
   * The same entry, same `pending` turn, with a lookup underneath it. Position is what
   * closes a thinking block -- `appendProse` can only grow the LAST entry, so anything after
   * it means that block will never receive another token.
   */
  test("a thinking block with a tool call under it has folded away again", async () => {
    const html = await panel({ messages: [answer({ pending: true, text: "", transcript: lookup })] });
    expect(html).toContain("Thinking");
    expect(html).not.toContain(EXPANDED);
    expect(html).not.toContain("animate-pulse");
  });

  /**
   * The restored-transcript case, and the reason `streaming` is a prop rather than something
   * derived from the entries. A conversation read back from `localStorage` is a plain array
   * whose last element looks exactly like a live one.
   */
  test("a restored transcript is not still thinking", async () => {
    const html = await panel({ messages: [answer({ transcript: [lookup[0]] })] });
    expect(html).toContain("Thinking");
    expect(html).not.toContain(EXPANDED);
  });

  /** Most models emit none, and a "Thinking" block over nothing advertises a fiction. */
  test("an empty reasoning entry draws no Thinking block at all", async () => {
    const html = await panel({
      messages: [answer({ transcript: [{ kind: "reasoning", key: "e1", turn: 1, text: "  " }] })],
    });
    expect(html).not.toContain("Thinking");
  });

  /** A spinner that outlives its request is a lie nothing on screen can contradict. */
  test("a tool call that never finished says so rather than spinning", async () => {
    const html = await panel({
      messages: [
        answer({
          transcript: [
            {
              kind: "tool",
              key: "e1",
              turn: 1,
              callId: "c1",
              name: "find_connections",
              args: { from: "tt1", to: "tt2" },
              state: "unfinished",
            },
          ],
        }),
      ],
    });
    expect(html).toContain("did not finish");
    expect(html).not.toContain("animate-spin");
  });

  /** Turn 2 is a new pass of the loop and must not read as turn 1 continuing. */
  test("more than one turn draws a visible seam between them", async () => {
    const html = await panel({
      messages: [
        answer({
          transcript: [
            { kind: "reasoning", key: "e1", turn: 1, text: "look it up" },
            { kind: "reasoning", key: "e2", turn: 2, text: "now answer" },
          ],
        }),
      ],
    });
    expect(html).toContain("Step 2");
  });

  /** One turn has no second half to be told apart from, so the label would be pure chrome. */
  test("a single turn is not labelled", async () => {
    expect(await panel({ messages: [answer({ transcript: lookup })] })).not.toContain("Step 1");
  });

  /**
   * The transcript already lists every call, so the old collapsed summary would draw them
   * twice. It survives only for a bubble restored from before the transcript existed.
   */
  test("the old lookup disclosure is not drawn beside a transcript", async () => {
    const html = await panel({
      messages: [answer({ transcript: lookup, toolCalls: [{ name: "list_episodes", args: {}, ms: 8 }] })],
    });
    expect(html).not.toContain("1 lookup ·");
  });

  /**
   * THE DUPLICATE-PROSE REGRESSION, found in a browser 2026-09-05. A streaming bubble
   * carries the same sentence in two places -- interleaved in the transcript, and in the
   * bubble's own `text` -- and drawing both printed every answer twice on screen. The
   * transcript wins whenever it has prose of its own; see `hasProse`.
   */
  test("streamed prose is drawn once, not twice", async () => {
    const html = await panel({
      messages: [
        answer({
          text: "Season 4 is the one.",
          pending: true,
          transcript: [{ kind: "text", key: "e1", turn: 1, text: "Season 4 is the one." }],
        }),
      ],
      busy: true,
    });
    expect(html.split("Season 4 is the one.").length - 1).toBe(1);
  });

  /** A settled turn has no transcript prose, so the authoritative answer is what draws. */
  test("a settled turn draws the authoritative answer", async () => {
    const html = await panel({
      messages: [answer({ text: "The revised answer.", transcript: lookup })],
    });
    expect(html).toContain("The revised answer.");
  });

  /** Tool rows ARE the activity indicator; a grey placeholder beside them reports it twice. */
  test("a pending bubble with a transcript draws no skeleton", async () => {
    const html = await panel({
      messages: [answer({ text: "", pending: true, transcript: lookup })],
      busy: true,
    });
    expect(html).not.toContain("animate-pulse");
  });
});

describe("markdown in an answer", () => {
  test("renders bold, lists and inline code as real elements", async () => {
    const html = await panel({
      messages: [answer({ text: "**Heat** is:\n\n- long\n- good\n\nrun `find_title`" })],
    });
    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<code");
    // The markers themselves are gone -- they were syntax, not content.
    expect(html).not.toContain("**Heat**");
  });

  /**
   * THE INJECTION PATH. This is model output carrying whatever a tool result put in front
   * of it, and `externalHref` is what stops a bad string becoming script on the page. The
   * words survive; only the address is refused.
   */
  test("a javascript: link is not a link", async () => {
    const html = await panel({ messages: [answer({ text: "[click me](javascript:alert(1))" })] });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
  });

  /** An `<img>` may only load from our own origin -- the opposite guard, same payload. */
  test("a markdown image from an upstream host does not reach an img tag", async () => {
    const html = await panel({ messages: [answer({ text: "![poster](https://image.tmdb.org/x.jpg)" })] });
    expect(html).not.toContain("image.tmdb.org");
    expect(html).toContain("poster");
  });

  test("an ordinary http link keeps its href and opens away from the page", async () => {
    const html = await panel({ messages: [answer({ text: "see [IMDb](https://www.imdb.com/)" })] });
    expect(html).toContain('href="https://www.imdb.com/"');
    expect(html).toContain('rel="noreferrer"');
  });
});

describe("the composer's own markdown", () => {
  /**
   * BOTH ENDS, which is what aannarr asked for. The preview appears only when the draft
   * would render differently from what was typed, so an ordinary question gets no chrome.
   */
  test("nothing is previewed until the draft actually contains markdown", async () => {
    expect(await panel()).not.toContain("Preview");
  });
});

describe("an answer that stopped early", () => {
  /**
   * A TRUNCATED ANSWER MUST NEVER LOOK FINISHED. A model that stopped mid-sentence and one
   * that had nothing more to say produce the same screen otherwise, and only the transport
   * knows which happened.
   */
  test("keeps what arrived and says it is incomplete", async () => {
    const html = await panel({
      messages: [answer({ text: "Season 2 is", incomplete: true, error: "The connection dropped." })],
    });
    expect(html).toContain("Season 2 is");
    expect(html).toContain("This answer is incomplete");
    expect(html).toContain("The connection dropped.");
  });

  /** With nothing to qualify, it is a plain failure and wears the failure's colour. */
  test("a turn that produced no text at all is a failure rather than an incomplete answer", async () => {
    const html = await panel({ messages: [answer({ text: "", error: "Could not reach finderr." })] });
    expect(html).not.toContain("This answer is incomplete");
    expect(html).toContain("Could not reach finderr.");
  });
});

describe("messages typed while a turn was running", () => {
  const queued = [
    { id: "q1", text: "and the worst season?" },
    { id: "q2", text: "request season 2" },
  ];

  /** Drawn as pending, never as sent -- an ordinary bubble would read as a question ignored. */
  test("are shown waiting, with the count", async () => {
    const html = await panel({ queued, busy: true });
    expect(html).toContain("Waiting to send (2)");
    expect(html).toContain("and the worst season?");
    expect(html).toContain("border-dashed");
  });

  test("each one offers the control that removes it", async () => {
    const html = await panel({ queued, onCancelQueued: NOOP });
    expect(html).toContain('aria-label="Cancel &quot;and the worst season?&quot;"');
  });

  /**
   * A failure STOPS the drain rather than firing the rest at a server that just refused.
   * Saying why, and offering the one control that resumes it, is what stops that being a
   * queue that sits there forever with no explanation.
   */
  test("a halted queue says why and offers to send anyway", async () => {
    const html = await panel({ queued, queueHalted: true, onResumeQueue: NOOP });
    expect(html).toContain("Not sent — the last turn failed.");
    expect(html).toContain("Send now");
  });

  /** The composer stays live while busy: typing is queued, not refused. */
  test("the box is not disabled during a turn", async () => {
    const html = await panel({ busy: true, messages: [answer({ text: "", pending: true })] });
    expect(html).toContain("it will be sent next");
    expect(html).not.toContain("<textarea disabled");
  });
});
