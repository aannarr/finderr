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
 * > Kept local rather than shared, because this is so far the only file that needs it.
 */

import { describe, expect, test } from "bun:test";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoredMessage } from "../lib/agent-store";
import { AssistantPanel, type AssistantPanelProps } from "./AssistantPanel";

/** Render anything that contains a `<Link>`, with a router that has finished loading. */
async function renderRouted(node: ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{node}</> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

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
    expect(html).not.toContain("<details open");
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
