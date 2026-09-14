/**
 * One control-bar menu: a button, and a list of choices that opens ABOVE it.
 *
 * > [!IMPORTANT] RENDERED INSIDE THE STAGE, NEVER PORTALLED
 * > The design-system dropdown portals to `document.body`. Fullscreen puts only the STAGE on
 * > screen, so a menu portalled out of it is drawn somewhere nobody can see -- the menu opens,
 * > takes focus, and is invisible. Inside the stage it goes fullscreen with the video.
 *
 * Track choices are still `player-tracks.ts`'s; this component draws whatever sections it is
 * handed and knows nothing about audio or subtitles. That is what replaced `PlayerTracks`' two
 * native `<select>`s without growing a second owner of what the choices are.
 *
 * Keyboard: the checked item takes focus on open, ↑/↓ move, Enter/Space choose (they are
 * buttons), Escape closes and hands focus back to the trigger. Every key it handles stops there,
 * so the player's global ↑/↓ (volume) does not also fire.
 */

import { Check } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

export interface MenuOption<V> {
  value: V;
  label: string;
}

export interface MenuSection<V = unknown> {
  heading: string;
  options: MenuOption<V>[];
  /** The checked option, compared with `===`. */
  value: V;
  onSelect: (value: V) => void;
}

export function PlayerMenu({
  id,
  label,
  icon,
  shortcut,
  open,
  onOpenChange,
  sections,
  className,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  /** The key glyph the trigger's tooltip wears, from `playerGlyph`. */
  shortcut?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // biome-ignore lint/suspicious/noExplicitAny: each section carries its own value type
  sections: MenuSection<any>[];
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const items = list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]");
    const checked = list.current?.querySelector<HTMLButtonElement>("[aria-checked=true]");
    (checked ?? items?.[0])?.focus();
  }, [open]);

  const close = (refocus: boolean) => {
    onOpenChange(false);
    if (refocus) trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <ControlButton
        ref={trigger}
        label={label}
        shortcut={shortcut}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        active={open}
        onClick={() => onOpenChange(!open)}
      >
        {icon}
      </ControlButton>
      {open ? (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute right-0 bottom-12 z-10 max-h-[min(24rem,60vh)] w-60 overflow-y-auto rounded-xl bg-surface/95 py-1.5 text-sm shadow-[0_8px_28px_rgba(0,0,0,.55)] ring-1 ring-line backdrop-blur"
        >
          {sections.map((section, s) => (
            <div key={section.heading} className={cn(s > 0 && "mt-1.5 border-t border-line pt-1.5")}>
              <p className="px-3 pt-1 pb-1.5 text-xs font-medium text-muted">{section.heading}</p>
              {section.options.map((option) => {
                const checked = option.value === section.value;
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    onClick={() => {
                      section.onSelect(option.value);
                      close(true);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2",
                      checked && "bg-surface-2/60",
                    )}
                  >
                    <span className="w-4 text-accent" aria-hidden="true">
                      {checked ? <Check className="size-4" /> : null}
                    </span>
                    <span className="truncate">{option.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One round icon control in the bar, with its name and key in a tooltip.
 *
 * The tooltip is CSS-only and hidden from the accessibility tree: the button's `aria-label` and
 * `aria-keyshortcuts` already say both things to a screen reader, and a second announcement of
 * the same words is noise.
 */
export function ControlButton({
  ref,
  label,
  shortcut,
  active,
  className,
  children,
  ...rest
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  shortcut?: string;
  active?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className">) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-keyshortcuts={shortcut && shortcut !== "Space" ? shortcut : undefined}
      className={cn(
        "group/ctl relative grid size-10 shrink-0 place-items-center rounded-full text-ink outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-accent [&_svg]:size-[22px]",
        active && "bg-white/10",
        className,
      )}
      {...rest}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-12 left-1/2 hidden -translate-x-1/2 items-center gap-1.5 rounded-md bg-surface px-2 py-1 text-xs whitespace-nowrap ring-1 ring-line group-hover/ctl:flex group-focus-visible/ctl:flex group-aria-expanded/ctl:hidden"
      >
        {label}
        {shortcut ? (
          <kbd className="rounded border border-line bg-surface-2 px-1 text-[0.75em] text-muted">
            {shortcut}
          </kbd>
        ) : null}
      </span>
    </button>
  );
}
