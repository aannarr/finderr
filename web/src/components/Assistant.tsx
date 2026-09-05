/**
 * The assistant's presence in the app: whether it exists here, its launcher, and its key.
 *
 * > [!IMPORTANT] A DEPLOYMENT WITHOUT AN ASSISTANT DRAWS NOTHING AT ALL
 * > Not a disabled button, not a tooltip explaining what is missing, not an error on click.
 * > `/api/agent/chat` answers 404 where no model is configured, and any refusal the probe
 * > returns removes this component from the page entirely. A control that can only fail is
 * > worse than no control: it advertises a feature to somebody who cannot enable it, on
 * > every screen, forever.
 *
 * > [!CAUTION] The probe is the SERVER's answer and never a client-side role check
 * > `useApp().isAdmin` is in reach here and would be the wrong thing to gate on: the
 * > audience is the server's decision, and it was proved on 2026-09-05 -- the assistant
 * > widened from admins to every signed-in account and this component needed no change and
 * > no deploy of the browser bundle. Asking is one request, once per page load. Reading a
 * > flag instead would be a second owner of a rule that lives on the server.
 *
 * The conversation lives HERE rather than in the panel, so closing the panel mid-answer
 * does not throw the answer away -- see `useAssistantChat`.
 */

import { useRouterState } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type AgentAvailability, probeAgent } from "../lib/agent-api";
import { drawerMs, isCompactViewport } from "../lib/drawer-motion";
import { useAssistantChat } from "../lib/use-assistant-chat";
import { useKeyAction } from "./Kbd";
import { Button } from "./ui/button";

/*
  THE PANEL IS ITS OWN CHUNK, and this import is the whole mechanism.

  Everything the assistant needs -- the transcript, the markdown parser, the shadcn
  primitives, lucide's icons -- is reachable only from `AssistantPanel`. A static import
  would weld all of it into the main bundle for every reader, including the ones who never
  open it and the ones an unconfigured deployment never even shows a launcher to.

  There is precedent in this tree for splitting on exactly this reasoning: `login.html` is a
  SECOND vite entry so an anonymous visitor is never handed the application chunk. Same
  mechanism, different reason.

  The LAUNCHER stays in the main bundle deliberately -- it is a button and a fetch, and
  deferring it would trade a few hundred bytes for a visible pop-in on every page load.
*/
const AssistantPanel = lazy(() => import("./AssistantPanel").then((m) => ({ default: m.AssistantPanel })));

export function Assistant({ userId }: { userId: string | null }) {
  /** `null` until the probe answers. Nothing is drawn in the meantime. */
  const [availability, setAvailability] = useState<AgentAvailability | null>(null);
  const [open, setOpen] = useState(false);
  /**
   * The panel is on its way out: still mounted, sliding right, and about to go.
   *
   * A second flag rather than an `"open" | "closing" | "closed"` enum because `open` already
   * means something the rest of this component depends on -- the launcher's `aria-expanded`,
   * the keyboard toggle -- and a retracting panel is genuinely still open as far as either
   * is concerned. It answers no questions once `open` is false, and `close()` is the only
   * thing that sets it.
   */
  const [retracting, setRetracting] = useState(false);

  useEffect(() => {
    // Aborted on unmount so a route change during the probe does not set state on a gone
    // component -- and so a slow 404 does not hold a socket open behind a page nobody is on.
    const ac = new AbortController();
    void probeAgent(ac.signal)
      .then(setAvailability)
      .catch(() => setAvailability("absent"));
    return () => ac.abort();
  }, []);

  /**
   * The server changed its mind mid-session.
   *
   * A probe that answered at boot can be contradicted by a real turn: a deploy removed the
   * key, or an admin lost the role. The launcher goes rather than staying to fail again,
   * and the panel closes with it -- but only for `absent` and `forbidden`, never for a
   * budget or a rate limit, which are waits and belong in the panel.
   */
  const onGone = useCallback(() => {
    setAvailability("absent");
    // No retraction here. The feature has gone away underneath the reader, and sliding a
    // panel out politely to report that would keep a dead surface on screen for another
    // fifth of a second. The launcher disappears in the same commit.
    setRetracting(false);
    setOpen(false);
  }, []);

  const chat = useAssistantChat({ userId, onGone });

  /** Start the slide. The timer below is what actually removes the panel. */
  const close = useCallback(() => setRetracting(true), []);

  /*
    UNMOUNT ONCE IT HAS FINISHED LEAVING, and not before.

    `drawerMs()` is the same number the CSS animates over, and is zero for a reader who asked
    for reduced motion -- for whom the panel is already off the screen, so waiting would only
    leave an invisible element over the page still taking their taps.

    The cleanup matters more than it looks: `onGone` can clear `open` mid-slide, and without
    it a stale timer would fire afterwards and set state on a component the probe just
    removed from the tree.
  */
  useEffect(() => {
    if (!retracting) return;
    const t = setTimeout(() => {
      setOpen(false);
      setRetracting(false);
    }, drawerMs());
    return () => clearTimeout(t);
  }, [retracting]);

  const toggle = useCallback(() => {
    // Mid-retraction the launcher brings it straight back rather than queueing a second
    // close behind the first: the reader is looking at a panel sliding away and pressing
    // the button that summons it.
    if (retracting) {
      setRetracting(false);
      setOpen(true);
      return;
    }
    if (open) close();
    else setOpen(true);
  }, [open, retracting, close]);

  /*
    NAVIGATION RETRACTS IT, ON A PHONE ONLY.

    aannarr, 2026-09-05: on a small screen the drawer IS the screen, so following a title
    link out of an answer used to leave the reader looking at the same conversation with the
    page they asked for hidden behind it -- the navigation happened and nothing on screen
    said so. It parks at the right edge instead, and stays parked until the launcher is used
    again; nothing brings it back on its own, because a panel that reappeared over the page
    would undo the move that dismissed it.

    On a desktop this does nothing, deliberately. The page renders BESIDE the panel there,
    which is the whole reason those links are drawn -- see the scrim's own note below. So the
    condition is the VIEWPORT rather than the device, and it is the same breakpoint the
    panel's width class uses.

    Keyed on the full `href` rather than the pathname: `/browse?genre=Horror` and
    `/term/service/netflix?country=TH` are navigations the reader can only see the result of
    if this gets out of the way, and neither changes the path.
  */
  const href = useRouterState({ select: (s) => s.location.href });
  const lastHref = useRef(href);
  useEffect(() => {
    const moved = lastHref.current !== href;
    lastHref.current = href;
    if (moved && open && !retracting && isCompactViewport()) close();
  }, [href, open, retracting, close]);

  // Bound only while the feature is actually here, so the key and the button appear and
  // disappear together -- `useKeyAction`'s `enabled` withdraws the glyph and the
  // `aria-keyshortcuts` at the same time, which is the whole reason it takes the flag.
  const key = useKeyAction("assistant", toggle, availability === "available");

  if (availability !== "available") return null;

  return (
    <>
      {/*
        In the header's right-hand group, beside Admin and the account link, because that is
        where this app already puts "things about you and your session" as opposed to the
        sections everybody shares. A floating bubble over the bottom-right corner was the
        obvious alternative and is the one element that would belong to a different product.
      */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={toggle}
        // A retracting panel is already gone as far as a reader is concerned, so it is
        // reported closed from the moment the slide starts rather than a fifth of a second
        // later. `open` alone would announce a state that is on its way out.
        aria-expanded={open && !retracting}
        aria-label="Assistant"
        title="Assistant"
        {...key.props}
      >
        <Sparkles />
      </Button>

      {open &&
        /*
          > [!CAUTION] THE PANEL IS PORTALLED TO `body`, AND IT DOES NOT WORK OTHERWISE
          > This launcher sits in the sticky header, which carries `backdrop-blur`. A
          > `backdrop-filter` makes an element the CONTAINING BLOCK for every `fixed`
          > descendant -- so a `fixed inset-y-0` drawer rendered here is positioned against
          > the HEADER instead of the viewport, and comes out 123px tall with its message
          > list collapsed to nothing. Nothing errors, the panel is visibly there, and the
          > composer simply sits where the conversation should be. Measured in a browser
          > 2026-09-05; the CSS is correct and the ancestor is what changes its meaning.
          >
          > `transform`, `filter`, `perspective`, `will-change` and `contain: paint` do the
          > same thing. Moving the launcher elsewhere in the header would not fix it -- the
          > whole bar is inside the blurred element.
        */
        createPortal(
          <>
            {/*
              The scrim is SMALL SCREENS ONLY, and that is a decision rather than an oversight.
              On a phone the panel is the whole screen and the page behind it is unreachable,
              so dimming it says so and gives a tap target to leave by. On a desktop the page
              beside the panel stays readable and clickable on purpose -- following a title
              link out of an answer is the point of drawing those links, and a scrim that
              closed the panel on the way would make that a two-step move.
            */}
            <button
              type="button"
              aria-label="Close the assistant"
              onClick={close}
              // It FADES where the panel slides, because it is not an object arriving from
              // an edge -- it is the page being dimmed, and dimming has no direction. Same
              // duration either way, so the two land on the same frame. The classes live in
              // `styles.css` beside the drawer's, for the reduced-motion reason stated there.
              className={`fdr-scrim fixed inset-0 z-30 bg-black/50 sm:hidden ${
                retracting ? "fdr-scrim-out" : "fdr-scrim-in"
              }`}
            />
            {/*
              `fallback={null}` rather than a skeleton, on purpose.

              The chunk is fetched the instant the panel is asked for, from the same origin
              that just served the page, so the wait is a few milliseconds on any connection
              that got this far. A skeleton would flash and leave -- which reads as a glitch,
              where nothing reads as instant.
            */}
            <Suspense fallback={null}>
              <AssistantPanel
                messages={chat.messages}
                busy={chat.busy}
                refusal={chat.refusal}
                queued={chat.queued}
                queueHalted={chat.queueHalted}
                onSend={chat.send}
                onCancelQueued={chat.cancelQueued}
                onResumeQueue={chat.resumeQueue}
                onClear={chat.clear}
                onClose={close}
                retracting={retracting}
              />
            </Suspense>
          </>,
          document.body,
        )}
    </>
  );
}
