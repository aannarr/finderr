/**
 * Render a component into a real DOM, press things, and assert what happened.
 *
 * # WHICH IDIOM A NEW TEST USES -- the rule, and it is not a preference
 *
 * There are exactly two, and the question that picks between them is whether the assertion
 * is about what a component DRAWS or about what it DOES.
 *
 * - **`renderInRouter` (`./render-in-router.tsx`) is the DEFAULT.** Static markup from
 *   `react-dom/server`: the resting state a component produces from props. No DOM, no
 *   cleanup, microseconds each. Almost every component test in this repo is one of these and
 *   they should stay that way -- "does this pane draw the certification when it has one" is
 *   a markup question and rendering it twice would prove nothing extra.
 * - **This harness is for BEHAVIOUR**: a state transition, a click, a keystroke, an async
 *   settle, an effect that hangs a listener. Anything where the interesting moment is the
 *   SECOND render.
 *
 * The boundary is sharp enough to apply without asking: if the test never fires an event and
 * never awaits anything, it does not need this file.
 *
 * # WHY IT EXISTS
 *
 * `renderToStaticMarkup` renders once and stops, so a component that draws correctly and
 * then does nothing on click is indistinguishable from a correct one. This repo has shipped
 * that failure three times -- `⌘/` bound to nothing, twice in one day, and `ConfirmAction`
 * left in the asking state after a successful confirm, so a label-flipping action sat one
 * click from a primed "Yes, enable" that would undo what had just happened. Every static
 * test passed over all three. The first two were caught by a reader, the third by a seat
 * driving a browser because a card had told it to. A defence that depends on somebody
 * remembering to open a browser is not a defence.
 *
 * # HOW IT IS WIRED
 *
 * The DOM is registered by `./dom.ts`, loaded as `--preload` by the `test:web` script, so it
 * is on the globals before any test file is imported and the whole web suite runs against one
 * environment. See that file for why it cannot be done from here, and for why the SERVER
 * suite must not have it.
 *
 * A consequence worth knowing before you run one file by hand: a bare
 * `bun test web/src/components/ConfirmAction.test.tsx` has no DOM and dies with
 * `document is not defined`. Run these through `bun run test:web`, which carries the flag,
 * and narrow with `-t "<name>"`.
 *
 * Everything `@testing-library/react` exports is re-exported rather than curated, so this is
 * a seam and not a second API to keep in step: one named door for the behaviour idiom, one
 * import to change if the harness under it ever does. Unmounting between tests is the
 * preload's job and not this file's -- `./dom.ts` says why, and getting that wrong is green
 * for exactly as long as one file uses the harness.
 */

export * from "@testing-library/react";
