/**
 * The assistant's presence in the app: whether it exists here, its launcher, and its key.
 *
 * > [!IMPORTANT] A DEPLOYMENT WITHOUT AN ASSISTANT DRAWS NOTHING AT ALL
 * > Not a disabled button, not a tooltip explaining what is missing, not an error on click.
 * > `/api/agent/chat` answers 404 where no model is configured and 403 where the beta is
 * > admin-only, and either answer removes this component from the page entirely. A control
 * > that can only fail is worse than no control: it advertises a feature to somebody who
 * > cannot enable it, on every screen, forever.
 *
 * > [!CAUTION] The probe is the SERVER's answer and never a client-side role check
 * > `useApp().isAdmin` is right here today and would be the wrong thing to gate on: the
 * > beta's audience is the server's decision, so the day it widens to everybody this
 * > component needs no change and no deploy of the browser bundle. Asking is one request
 * > that usually 404s, once per page load. Reading a flag instead would be a second owner
 * > of a rule that lives on the server.
 *
 * The conversation lives HERE rather than in the panel, so closing the panel mid-answer
 * does not throw the answer away -- see `useAssistantChat`.
 */

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type AgentAvailability, probeAgent } from "../lib/agent-api";
import { useAssistantChat } from "../lib/use-assistant-chat";
import { AssistantPanel } from "./AssistantPanel";
import { useKeyAction } from "./Kbd";
import { Button } from "./ui/button";

export function Assistant({ userId }: { userId: string | null }) {
  /** `null` until the probe answers. Nothing is drawn in the meantime. */
  const [availability, setAvailability] = useState<AgentAvailability | null>(null);
  const [open, setOpen] = useState(false);

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
    setOpen(false);
  }, []);

  const chat = useAssistantChat({ userId, onGone });

  const toggle = useCallback(() => setOpen((v) => !v), []);
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
        aria-expanded={open}
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
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30 bg-black/50 sm:hidden"
            />
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
              onClose={() => setOpen(false)}
            />
          </>,
          document.body,
        )}
    </>
  );
}
