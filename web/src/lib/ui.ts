/**
 * Class strings that more than one screen shares.
 *
 * Small on purpose. Most styling in this tree belongs next to the markup it describes, and
 * hoisting it here would put the appearance of a component somewhere other than the
 * component. What lands in this file is a string that had ALREADY been written out
 * identically in more than one place -- where the cost of a second copy is that the two
 * drift and nobody notices which one is right.
 */

/**
 * A button that reads as a link: the quiet, inline action.
 *
 * "Add this device", "Revoke", "Reset access", "Turn on for this device". It was copied
 * verbatim into `AccountRoute` and `AdminRoute` and was about to be copied a third time
 * into the notification switch, which is what earned it one owner.
 *
 * It is a CLASS rather than a `<LinkButton>` component, which the fourteen call sites would
 * arguably justify -- but every one of them is `<button type="button" className={...}>` with
 * its own handler and its own label, so the component would wrap nothing that is not
 * already there. The string is the duplication; the button is not.
 */
export const LINK_BUTTON = "text-sm text-muted underline underline-offset-4 hover:text-ink";

/**
 * THE one action a block is for: full width, filled with the accent, unmissable.
 *
 * The title page's Request button and `PlayOnPlex`'s `block` variant had written this out
 * character for character, and "Play here" was about to be the third -- which is the line
 * this file draws. It is what makes the primary slot recognisable as one slot: whatever a
 * title's state turns out to be, the thing to press looks the same.
 *
 * `block` and `text-center` are redundant on a `<button>` and required on an `<a>`, and they
 * live here rather than at the two call sites so the two elements cannot drift apart.
 */
export const PRIMARY_BUTTON = `block w-full rounded-lg bg-accent px-3 py-2 text-center text-sm font-medium
   text-black transition-opacity hover:opacity-90 active:opacity-75`;

/**
 * A real action that is not the point: the same size as `PRIMARY_BUTTON`, with an outline
 * instead of a fill.
 *
 * What sits UNDER the primary slot -- "Play on Plex" once we can play it here ourselves,
 * "Request missing seasons" under whichever control said we hold the series. Same size on
 * purpose: these are not smaller offers, they are quieter ones, and shrinking them would
 * make them harder to hit rather than easier to ignore.
 */
export const SECONDARY_BUTTON = `block w-full rounded-lg border border-line px-3 py-2 text-center text-sm
   text-muted transition hover:border-ink hover:text-ink`;
