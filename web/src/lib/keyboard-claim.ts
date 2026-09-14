/**
 * Who owns the keyboard right now: the page, or something drawn over it.
 *
 * The page's shortcuts are global `window` listeners (`useKeyAction`, `JumpKeys`), which is what
 * lets a key work without tabbing to its button first. That same property is wrong the moment a
 * full-window surface opens over the page: the player binds ← and → to seeking, and the title
 * page behind it binds the same two keys to changing season, so one keypress would do both.
 *
 * > [!IMPORTANT] A CLAIM, NOT A SWALLOW -- and the difference is the React tree inside the player
 * > The obvious fix is a capture-phase listener that calls `stopPropagation` on every key while
 * > the player is open. It stops the page's listeners, and it ALSO stops React's own delegated
 * > listeners on the root container, so every `onKeyDown` inside the player -- the menu's arrow
 * > keys, the volume slider -- goes dead with it. So the page's listeners ask instead: a claimed
 * > keyboard is somebody else's, and they return early.
 *
 * A COUNT rather than a boolean, so two overlays that open and close out of order cannot leave
 * the keyboard claimed by nobody or released while one is still up. The release is idempotent for
 * the same reason: React may run a cleanup twice under StrictMode.
 */

let claims = 0;

/** Take the keyboard from the page. Call the returned function to give it back. */
export function claimKeyboard(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims--;
  };
}

/** Whether something drawn over the page currently owns the keyboard. */
export function keyboardClaimed(): boolean {
  return claims > 0;
}
