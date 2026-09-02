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
