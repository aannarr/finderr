/**
 * The one joke in this product, and the ONLY animated navigation in it.
 *
 * > [!IMPORTANT] finderr does not animate navigation. At all. This is the single exception.
 * > A slide-and-morph set was built first -- directional page slide, a pinned header, a
 * > poster that flew from the grid card to the title page -- and aannarr cut all of it on
 * > 2026-09-01 in favour of nothing. Navigation is now an instant swap: `types` below
 * > returns `false` for every ordinary move, which makes `router-core` skip
 * > `document.startViewTransition` entirely rather than run a zero-length animation.
 * >
 * > That is what makes the joke land. A wipe is a surprise in an app that never moves; in an
 * > app that slides and morphs on every click it is just a longer version of the usual
 * > thing. **Adding a "subtle" transition back would not be a change beside this feature --
 * > it would spend it.**
 *
 * Opening a Star Wars title therefore goes from an instant swap to a 600ms horizontal wipe,
 * the scene transition the films are known for, and nothing else in the product moves like
 * that or is allowed to.
 *
 * **If deleting this file does not delete the joke, the joke has leaked.** That is the
 * design constraint, not a tidiness preference: an easter egg sprinkled across four files is
 * one nobody dares touch later. Everything here is a pure function; the only wiring outside
 * this file is one call in the router's `types` resolver and one block in `styles.css`.
 *
 * Rarity is what keeps it a gift rather than a tax -- at most once every three minutes, and
 * never before the reader has seen an ordinary instant navigation to compare it against. The
 * throttle is not a nicety and must never be loosened "just for testing".
 */

/**
 * Every Star Wars title, by IMDb id.
 *
 * > [!WARNING] A hardcoded list is the RIGHT answer here. Do not replace it with matching.
 * > Every clever alternative was considered and each is worse:
 * >
 * > - **Title matching fails in both directions, badly.** Against our own index, `star wars`
 * >   also returns *Angry Birds Star Wars Rebels*, *Nissan Rogue: Star Wars Rogue One Battle
 * >   Tested*, *Rifftrax: Solo*, *Cheap Star Wars Clone* and a dozen reaction channels --
 * >   while MISSING *Andor*, *Ahsoka*, *The Mandalorian*, *Rogue One*, *Solo*, *Skeleton
 * >   Crew* and *The Acolyte*, none of which contain the string. A wipe that fires on a
 * >   making-of documentary but not on Andor is worse than no wipe.
 * > - **The `collection` and `keywords` facets would answer it properly, and arrive too
 * >   late.** They resolve asynchronously -- that is the architecture of this whole app --
 * >   but the transition must be chosen at CLICK time, from the local row, which carries no
 * >   such field. `studio` is half a signal: Lucasfilm identifies the films, but for a series
 * >   that column holds the NETWORK (Disney+), so it misses every show.
 * >
 * > So: about thirty ids, no false positives possible, no facet, no call, no new field.
 * > Lucasfilm ships something new roughly once a year and adding a line takes ten seconds.
 *
 * Every id below was read out of the live index rather than from memory, which immediately
 * caught `Andor` and `The Bad Batch` written the wrong way round.
 */
const STAR_WARS: ReadonlySet<string> = new Set([
  // The Skywalker saga.
  "tt0076759", // Episode IV - A New Hope (1977)
  "tt0080684", // Episode V - The Empire Strikes Back (1980)
  "tt0086190", // Episode VI - Return of the Jedi (1983)
  "tt0120915", // Episode I - The Phantom Menace (1999)
  "tt0121765", // Episode II - Attack of the Clones (2002)
  "tt0121766", // Episode III - Revenge of the Sith (2005)
  "tt2488496", // Episode VII - The Force Awakens (2015)
  "tt2527336", // Episode VIII - The Last Jedi (2017)
  "tt2527338", // Episode IX - The Rise of Skywalker (2019)

  // Films outside the saga.
  "tt3748528", // Rogue One (2016)
  "tt3778644", // Solo (2018)
  "tt1185834", // The Clone Wars (2008, the animated film)
  "tt0193524", // The Star Wars Holiday Special (1978) -- canon enough for a joke
  "tt0087225", // The Ewok Adventure (1984)

  // Television.
  "tt0361243", // Clone Wars (2003, Tartakovsky)
  "tt0458290", // The Clone Wars (2008)
  "tt2930604", // Rebels (2014)
  "tt8336340", // Resistance (2018)
  "tt8111088", // The Mandalorian (2019)
  "tt12708542", // The Bad Batch (2021)
  "tt13668894", // The Book of Boba Fett (2021)
  "tt13622982", // Visions (2021)
  "tt8466564", // Obi-Wan Kenobi (2022)
  "tt9253284", // Andor (2022)
  "tt20723374", // Tales of the Jedi (2022)
  "tt13622776", // Ahsoka (2023)
  "tt20674124", // Young Jedi Adventures (2023)
  "tt12262202", // The Acolyte (2024)
  "tt20600980", // Skeleton Crew (2024)
  "tt30825738", // The Mandalorian and Grogu (2026)
]);

/**
 * The class the stylesheet keys the wipe off, set on `<html>`.
 *
 * > [!CAUTION] A CLASS, not a view-transition TYPE, and the difference is the whole
 * > difference between this working and not working
 * > `types` is the obvious mechanism and it silently does nothing on a browser that has
 * > view transitions but not view-transition *types*. `router-core` reads the value it
 * > gets from `types` ONLY inside a `CSS.supports("selector(:active-view-transition-type(a))")`
 * > branch; where that is false it calls `document.startViewTransition(fn)` with no types
 * > at all. Two things follow, and both were live bugs:
 * >
 * > 1. `:active-view-transition-type(wipe)` never matches, so the wipe does not run.
 * > 2. Returning `false` to mean "do not animate" is never consulted either, so EVERY
 * >    ordinary navigation gets the browser's default cross-fade -- the exact opposite of
 * >    the zero-transition rule this app is built on.
 * >
 * > Keying off a class we set ourselves needs only `startViewTransition` to exist, which is
 * > the thing actually being feature-detected. The stylesheet also neutralises the root
 * > animation whenever the class is ABSENT, so a transition started on a types-less browser
 * > is instant rather than a stray fade.
 */
export const WIPE_CLASS = "fdr-wipe";

/**
 * The variants, one class each. A random one is chosen per firing.
 *
 * Star Wars does not have "a" wipe -- the films use a whole vocabulary of optical
 * transitions, and the horizontal one is just the famous member of the family. Picking at
 * random is what stops the joke becoming a thing you have seen; the second and third time
 * it fires it is still slightly a surprise.
 *
 * They are CLASSES rather than a parameter, so the whole vocabulary lives in the
 * stylesheet: adding one is a name here and a block there, with no TypeScript change and
 * nothing to keep in sync. The base `fdr-wipe` class carries everything shared -- timing,
 * paint order, `mask-repeat` -- so a variant only ever declares its own geometry.
 */
export const WIPE_VARIANTS = [
  "fdr-wipe-l", // left to right, the classic
  "fdr-wipe-r", // right to left
  "fdr-wipe-d", // top to bottom
  "fdr-wipe-iris", // a closing circle
] as const;

/**
 * One variant, at random.
 *
 * `rand` is injectable so the tests can pin the mapping without being flaky, which is the
 * only reason this is a function rather than an inline `Math.random()`.
 */
export function pickWipeVariant(rand: () => number = Math.random): string {
  const i = Math.min(WIPE_VARIANTS.length - 1, Math.floor(rand() * WIPE_VARIANTS.length));
  return WIPE_VARIANTS[i] as string;
}

/** How often the joke may fire, at most. Long enough to stay a surprise. */
export const WIPE_COOLDOWN_MS = 3 * 60 * 1000;

const LAST_KEY = "finderr.wipe.last";
const SEEN_KEY = "finderr.wipe.seen-normal";

/**
 * localStorage, if this browser will allow it.
 *
 * Safari in private mode throws on ACCESS, not just on write, and a joke may not be the
 * thing that takes the page down. Every failure here means "no wipe", which is the correct
 * degradation: the app is entirely usable without it.
 */
function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readNumber(key: string): number {
  const raw = store()?.getItem(key);
  const n = raw === null || raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Record that an ordinary navigation happened.
 *
 * The second condition on the joke, and the one that is easy to leave out: the gag only
 * lands against a baseline the reader has already felt. Fire it on somebody's very first
 * click and it does not read as a joke at all -- it reads as "this app has a weird
 * transition", which is the opposite of the intended effect.
 */
export function noteOrdinaryNavigation(): void {
  try {
    store()?.setItem(SEEN_KEY, "1");
  } catch {
    // A full or refused quota costs nothing here.
  }
}

export interface WipeOptions {
  /** Injected in tests. Defaults to the wall clock. */
  now?: number;
  /** Injected in tests, and the reason this module needs no DOM to be tested. */
  reducedMotion?: boolean;
}

/**
 * Does this reader want motion at all?
 *
 * It lives here rather than in a shared helper because this is the only motion left in the
 * product -- there is nothing else to share it with. Read at the moment of navigating rather
 * than cached: the OS setting can change while a tab is open, and a cached answer would need
 * an invalidation nobody would write.
 *
 * Anything that cannot answer -- no `matchMedia`, as in the test environment -- is treated
 * as "reduced". When we do not know, the accessible default is the safe one.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Should THIS navigation get the wipe?
 *
 * Pure apart from the two reads of localStorage, and it does NOT record anything -- see
 * `markWipeShown`. Asking must not be the same as doing: the router resolves `types` for
 * every navigation including ones the browser then declines to animate, so a check that
 * stamped the cooldown would burn the joke on a transition nobody saw.
 */
export function shouldWipe(tconst: string | null, opts: WipeOptions = {}): boolean {
  if (!tconst || !STAR_WARS.has(tconst)) return false;
  // No exception for a joke. Somebody who has asked for less motion has asked for less
  // motion, and this is the single most motion there is in the product.
  if (opts.reducedMotion) return false;

  if (!store()?.getItem(SEEN_KEY)) return false;
  const now = opts.now ?? Date.now();
  return now - readNumber(LAST_KEY) >= WIPE_COOLDOWN_MS;
}

/** Start the cooldown. Called only when the wipe is actually handed to the browser. */
export function markWipeShown(opts: WipeOptions = {}): void {
  try {
    store()?.setItem(LAST_KEY, String(opts.now ?? Date.now()));
  } catch {
    // See `noteOrdinaryNavigation`.
  }
}

/** The `tconst` a path leads to, or null. The only path shape that can carry the joke. */
export function tconstOfPath(pathname: string): string | null {
  return /^\/title\/(tt\d+)\/?$/.exec(pathname)?.[1] ?? null;
}
