import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  markWipeShown,
  noteOrdinaryNavigation,
  pickWipeVariant,
  shouldWipe,
  tconstOfPath,
  WIPE_COOLDOWN_MS,
  WIPE_VARIANTS,
} from "./easter-eggs";

/**
 * The joke's whole risk is that it stops being funny, and every guard against that is a
 * condition somebody could remove without the app breaking in any visible way. So the
 * throttle and the false-positive floor are pinned here rather than left to taste.
 */

/** A minimal localStorage. The module reads `window.localStorage` and tolerates neither. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/**
 * A fresh, EMPTY store before every test, without taking the DOM away from the rest of the run.
 *
 * > [!CAUTION] REPLACING `globalThis.window` HERE BREAKS EVERY LATER FILE IN THE SUITE
 * > `web/src/test/dom.ts` is a preload, so happy-dom's `window` is registered once for the
 * > whole run and Bun shares globals across files. This block used to assign
 * > `globalThis.window = { localStorage }`, which threw that away permanently -- every test
 * > file loaded AFTER this one lost `window.document`, and Testing Library's `waitFor` then
 * > dies with "Expected container to be an Element but got undefined". It was invisible for
 * > as long as nothing later needed a DOM, and the first file that did (the `/admin` overview
 * > route) failed in the suite while passing alone.
 * >
 * > So: swap only `localStorage`, and put back exactly what was there. The comment this
 * > replaced said Bun's test environment has no window -- true when it was written, and the
 * > preload is what stopped it being true.
 */
let realStorage: Storage | undefined;
beforeEach(() => {
  realStorage = globalThis.window?.localStorage;
  Object.defineProperty(globalThis.window, "localStorage", {
    value: fakeStorage(),
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(globalThis.window, "localStorage", {
    value: realStorage,
    configurable: true,
  });
});

const ANDOR = "tt9253284";
const NOT_STAR_WARS = "tt0111161"; // The Shawshank Redemption

describe("tconstOfPath", () => {
  test("reads the id out of a title path", () => {
    expect(tconstOfPath("/title/tt0076759")).toBe("tt0076759");
    expect(tconstOfPath("/title/tt0076759/")).toBe("tt0076759");
  });

  test("everything else is null", () => {
    // The joke can only ever fire on a title page, so every other route is not a
    // near-miss to be handled -- it is simply not a candidate.
    expect(tconstOfPath("/")).toBeNull();
    expect(tconstOfPath("/browse")).toBeNull();
    expect(tconstOfPath("/person/nm0000138")).toBeNull();
    expect(tconstOfPath("/title/")).toBeNull();
  });
});

describe("shouldWipe", () => {
  test("never on the first navigation of a session", () => {
    // The gag only lands against a baseline the reader has already felt. Fired on
    // somebody's first click it reads as "this app has a weird transition".
    expect(shouldWipe(ANDOR, { now: 1_000_000 })).toBe(false);
  });

  test("fires for a Star Wars title once the baseline is set", () => {
    noteOrdinaryNavigation();
    expect(shouldWipe(ANDOR, { now: 1_000_000 })).toBe(true);
  });

  test("never for a title that is not on the list", () => {
    noteOrdinaryNavigation();
    expect(shouldWipe(NOT_STAR_WARS, { now: 1_000_000 })).toBe(false);
    expect(shouldWipe(null, { now: 1_000_000 })).toBe(false);
  });

  test("never under reduced motion, joke or not", () => {
    // No exception for a joke: this is the single largest motion in the product, and
    // somebody who asked for less of it has asked for less of it.
    noteOrdinaryNavigation();
    expect(shouldWipe(ANDOR, { now: 1_000_000, reducedMotion: true })).toBe(false);
  });

  test("the cooldown holds, and releases exactly when it should", () => {
    noteOrdinaryNavigation();
    markWipeShown({ now: 1_000_000 });

    expect(shouldWipe(ANDOR, { now: 1_000_000 + 1 })).toBe(false);
    expect(shouldWipe(ANDOR, { now: 1_000_000 + WIPE_COOLDOWN_MS - 1 })).toBe(false);
    expect(shouldWipe(ANDOR, { now: 1_000_000 + WIPE_COOLDOWN_MS })).toBe(true);
  });

  test("asking does not start the cooldown", () => {
    // The router resolves `types` for navigations the browser may then decline to
    // animate. If the question stamped the clock, the joke would be spent on a
    // transition nobody saw -- so `markWipeShown` is a separate call on purpose.
    noteOrdinaryNavigation();
    // Any clock past the cooldown; a never-shown joke reads its last-shown time as 0, so
    // `now` has to clear the window measured from the epoch. A real `Date.now()` always
    // does by a wide margin -- this is only a constraint on the fake one.
    expect(shouldWipe(ANDOR, { now: 1_000_000 })).toBe(true);
    expect(shouldWipe(ANDOR, { now: 1_000_000 })).toBe(true);
  });
});

describe("pickWipeVariant", () => {
  test("maps the whole 0..1 range onto the variants, evenly and in order", () => {
    // The midpoint of each bucket, so the assertion does not sit on a boundary.
    const n = WIPE_VARIANTS.length;
    for (let i = 0; i < n; i++) {
      expect(pickWipeVariant(() => (i + 0.5) / n)).toBe(WIPE_VARIANTS[i] as string);
    }
  });

  test("1 does not fall off the end", () => {
    // `Math.random()` is documented as [0,1), so this should be unreachable -- but the
    // clamp costs nothing and an out-of-range index would return undefined and add the
    // string "undefined" as a class, which fails silently by simply not animating.
    expect(pickWipeVariant(() => 1)).toBe(WIPE_VARIANTS[WIPE_VARIANTS.length - 1] as string);
    expect(pickWipeVariant(() => 0)).toBe(WIPE_VARIANTS[0] as string);
  });
});

describe("the title list", () => {
  test("covers the entries with no 'Star Wars' in their name", () => {
    // The reason the list is hardcoded rather than matched. Every one of these is a
    // Star Wars title whose name does not contain the string, so any title-matching
    // implementation silently misses them while still appearing to work.
    noteOrdinaryNavigation();
    for (const id of [
      "tt9253284", // Andor
      "tt13622776", // Ahsoka
      "tt8111088", // The Mandalorian
      "tt3748528", // Rogue One
      "tt3778644", // Solo
      "tt20600980", // Skeleton Crew
      "tt12262202", // The Acolyte
      "tt8466564", // Obi-Wan Kenobi
    ]) {
      expect(shouldWipe(id, { now: Number.MAX_SAFE_INTEGER })).toBe(true);
    }
  });

  test("does not fire on the documentaries and parodies that match by name", () => {
    // The other direction, and the one that would be actively embarrassing. All of
    // these are real rows in our own index for the query `star wars`.
    noteOrdinaryNavigation();
    for (const id of [
      "tt36455738", // Angry Birds Star Wars Rebels
      "tt10679178", // Nissan Rogue: Star Wars Rogue One Battle Tested
      "tt16409886", // Rifftrax: Solo: A Star Wars Story
      "tt11505706", // Blind Wave: The Mandalorian Reaction
      "tt24468100", // Cheap Star Wars Clone
    ]) {
      expect(shouldWipe(id, { now: Number.MAX_SAFE_INTEGER })).toBe(false);
    }
  });
});
