/**
 * The `?` overlay: every key the player answers to, rendered FROM the keymap.
 *
 * Nothing here spells a key. The rows are `PLAYER_SHORTCUT_ROWS` and the glyphs come off the
 * bindings the handler matches, so this overlay cannot teach a key the player ignores -- the
 * failure a hand-written help sheet always ends in.
 */

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { PLAYER_SHORTCUT_ROWS, shortcutGlyphs } from "../../lib/keymap";

export function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/55 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="player-shortcuts-title"
        className="max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl bg-surface p-5 ring-1 ring-line sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="player-shortcuts-title" className="text-lg font-semibold">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close shortcuts"
            onClick={onClose}
            className="grid size-9 place-items-center rounded-full text-muted outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="grid gap-x-8 gap-y-5 text-sm sm:grid-cols-2">
          {PLAYER_SHORTCUT_ROWS.map(({ group, rows }) => (
            <section key={group} aria-label={group}>
              <h3 className="mb-2 text-xs font-medium text-muted">{group}</h3>
              <ul className="space-y-1.5">
                {rows.map((row) => (
                  <li key={row.label} className="flex items-center justify-between gap-4">
                    <span>{row.label}</span>
                    <span className="flex shrink-0 gap-1">
                      {shortcutGlyphs(row).map((glyph) => (
                        <kbd
                          key={glyph}
                          className="min-w-6 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-center text-xs text-ink"
                        >
                          {glyph}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
