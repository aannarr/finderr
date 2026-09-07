# finderr — design

How finderr looks and behaves, as rules rather than screenshots. Read this before adding a
screen; the rules are short because each one was paid for by getting it wrong first.

**This file is maintained.** A decision that changes a rule changes this file in the same
commit. A rule nobody can point at is a rule that gets rediscovered.

## Colour

Nine colours, in `@theme` in `web/src/styles.css`. Everything else is an alias.

| Token | Is |
|---|---|
| `bg` / `surface` / `surface-2` | page, card, raised |
| `line` | every border |
| `ink` / `muted` | text, and quieter text |
| `accent` | the brand green — the primary action, the active state, the focus ring |
| `danger` / `warn` | this destroys something / this is wrong |

**Two shadcn names mean the opposite of ours, and both would ship silently broken.**

- **`muted`** — shadcn's is a *surface*, ours is a *foreground*. `bg-muted` paints a pale
  block on a dark page. Pasted components want `bg-surface-2`.
- **`accent`** — shadcn's is the *subtle hover surface* behind a focused menu item; ours is
  the bright green. `focus:bg-accent` on a menu row is a green highlight bar. Use
  `bg-surface-2`.

**`.border` emits width and style and no colour.** Always pair: `border-b border-line`.

**Colour is never the only signal.** A disabled account has a badge *and* a dimmed avatar; a
destructive button has a colour *and* a confirmation.

## The three action zones

A control's zone is decided by **what it acts on**. Get that right and placement, emphasis and
confirmation all follow. Owned by `web/src/components/settings/Section.tsx`.

| Zone | Subject | Where | Variant |
|---|---|---|---|
| 1 | the section | **under the list**, left-aligned | `default` — additive only |
| 2 | the row | right-aligned, **fixed-width column** | `ghost`, destructive last |
| 3 | the page | bottom, alone | `outline` |

**A destructive verb may never be zone 1.** It is the one control a reader can press having
read a noun and nothing else.

**Zone 1 is under the list, not top-right.** Top-right is a *card* convention and works
because a card is bounded. These sections are full width, so that slot puts the button two
thousand pixels from what it appends to. Where a section is empty, one sentence plus the
button beneath it *is* the call to action.

**The row action column is a fixed width.** This is the single change that stops a list
reading as generic: with `justify-between`, every row's buttons land wherever that row's text
stopped, and the eye has to hunt. Fixed, there is one vertical line of controls down the page.

One filled button per section, maximum. Two accent buttons means neither is primary.

## Confirmation

`ConfirmAction` owns the two-click guard everywhere. Never `window.confirm` — unstyleable,
suppressible, and invisible to a test.

- **`variant="panel"`** — a bordered block where the button was. For a card of stacked verbs.
- **`variant="inline"`** — for a **row**. The question takes over the metadata line; the two
  answers take over the action column. Measured: the row is 82px before and after, at the same
  document position.

**A row swapping to its question must keep every line it had.** `meta` is *swapped*, not added
to, and `note` stays. The first draft dropped the warning while asking and shrank the row from
82px to 62px — reintroducing the exact shift the variant exists to prevent.

A refusal lands **on the control that provoked it**, never at the top of the page. "That is
your only way in" is an answer to one button.

## Rows and sections

A section is a label, a hairline, rows, and its add action. **Not a card** — five identical
bordered cards stacked down a page is uniform weight, which is the absence of a design.

A row is an icon, **two lines** and the action column: the thing at full contrast on top,
everything about it muted underneath. One line separated by middots makes the name and its
metadata one sentence and gives the eye nothing to run down.

`note` is a **third** line in `warn`, only where something is genuinely wrong — a passkey that
dies with its device. A warning that reads like metadata is a warning nobody acts on.

**An empty state states the consequence, not the absence.** "No passkeys" is a fact nobody can
act on; "add one so you are not relying on a single way in" is the same fact with the reason
attached.

## Controls

**`[control] {text}` — the control is on the LEFT.** Radios, checkboxes, switches alike. A
reader binds a control to the label it is next to.

**A boolean is a switch, never a link.** A text link has to state the *inverse* of its own
value to be useful, so the words on screen describe the state you are not in.

**No magic values in a field.** Three states are three named choices. The quota was one number
where `0` secretly meant unlimited and `null` meant follow-the-site — one character apart,
explained in prose underneath. It is a radio group now.

**An option that configures a thing you are about to create has no zone** — it belongs in the
flow that creates it. That is what the agent-key dialog is for.

## Pages lead with the reader

A settings page tells you about **yourself** before it offers you controls. `/account` was five
credential managers and not one fact about the person reading it; their own request count and
allowance lived only on the admin page *about* them.

Stat cells: **label above the number**, every cell a link, the one worth acting on in the
accent — and only while there is something there. A permanent highlight is not a highlight.

Sections are ordered by **why you opened the page**, exit last.

## Motion

Navigation is an instant swap. The one animated navigation is a deliberate ~600ms easter egg
and it stays unspent — a "subtle" transition elsewhere would spend it.

A drawer slides because where it came from is information. `prefers-reduced-motion` gets a
cross-fade, **not a teleport**: iOS reports it in Low Power Mode, so flooring the duration
reads as a feature that was never built.

## Reuse

Grep before writing a component; the existing one is usually better. A surface that needs to
differ takes a **prop**, not a fork — `InertChip`'s tone, `Button`'s variant, `QuotaField`'s
modes.

Three registry components are deliberately absent because this tree owns them: `badge` →
`InertChip`, `card` → `Panel`, `skeleton` → `Skeleton`.

> [!NOTE] The shadcn CLI writes `import { cn } from "cn"` and installs an unrelated npm package
> called `cn`. It wants `@/lib/utils`. Fix the import and `bun remove cn` after every
> `shadcn add`.

## Verify in a browser

Tests prove correctness and say nothing about how a screen looks. Every visual claim here was
read off a real page — the 82px row, the two colour collisions, the duplicated role in a
header. `⌘/` shipped twice looking correct in tests and doing nothing on screen.

Do not write tests for markup. Test behaviour.
