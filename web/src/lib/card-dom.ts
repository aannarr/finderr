/**
 * How other code ADDRESSES a title card in the DOM: the card, its link, its request button.
 *
 * Three features now reach into a rendered `TitleCard` from outside it -- navigation mode
 * clicks its link, the grid's arrow keys focus it, and `⌘⏎` presses its request button --
 * and each of them was one `querySelector("a[href]")` away from encoding its own idea of
 * what a card looks like. That is three copies of one piece of knowledge, and the copies
 * break silently: a card that grows a second link above the poster keeps rendering
 * perfectly and quietly sends the keyboard somewhere else.
 *
 * So the hooks are named here, once, and `TitleCard` is the only file that sets them.
 * A module of its own rather than an export from `TitleCard` because `JumpKeys` is one of
 * the readers and `TitleCard` already imports `JumpKeys` -- a constant living in either
 * would make that a cycle.
 */

/** The card itself: the unit arrow keys move between. */
export const CARD_SELECTOR = "[data-card]";

/**
 * The card's PRIMARY link -- the poster overlay, which owns where the card goes and the
 * prefetch on the way. It is what navigation mode clicks and what arrow keys focus, so
 * both land a reader on the same element a mouse would have.
 */
export const CARD_LINK_SELECTOR = "[data-card-link]";

/**
 * The card's request button, present only when the title can actually be requested.
 *
 * `RequestAction` draws a `<button>` for a requestable title and a `<span>` for one that is
 * owned, pending or a dead end, so the ABSENCE of this element is the answer to "may this
 * be requested" -- asked of the one component that owns the rule rather than re-derived
 * from `inLibrary` and `requestVerdict` at a second site.
 */
export const CARD_REQUEST_SELECTOR = "[data-card-request]";
