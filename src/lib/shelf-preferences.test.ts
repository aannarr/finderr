/**
 * A reader's own front page: what is stored, and what it resolves to.
 *
 * Four properties carry this feature and the rest is SQL doing its job:
 *
 *  1. A reader who has never touched it gets TODAY'S PAGE BACK UNCHANGED -- the same shelves
 *     in the same order, not an equivalent list. Everything else here is a change to what
 *     somebody asked to change; this is the promise made to everybody who did not.
 *  2. A shelf a release ADDS appears for a reader who has customised, in the position the
 *     release put it. The stored list is an ordering hint and never an allow-list.
 *  3. A stored id that no longer names a shelf is ignored rather than thrown. Genre shelves
 *     rotate nightly, so this is the ordinary state.
 *  4. The resolved page is always a SUBSET of the shipped page, which is what lets the warm
 *     loop keep warming the shipped page and still cover every reader. The day this file
 *     starts selecting shelves rather than ordering them, that test is what notices.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { AuthStore, applyAuthSchema } from "./auth-store";
import { DEFAULT_CONFIG } from "./config";
import {
  applyShelfPreference,
  applyShelfPreferenceSchema,
  defaultHiddenShelves,
  MAX_SHELF_CHOICES,
  parseShelfChoices,
  type ShelfPreference,
  ShelfPreferenceStore,
  shelfCatalogue,
} from "./shelf-preferences";

/**
 * The two schemas in the order `Store`'s constructor applies them, with the pragma it sets.
 *
 * `foreign_keys` is not optional and neither is the ORDER -- the cascade is a comment without
 * the pragma, and the foreign key resolves to a missing table if the schemas are swapped.
 * Both mistakes pass a test that opens the databases separately.
 */
function open(): { auth: AuthStore; prefs: ShelfPreferenceStore } {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  applyShelfPreferenceSchema(db);
  return { auth: new AuthStore(db), prefs: new ShelfPreferenceStore(db) };
}

let auth: AuthStore;
let prefs: ShelfPreferenceStore;
let ada: string;
let grace: string;

beforeEach(() => {
  ({ auth, prefs } = open());
  ada = auth.createUser({ displayName: "Ada", role: "user" }).id;
  grace = auth.createUser({ displayName: "Grace", role: "user" }).id;
});

/** The shipped page, as far as the resolver is concerned: ids in the server's order. */
const SHIPPED = [
  { id: "recently-added", title: "Recently added to your library" },
  { id: "trending", title: "Popular right now" },
  { id: "top-250", title: "finderr Top 250" },
  { id: "genre-horror", title: "Best in Horror" },
];

/** A preference in reading order, everything visible unless named in `hide`. */
function pref(order: string[], hide: string[] = []): ShelfPreference {
  return order.map((id) => ({ id, hidden: hide.includes(id) }));
}

const ids = (shelves: readonly { id: string }[]) => shelves.map((s) => s.id);

describe("storing a preference", () => {
  test("it comes back in the order it was saved, hidden flags intact", () => {
    prefs.replace(ada, pref(["trending", "recently-added"], ["recently-added"]));
    expect(prefs.read(ada)).toEqual([
      { id: "trending", hidden: false },
      { id: "recently-added", hidden: true },
    ]);
  });

  test("saving again replaces the whole list rather than merging into it", () => {
    prefs.replace(ada, pref(["trending", "recently-added", "top-250"]));
    prefs.replace(ada, pref(["top-250", "trending"]));
    // `recently-added` is GONE, not sitting at position 1 where nothing on screen could
    // reach it. That is the difference between replace and upsert.
    expect(ids(prefs.read(ada))).toEqual(["top-250", "trending"]);
  });

  test("a reader who has never touched it has no preference", () => {
    expect(prefs.read(ada)).toEqual([]);
  });

  test("one reader's arrangement is invisible to another", () => {
    prefs.replace(ada, pref(["trending"]));
    expect(prefs.read(grace)).toEqual([]);
  });

  test("reset reports whether there was anything to undo, and leaves nothing behind", () => {
    prefs.replace(ada, pref(["trending"]));
    expect(prefs.clear(ada)).toBe(true);
    expect(prefs.read(ada)).toEqual([]);
    expect(prefs.clear(ada)).toBe(false);
  });

  test("an empty list clears the preference rather than storing an empty page", () => {
    prefs.replace(ada, pref(["trending"]));
    prefs.replace(ada, []);
    expect(prefs.read(ada)).toEqual([]);
  });

  test("only an account that exists can have a preference", () => {
    expect(() => prefs.replace("nobody", pref(["trending"]))).toThrow();
  });
});

describe("the account it belongs to", () => {
  test("a deleted user takes their arrangement with them", () => {
    prefs.replace(ada, pref(["trending"]));
    prefs.replace(grace, pref(["top-250"]));
    auth.deleteUser(ada);
    expect(prefs.read(ada)).toEqual([]);
    expect(prefs.stats()).toEqual({ readers: 1 });
  });

  test("stats counts readers and names none of them", () => {
    expect(prefs.stats()).toEqual({ readers: 0 });
    prefs.replace(ada, pref(["trending"]));
    prefs.replace(grace, pref(["top-250"]));
    expect(prefs.stats()).toEqual({ readers: 2 });
  });
});

describe("a reader who never touched it", () => {
  /*
    THE REGRESSION TEST FOR EVERYBODY ELSE. Personalisation is worth nothing if it costs the
    people who ignored it their front page, so this asserts identity rather than equivalence:
    the same shelves, in the same order, unchanged.
  */
  test("gets today's page back, shelf for shelf", () => {
    expect(applyShelfPreference(SHIPPED, [])).toEqual(SHIPPED);
  });

  test("and their catalogue is the shipped order with nothing hidden", () => {
    expect(shelfCatalogue(SHIPPED, [])).toEqual(SHIPPED.map((s) => ({ ...s, hidden: false })));
  });
});

describe("order and visibility", () => {
  test("the page is drawn in the reader's order", () => {
    const page = applyShelfPreference(
      SHIPPED,
      pref(["genre-horror", "top-250", "trending", "recently-added"]),
    );
    expect(ids(page)).toEqual(["genre-horror", "top-250", "trending", "recently-added"]);
  });

  test("a hidden shelf is off the page and still on the catalogue", () => {
    const preference = pref(["recently-added", "trending", "top-250", "genre-horror"], ["trending"]);
    expect(ids(applyShelfPreference(SHIPPED, preference))).not.toContain("trending");
    // On the settings screen it is still there, marked -- otherwise hiding is a one-way door.
    expect(shelfCatalogue(SHIPPED, preference)).toContainEqual({
      id: "trending",
      title: "Popular right now",
      hidden: true,
    });
  });
});

describe("a release that changes the shelves", () => {
  test("a NEW shelf appears for a reader who has customised", () => {
    // Ada arranged the page before `genre-horror` existed.
    const preference = pref(["top-250", "trending", "recently-added"]);
    expect(ids(applyShelfPreference(SHIPPED, preference))).toContain("genre-horror");
  });

  test("a new shelf lands where the release put it, not at the bottom", () => {
    // `genre-horror` follows `top-250` in the shipped order, so it follows it here -- a new
    // genre row belongs among the genre rows rather than demoted below everything.
    const page = applyShelfPreference(SHIPPED, pref(["top-250", "trending", "recently-added"]));
    expect(ids(page)).toEqual(["top-250", "genre-horror", "trending", "recently-added"]);
  });

  test("a new shelf shipped at the head of the page stays at the head", () => {
    const page = applyShelfPreference(SHIPPED, pref(["trending", "top-250", "genre-horror"]));
    expect(ids(page)).toEqual(["recently-added", "trending", "top-250", "genre-horror"]);
  });

  test("a stored id the release retired is ignored rather than thrown", () => {
    const page = applyShelfPreference(
      SHIPPED,
      pref(["genre-westerns", "trending", "recently-added", "top-250", "genre-horror"]),
    );
    expect(ids(page)).toEqual(["trending", "recently-added", "top-250", "genre-horror"]);
  });

  test("a preference whose every shelf is gone degrades to the shipped page", () => {
    expect(applyShelfPreference(SHIPPED, pref(["genre-westerns", "genre-noir"]))).toEqual(SHIPPED);
  });

  test("hiding a shelf that no longer exists changes nothing", () => {
    expect(applyShelfPreference(SHIPPED, pref(["genre-westerns"], ["genre-westerns"]))).toEqual(SHIPPED);
  });
});

describe("what the warm loop is allowed to assume", () => {
  /*
    THE PROPERTY THE WARM LOOP RESTS ON.

    `warmShelves` warms the SHIPPED page and `/api/health` reports coverage against it. That is
    only honest while no reader can see a shelf the shipped page does not carry -- a preference
    that could ADD one would hand somebody a cold shelf with nothing on `/api/health` to say
    so. Ordering and hiding cannot, and this is where that stops being an argument.
  */
  test("every arrangement resolves to a subset of the shipped page", () => {
    const arrangements: ShelfPreference[] = [
      [],
      pref(["genre-horror", "recently-added"]),
      pref(["trending"], ["trending"]),
      pref(["genre-westerns", "top-250"], ["top-250"]),
      pref(["recently-added", "trending", "top-250", "genre-horror"], ["recently-added", "top-250"]),
    ];
    const shipped = new Set(ids(SHIPPED));
    for (const arrangement of arrangements) {
      const page = applyShelfPreference(SHIPPED, arrangement);
      expect(page.every((shelf) => shipped.has(shelf.id))).toBe(true);
      // And never twice, however the reader arranged it -- a duplicated shelf would be warmed
      // once and drawn twice, which is the other way this could go wrong.
      expect(new Set(ids(page)).size).toBe(page.length);
    }
  });
});

describe("reading an arrangement off a request body", () => {
  test("the ordinary body, with hidden defaulting to visible", () => {
    expect(parseShelfChoices({ shelves: [{ id: "trending" }, { id: "top-250", hidden: true }] })).toEqual({
      choices: [
        { id: "trending", hidden: false },
        { id: "top-250", hidden: true },
      ],
    });
  });

  test("an empty list is a valid arrangement -- it is how a reset arrives from an old client", () => {
    expect(parseShelfChoices({ shelves: [] })).toEqual({ choices: [] });
  });

  /*
    AN ID NOTHING CURRENTLY SHIPS IS ACCEPTED, and that is the decision rather than an
    oversight: the genre rows rotate with the nightly index build, so an id that was real when
    the browser drew the page can be gone by the time the reader presses save. It is ignored on
    the way out instead -- see the retired-shelf tests above.
  */
  test("an id no shelf currently carries is accepted rather than refused", () => {
    expect(parseShelfChoices({ shelves: [{ id: "genre-westerns" }] })).toEqual({
      choices: [{ id: "genre-westerns", hidden: false }],
    });
  });

  test.each([
    ["not an object", "list", "body must be an object"],
    ["no shelves key", {}, "shelves must be an array"],
    ["shelves is not an array", { shelves: "trending" }, "shelves must be an array"],
    ["an entry is not an object", { shelves: ["trending"] }, "each shelf must be an object"],
    ["an entry has no id", { shelves: [{ hidden: true }] }, "each shelf needs a non-empty id"],
    ["an entry has an empty id", { shelves: [{ id: "" }] }, "each shelf needs a non-empty id"],
    ["hidden is not a boolean", { shelves: [{ id: "trending", hidden: 1 }] }, "hidden must be a boolean"],
    [
      "the same shelf twice",
      { shelves: [{ id: "trending" }, { id: "trending", hidden: true }] },
      "trending is listed twice",
    ],
  ])("refuses %s", (_name, body, error) => {
    expect(parseShelfChoices(body)).toEqual({ error });
  });

  test("refuses a list longer than the page could ever be", () => {
    const shelves = Array.from({ length: MAX_SHELF_CHOICES + 1 }, (_, i) => ({ id: `shelf-${i}` }));
    expect(parseShelfChoices({ shelves })).toEqual({
      error: `shelves must name at most ${MAX_SHELF_CHOICES} shelves`,
    });
  });

  test("refuses an id longer than any shelf we ship", () => {
    expect(parseShelfChoices({ shelves: [{ id: "x".repeat(101) }] })).toEqual({
      error: "a shelf id that long is not one of ours",
    });
  });
});

describe("stored and resolved are the same page", () => {
  test("a round trip through SQLite draws what was arranged", () => {
    prefs.replace(ada, pref(["genre-horror", "top-250", "trending", "recently-added"], ["trending"]));
    expect(ids(applyShelfPreference(SHIPPED, prefs.read(ada)))).toEqual([
      "genre-horror",
      "top-250",
      "recently-added",
    ]);
  });
});

/*
  THE OPERATOR'S DEFAULT, which decides ONLY the shelves a reader has never had an opinion
  about. Every test here is about that boundary, because the boundary is the whole feature: a
  default that outranked a stored choice would be a setting the reader could not keep, and one
  that a stored choice could not reach would be a shelf they could never get back.
*/
describe("shelves the operator ships switched off", () => {
  const off = (...patterns: string[]) => defaultHiddenShelves(patterns);

  test("a reader who has touched nothing does not see a default-hidden shelf", () => {
    const page = applyShelfPreference(SHIPPED, [], off("trending"));
    expect(ids(page)).toEqual(["recently-added", "top-250", "genre-horror"]);
  });

  test("no default at all leaves today's page untouched, argument for argument", () => {
    expect(applyShelfPreference(SHIPPED, [], off())).toEqual(SHIPPED);
    expect(applyShelfPreference(SHIPPED, [])).toEqual(SHIPPED);
  });

  /*
    THE ONE THAT MAKES THE SETTINGS SCREEN'S "Show" BUTTON MEAN SOMETHING. Without it, pressing
    Show on a default-hidden shelf would store `hidden: false`, answer with the shelf still
    marked hidden, and the reader would press it forever.
  */
  test("a reader who turns it back on keeps it on", () => {
    const page = applyShelfPreference(SHIPPED, pref(["trending"]), off("trending"));
    expect(ids(page)).toContain("trending");
  });

  test("and a reader who hides something the operator ships ON still has it hidden", () => {
    const page = applyShelfPreference(SHIPPED, pref(["top-250"], ["top-250"]), off("trending"));
    expect(ids(page)).toEqual(["recently-added", "genre-horror"]);
  });

  /* A configured id naming no shelf is the retired-genre case again, and it is not an error. */
  test("a default naming a shelf that does not exist changes nothing", () => {
    expect(applyShelfPreference(SHIPPED, [], off("genre-westerns"))).toEqual(SHIPPED);
  });

  /*
    THE CATALOGUE MUST AGREE WITH THE PAGE. It draws the shelf marked hidden rather than
    dropping it -- a screen that omitted it would be the one-way door `shelfCatalogue`'s own
    doc comment exists to prevent, except now the door is one the reader never walked through.
  */
  test("the arranging screen shows it, marked hidden, so there is something to press", () => {
    const view = shelfCatalogue(SHIPPED, [], off("trending"));
    expect(view.map((s) => [s.id, s.hidden])).toEqual([
      ["recently-added", false],
      ["trending", true],
      ["top-250", false],
      ["genre-horror", false],
    ]);
  });

  test("and it stops marking it once the reader has said otherwise", () => {
    const view = shelfCatalogue(SHIPPED, pref(["trending"]), off("trending"));
    expect(view.find((s) => s.id === "trending")?.hidden).toBe(false);
  });

  /*
    THE WARM LOOP PROPERTY AGAIN, because this is the change most likely to break it. A default
    may only ever REMOVE from the page it is handed; the day it can add one, `warmShelves` is
    covering a shelf somebody sees and nothing on `/api/health` says otherwise.
  */
  test("a default can only ever shrink the page, never add to it", () => {
    const shipped = new Set(ids(SHIPPED));
    for (const defaults of [off(), off("trending"), off("recently-added", "genre-horror"), off("nope")]) {
      for (const arrangement of [[], pref(["top-250", "trending"]), pref(["trending"], ["trending"])]) {
        const page = applyShelfPreference(SHIPPED, arrangement, defaults);
        expect(page.every((shelf) => shipped.has(shelf.id))).toBe(true);
        expect(new Set(ids(page)).size).toBe(page.length);
      }
    }
  });

  /*
    A STORED ARRANGEMENT KEEPS ITS ORDER, and the default reaches only the shelf it left out.

    Worth knowing what this implies in practice: the arranging screen sends the WHOLE
    catalogue, so the moment a reader saves anything, every shelf on the page that day has an
    explicit opinion and the operator's default stops reaching any of them. That is correct
    rather than a leak -- the catalogue they arranged from already had the default-hidden rows
    marked hidden, so saving it stores the operator's choice as their own, and from then on the
    page is theirs. `trending` here stands in for a shelf shipped AFTER they last arranged.
  */
  test("a stored arrangement keeps its order, and the default reaches only what it left out", () => {
    const page = applyShelfPreference(
      SHIPPED,
      pref(["genre-horror", "top-250", "recently-added"]),
      off("trending"),
    );
    expect(ids(page)).toEqual(["genre-horror", "top-250", "recently-added"]);
  });
});

/*
  THE TRAILING `*`, and the one id space that needs it.

  The genre rows are named from `engine.topGenres(5)`, so which five exist is decided by the
  nightly index build. An operator who switched off today's five by name would get a SIXTH
  one switched ON the first night the corpus shifted -- one visible row among five hidden
  ones, which reads as the feature being broken rather than the config being stale.
*/
describe("a default that has to survive the genre rows rotating", () => {
  const ROTATED = [
    { id: "recently-added", title: "Recently added to your library" },
    { id: "genre-horror", title: "Best in Horror" },
    { id: "genre-thriller", title: "Best in Thriller" },
    { id: "top-250", title: "finderr Top 250" },
  ];

  test("`genre-*` hides a genre row nobody had heard of when it was configured", () => {
    const page = applyShelfPreference(ROTATED, [], defaultHiddenShelves(["genre-*"]));
    expect(ids(page)).toEqual(["recently-added", "top-250"]);
  });

  test("naming the genres one by one is what goes stale, which is why the wildcard exists", () => {
    const byName = applyShelfPreference(ROTATED, [], defaultHiddenShelves(["genre-horror"]));
    expect(ids(byName)).toContain("genre-thriller");
  });

  test("an exact id and a prefix compose in one list", () => {
    const page = applyShelfPreference(ROTATED, [], defaultHiddenShelves(["top-250", "genre-*"]));
    expect(ids(page)).toEqual(["recently-added"]);
  });

  test("a reader still outranks the wildcard, one genre at a time", () => {
    const page = applyShelfPreference(ROTATED, pref(["genre-thriller"]), defaultHiddenShelves(["genre-*"]));
    // Still in the SHIPPED order: naming a shelf in a preference makes it visible, it does
    // not promote it. `genre-horror` is the one the wildcard still reaches.
    expect(ids(page)).toEqual(["recently-added", "genre-thriller", "top-250"]);
  });

  /*
    A BARE `*` IS REFUSED. It is indistinguishable from a typo, and honouring it would empty
    the whole front page for every reader at once -- the one input here with a blast radius
    bigger than the mistake that produced it.
  */
  test.each([
    ["a bare star", ["*"]],
    ["an empty entry", [""]],
    ["whitespace", ["   "]],
  ])("%s hides nothing", (_name, patterns) => {
    expect(applyShelfPreference(ROTATED, [], defaultHiddenShelves(patterns))).toEqual(ROTATED);
  });

  test("entries are trimmed, because a comma list is written by a human", () => {
    const page = applyShelfPreference(ROTATED, [], defaultHiddenShelves([" top-250 ", " genre-* "]));
    expect(ids(page)).toEqual(["recently-added"]);
  });
});

/*
  THE SHIPPED DEFAULT ITSELF. aannarr named these from a screenshot on 2026-09-07, and the
  point of pinning it is that it is a PRODUCT decision rather than an incidental value: a
  change to what a fresh install shows should have to edit a test that says so out loud.
*/
describe("the front page finderr ships", () => {
  test("nine of the sixteen rows are drawn, and the other seven are one press away", () => {
    const shipped = [
      { id: "recently-added", title: "Recently added to your library" },
      { id: "recently-requested", title: "Recently requested" },
      { id: "trending", title: "Popular right now" },
      { id: "top-250", title: "finderr Top 250" },
      { id: "top-movies", title: "Highly rated, not in your library" },
      { id: "top-series", title: "Series worth starting" },
      { id: "airing-soon-series", title: "Airing soon" },
      { id: "airing-soon-movies", title: "Releasing soon" },
      { id: "coming-soon-movies", title: "Coming soon: Movies" },
      { id: "coming-soon-series", title: "Coming soon: Series" },
      { id: "new-decade", title: "New this decade" },
      { id: "genre-drama", title: "Best in Drama" },
      { id: "genre-comedy", title: "Best in Comedy" },
      { id: "genre-crime", title: "Best in Crime" },
      { id: "genre-action", title: "Best in Action" },
      { id: "genre-adventure", title: "Best in Adventure" },
    ];
    const byDefault = defaultHiddenShelves(DEFAULT_CONFIG.shelves.hiddenByDefault);

    expect(ids(applyShelfPreference(shipped, [], byDefault))).toEqual([
      "recently-added",
      "trending",
      "top-movies",
      "top-series",
      "airing-soon-series",
      "airing-soon-movies",
      "coming-soon-movies",
      "coming-soon-series",
      "new-decade",
    ]);

    // And every one of the seven is still on the arranging screen, marked, so it can come back.
    const view = shelfCatalogue(shipped, [], byDefault);
    expect(view.filter((s) => s.hidden).map((s) => s.id)).toEqual([
      "recently-requested",
      "top-250",
      "genre-drama",
      "genre-comedy",
      "genre-crime",
      "genre-action",
      "genre-adventure",
    ]);
    expect(view).toHaveLength(shipped.length);
  });
});
