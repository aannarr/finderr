/**
 * The title page's play control: ONE default action, and every other way to play in its menu.
 *
 * `[ Play on Plex | v ]`. The big half is the answer that works for every reader -- Plex, on
 * their own device, with their history and their subtitles. The chevron holds what is true
 * only for some readers or some machines: "Play here" (an admin, and a file the arr will admit
 * to), the Plex app's scheme link, and the arr's own page for the title.
 *
 * It replaced a column of stacked controls -- an accent "Play here", an outlined "Play on
 * Plex", and two text links under them -- which gave four ways to start one film the weight
 * of four separate decisions. aannarr, 2026-09-14: "THIS MUST BE A DROP DOWN". Add to
 * watchlist is deliberately NOT in here: it keeps a note rather than playing anything, so it
 * stays its own button underneath.
 *
 * WHICH OPTIONS a reader gets is `playOptions`, pure and tested without a DOM; the markup
 * only draws the list it is handed. Nothing here can push the header around: `arrLink`
 * arrives with the detail response rather than at t=0, and it lands INSIDE a closed menu.
 *
 * THE PLAYER IS NOT OWNED HERE. The route holds the one `usePlayHere` for the page and hands the
 * control in, because the seasons pane starts episodes from the same player -- two hooks would be
 * two players. The route renders the player node.
 */

import { AppWindow, ChevronDown, MonitorPlay, SquareArrowOutUpRight } from "lucide-react";
import type { Title } from "../lib/api";
import { clock } from "../lib/playback-report";
import { PRIMARY_BUTTON } from "../lib/ui";
import type { TitleDetailView } from "../lib/use-title-detail";
import { cn } from "../lib/utils";
import { canPlayHere, type PlayHereControl, type PlayTarget } from "./PlayHere";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type PlayableTitle = Pick<Title, "hasFile" | "plex">;
type ArrLink = TitleDetailView["arrLink"];

export type PlayOption =
  | { kind: "here" }
  | { kind: "plex-app"; href: string }
  | { kind: "arr"; href: string; label: string };

/** Which action owns the big half, or null when this reader has nothing to play. */
export function playDefault(title: PlayableTitle, isAdmin: boolean): "plex" | "here" | null {
  if (title.plex) return "plex";
  if (canPlayHere(title, isAdmin)) return "here";
  return null;
}

/** Whether the title page draws this control at all -- the route asks rather than re-derives. */
export function hasPlayMenu(title: PlayableTitle, isAdmin: boolean): boolean {
  return playDefault(title, isAdmin) !== null;
}

/** The menu, in order: the other ways to play first, the maintenance door last. */
export function playOptions(title: PlayableTitle, isAdmin: boolean, arrLink: ArrLink): PlayOption[] {
  const primary = playDefault(title, isAdmin);
  if (!primary) return [];
  const options: PlayOption[] = [];
  if (primary !== "here" && canPlayHere(title, isAdmin)) options.push({ kind: "here" });
  if (title.plex) options.push({ kind: "plex-app", href: title.plex.app });
  // `isAdmin` is not the rule -- the server sends `arrLink: null` to everybody else. It keeps
  // a stale client from drawing a door it was never meant to have.
  if (isAdmin && arrLink) options.push({ kind: "arr", href: arrLink.url, label: arrLink.label });
  return options;
}

/** The two halves share `PRIMARY_BUTTON`'s look and meet at a hairline rather than a gap. */
const MAIN_HALF = "min-w-0 flex-1 rounded-r-none";
const TOGGLE_HALF = `flex shrink-0 items-center rounded-r-lg border-l border-black/20 bg-accent px-2.5
   text-black transition-opacity hover:opacity-90 active:opacity-75 disabled:opacity-60
   data-[state=open]:opacity-90`;

export function PlayMenu({
  title,
  isAdmin,
  arrLink,
  control,
  playTarget,
  resumeAt = null,
}: {
  title: Pick<Title, "tconst" | "hasFile" | "plex">;
  isAdmin: boolean;
  arrLink: ArrLink;
  /** The page's one player. */
  control: PlayHereControl;
  /** What "Play here" starts: for a series, the episode to resume or the first one we hold. */
  playTarget?: PlayTarget;
  /** Where the reader stopped, when there is a point worth resuming. Names the control. */
  resumeAt?: number | null;
}) {
  const { state, play } = control;
  const primary = playDefault(title, isAdmin);
  if (!primary) return null;

  const options = playOptions(title, isAdmin, arrLink);
  const starting = state.kind === "starting";
  const start = () => void play(playTarget);
  const hereLabel = resumeAt !== null ? `Resume ${clock(resumeAt)}` : "Play here";

  return (
    <div>
      <div className="flex">
        {primary === "plex" && title.plex ? (
          <a href={title.plex.web} target="_blank" rel="noreferrer" className={cn(PRIMARY_BUTTON, MAIN_HALF)}>
            Play on Plex
          </a>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className={cn(PRIMARY_BUTTON, MAIN_HALF, "disabled:opacity-60")}
          >
            {starting ? "Starting…" : hereLabel}
          </button>
        )}

        {/*
          Always drawn, disabled when empty: the only reader who can reach an empty menu is an
          admin whose arr link has not arrived yet, and a chevron appearing late would narrow
          the button under their cursor.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More ways to play"
            disabled={options.length === 0}
            className={TOGGLE_HALF}
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {options.map((option, i) => (
              <PlayOptionItem
                key={option.kind}
                option={option}
                afterOthers={i > 0}
                hereLabel={resumeAt !== null ? `Resume here at ${clock(resumeAt)}` : "Play here"}
                onPlayHere={start}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* The default half says "Starting…" itself; from the menu, nothing on screen would. */}
      {starting && primary !== "here" ? (
        <p className="mt-1.5 text-center text-xs text-muted">Starting playback…</p>
      ) : null}
      {state.kind === "failed" ? (
        <p className="mt-1.5 text-center text-xs text-muted">{state.message}</p>
      ) : null}
    </div>
  );
}

/** Two lines per item: what it does, and in muted text why you would pick it over the default. */
function ItemText({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-ink">{label}</span>
      <span className="text-xs text-muted">{hint}</span>
    </span>
  );
}

const ITEM = "items-start [&_svg]:mt-0.5";

function PlayOptionItem({
  option,
  afterOthers,
  hereLabel,
  onPlayHere,
}: {
  option: PlayOption;
  afterOthers: boolean;
  hereLabel: string;
  onPlayHere: () => void;
}) {
  switch (option.kind) {
    case "here":
      return (
        <DropdownMenuItem className={ITEM} onSelect={onPlayHere}>
          <MonitorPlay aria-hidden="true" />
          <ItemText label={hereLabel} hint="Stream it in this browser tab" />
        </DropdownMenuItem>
      );
    case "plex-app":
      /* No `target`: a `plex:` link hands off to the app, and a tab would be left behind empty. */
      return (
        <DropdownMenuItem asChild className={ITEM}>
          <a href={option.href}>
            <AppWindow aria-hidden="true" />
            <ItemText label="Open in the Plex app" hint="Play it in the Plex app on this device" />
          </a>
        </DropdownMenuItem>
      );
    case "arr":
      /* `noreferrer`: the arr has no business learning which title page sent an admin to it. */
      return (
        <>
          {afterOthers ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem asChild className={ITEM}>
            <a href={option.href} target="_blank" rel="noopener noreferrer">
              <SquareArrowOutUpRight aria-hidden="true" />
              <ItemText label={`Open in ${option.label}`} hint="Manage the file, quality and downloads" />
            </a>
          </DropdownMenuItem>
        </>
      );
  }
}
