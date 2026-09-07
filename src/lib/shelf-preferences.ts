/**
 * Your own order for the front page, and the shelves you never scroll to.
 *
 * ## What a preference IS, and the one thing it can never be
 *
 * A preference is an ORDER AND A FILTER over the shelves finderr already assembled. It cannot
 * add a shelf, cannot change what is on one, and cannot make one cost a query -- so a reader
 * with a preference costs exactly one indexed read of the table below plus a reorder of an
 * array that is already in memory.
 *
 * That restraint is what makes the feature affordable, and it is structural rather than a
 * promise: `orderShelves` picks from the list it is handed and never invents a member, so the
 * union of what every reader sees is a SUBSET of the shipped page. The warm loop and
 * `/api/health`'s coverage both read the shipped page, and warming a superset warms everybody
 * -- `shelf-preferences.test.ts` pins exactly that, because the day this file starts
 * SELECTING shelves rather than ordering them, the warm loop silently stops covering them.
 *
 * ## The stored list is an ORDERING HINT, never an allow-list
 *
 * The decision that upgrades hang on: a shelf a release ADDS must appear for a reader who has
 * customised. Under an allow-list -- "show exactly what is stored" -- every future shelf would
 * be invisible to precisely the readers who engaged with the feature, and they would have no
 * way to discover that anything was missing. So an unmentioned shelf is SHOWN, and it appears
 * where the shipped order put it (see `orderShelves`) rather than at the bottom of the page.
 *
 * The mirror of that rule: a stored id the current release has no shelf for is IGNORED rather
 * than an error. Genre shelves rotate with the nightly index build, so a preference naming a
 * retired shelf is the ordinary state and not a corruption.
 *
 * ## The one thing an unmentioned shelf's visibility is NOT decided by this file alone
 *
 * `config.shelves.hiddenByDefault` lets the OPERATOR start a shelf switched off. It changes
 * only the unmentioned case above -- a reader who has said anything about a shelf has said it,
 * and `hiddenIds` never consults the default for a shelf the preference names. So the rule is
 * still "an unmentioned shelf is shown WHERE THE SHIPPED ORDER PUT IT", with the operator
 * allowed to move the starting point for shelves nobody has an opinion about yet.
 *
 * IT IS ITS OWN MODULE for the reason `src/lib/watchlist.ts` gives: `auth-store.ts` is
 * identity, `store.ts` mirrors somebody else's machine, and this is content one reader owns.
 * Every method is synchronous because `bun:sqlite` is and the render path awaits nothing.
 */

import type { Database } from "bun:sqlite";

/**
 * > [!IMPORTANT] `applyAuthSchema` MUST have run first
 * > `on delete cascade` is what makes a deleted account take its preference with it, and
 * > SQLite resolves a foreign key at INSERT time rather than at CREATE time -- so declaring
 * > this against a missing `app_user` fails silently now and loudly on somebody's first save.
 * > `Store`'s constructor calls the two in order and `open()` in the tests does the same.
 *
 * ONE ROW PER SHELF THE READER HAS AN OPINION ABOUT, rather than one row per reader holding a
 * JSON list. Two columns that each mean one thing beat a blob that has to be parsed and
 * validated on every read, and the order the page is drawn in is then something SQLite sorts
 * rather than something a parser has to preserve.
 *
 * `position` is dense and zero-based because the writer replaces the whole list at once --
 * there is no insert-between operation to leave gaps for, and inventing one would be an
 * ordering scheme nobody asked for.
 *
 * NOTE: no backticks in this string -- it is a template literal, and one would end it.
 */
export const SHELF_PREFERENCE_SCHEMA = `
create table if not exists shelf_pref (
  user_id  text not null references app_user(id) on delete cascade,
  shelf_id text not null,
  position integer not null,
  hidden   integer not null default 0,
  primary key (user_id, shelf_id)
);
-- One reader's list in their own order is the ONLY way this table is ever read, so the index
-- carries it. The primary key already covers "does this reader have an opinion about X".
create index if not exists ix_shelf_pref_user_position on shelf_pref(user_id, position);
`;

export function applyShelfPreferenceSchema(db: Database): void {
  db.run(SHELF_PREFERENCE_SCHEMA);
}

/** What a reader decided about one shelf: where it goes, and whether they see it. */
export interface ShelfChoice {
  id: string;
  hidden: boolean;
}

/**
 * A reader's whole preference: the shelves they have an opinion about, in their order.
 *
 * An EMPTY list and NO PREFERENCE are deliberately the same value, and that is safe rather
 * than sloppy: under the ordering-hint rule above, a preference that mentions no shelf leaves
 * every shelf unmentioned, and every unmentioned shelf is shown in its shipped position. The
 * two states resolve to the same page, so storing them apart would be a distinction nothing
 * could ever observe.
 */
export type ShelfPreference = readonly ShelfChoice[];

/** What `/api/health` may say about the feature: a count, never whose page looks how. */
export interface ShelfPreferenceStats {
  /** Accounts that have customised their front page. */
  readers: number;
}

interface StoredChoice {
  shelf_id: string;
  hidden: number;
}

export class ShelfPreferenceStore {
  constructor(private readonly db: Database) {}

  /** One reader's preference, in their order. Empty when they have never touched it. */
  read(userId: string): ShelfChoice[] {
    const rows = this.db
      .query("select shelf_id, hidden from shelf_pref where user_id = ? order by position asc")
      .all(userId) as StoredChoice[];
    return rows.map((r) => ({ id: r.shelf_id, hidden: r.hidden === 1 }));
  }

  /**
   * Replace a reader's whole preference, or clear it if the list is empty.
   *
   * REPLACE RATHER THAN MERGE, in one transaction, which is the same move
   * `Store.replaceLibrary` makes for the same reason: the client sends the page it wants and
   * a per-shelf upsert would leave a row for a shelf that has since left the page sitting in
   * the middle of the new order, where nothing on screen could reach it to remove it.
   */
  replace(userId: string, choices: ShelfPreference): void {
    this.db.transaction(() => {
      this.db.run("delete from shelf_pref where user_id = ?", [userId]);
      const insert = this.db.query(
        "insert into shelf_pref (user_id, shelf_id, position, hidden) values (?,?,?,?)",
      );
      choices.forEach((choice, position) => {
        insert.run(userId, choice.id, position, choice.hidden ? 1 : 0);
      });
    })();
  }

  /** Put the front page back to the shipped default. Reports whether there was anything to undo. */
  clear(userId: string): boolean {
    const { changes } = this.db.run("delete from shelf_pref where user_id = ?", [userId]);
    return Number(changes) > 0;
  }

  /** Counts only -- see `ShelfPreferenceStats` for why it can never be anything else. */
  stats(): ShelfPreferenceStats {
    const row = this.db.query("select count(distinct user_id) as readers from shelf_pref").get() as {
      readers: number;
    };
    return { readers: row.readers };
  }
}

/**
 * The shipped page put into one reader's order, hidden shelves included and still in place.
 *
 * ONE MERGE, TWO VIEWS: the page a reader is served drops the hidden ones, and the settings
 * screen draws them all so there is something to un-hide. Both come from here, so the order a
 * reader arranges and the order they are shown cannot disagree.
 *
 * ## Where a NEW shelf lands
 *
 * Each shelf the preference has never heard of is queued behind the last SHIPPED shelf the
 * preference does know, and shelves the preference has never heard of at all come first. So a
 * genre row added by tonight's index build appears among the other genre rows rather than at
 * the bottom of the page, and a reader who customised gets the release they upgraded to.
 * Appending newcomers to the end would have been fewer lines and would have quietly demoted
 * every future shelf for exactly the readers who use this feature.
 *
 * Ids in the preference that no longer name a shelf are skipped. Nothing throws: a retired
 * genre shelf is a nightly occurrence, not an error anybody can act on.
 */
export function orderShelves<T extends { id: string }>(shelves: readonly T[], pref: ShelfPreference): T[] {
  const byId = new Map(shelves.map((shelf) => [shelf.id, shelf]));
  const opinionated = new Set(pref.map((choice) => choice.id));

  // Shelves this preference predates, each filed under the shipped shelf it follows. `null`
  // is the head of the page -- a newcomer with no known shelf in front of it.
  const newcomers = new Map<string | null, T[]>();
  let anchor: string | null = null;
  for (const shelf of shelves) {
    if (opinionated.has(shelf.id)) {
      anchor = shelf.id;
      continue;
    }
    const queue = newcomers.get(anchor);
    if (queue) queue.push(shelf);
    else newcomers.set(anchor, [shelf]);
  }

  const out: T[] = [...(newcomers.get(null) ?? [])];
  for (const choice of pref) {
    // The primary key on `shelf_pref` is what stops one id appearing twice, so this walk
    // cannot emit a shelf twice however the reader has arranged the page.
    const shelf = byId.get(choice.id);
    if (shelf) out.push(shelf);
    out.push(...(newcomers.get(choice.id) ?? []));
  }
  return out;
}

/**
 * Shelf ids the OPERATOR has switched off for anybody who has not said otherwise.
 *
 * `config.shelves.hiddenByDefault`, and it is deliberately its own type rather than a bare
 * `Set<string>` at each call site: both functions below take it, and a caller that passed one
 * and forgot the other would draw a settings screen disagreeing with the page it arranges.
 */
export type DefaultHiddenShelves = ReadonlySet<string>;

/** No operator default at all -- the shape every existing caller and test already has. */
const NOTHING_HIDDEN: DefaultHiddenShelves = new Set<string>();

/**
 * The page this reader actually sees: their order, minus what they hid.
 *
 * A reader with no preference AND no operator default gets the argument back unchanged -- not
 * an equivalent list, the same shelves in the same order -- which is what makes "somebody who
 * never touched this sees exactly today's front page" a property of the code rather than a hope.
 *
 * > [!IMPORTANT] A READER'S OPINION ALWAYS OUTRANKS THE OPERATOR'S DEFAULT, in both directions
 * > `byDefault` decides only for a shelf the preference says NOTHING about. Turn one back on
 * > and the stored `hidden: false` wins from then on, which is what makes the default a
 * > starting point rather than a rule the reader keeps losing to. It is the same precedence
 * > `orderShelves` gives a stored position over the shipped one, and it falls out of the same
 * > place: `hiddenIds` asks the preference first and the default only for what is left.
 *
 * The warm loop is UNAFFECTED and must stay that way: it warms the shelves it is handed, and
 * this still only ever REMOVES from that list, so the union of what readers see is still a
 * subset of the shipped page. A default-hidden shelf is warmed for the readers who turn it
 * back on. `shelf-preferences.test.ts` pins the subset property.
 */
export function applyShelfPreference<T extends { id: string }>(
  shelves: readonly T[],
  pref: ShelfPreference,
  byDefault: DefaultHiddenShelves = NOTHING_HIDDEN,
): T[] {
  const hidden = hiddenIds(pref, byDefault);
  return orderShelves(shelves, pref).filter((shelf) => !hidden.has(shelf.id));
}

/** One shelf as the settings screen needs it: what to call it, and whether it is hidden. */
export interface ShelfChoiceView {
  id: string;
  title: string;
  hidden: boolean;
}

/**
 * Every shelf a reader could arrange, in their order, with the hidden ones marked.
 *
 * HIDDEN SHELVES ARE IN THIS LIST, unlike the page itself, because a screen that omitted them
 * would be a one-way door: hide a shelf and there is nothing left to press to get it back.
 */
export function shelfCatalogue(
  shelves: readonly { id: string; title: string }[],
  pref: ShelfPreference,
  byDefault: DefaultHiddenShelves = NOTHING_HIDDEN,
): ShelfChoiceView[] {
  const hidden = hiddenIds(pref, byDefault);
  return orderShelves(shelves, pref).map((shelf) => ({
    id: shelf.id,
    title: shelf.title,
    hidden: hidden.has(shelf.id),
  }));
}

/**
 * What all three preference routes answer with, read it, save it or reset it.
 *
 * Named here rather than spelt out at the route, because the BROWSER draws from it:
 * `web/src/lib/api.ts` imports this type the same way it imports `QuotaState`, so the
 * screen that arranges the page and the server that resolves the arrangement cannot drift
 * about what a payload carries.
 */
export interface ShelfPreferencePayload {
  /**
   * Has this reader arranged anything, or are they looking at the shipped page?
   *
   * Its own field rather than "is the list non-empty": the list is the whole CATALOGUE and
   * is never empty, so a screen with only that could not tell an arrangement from a default
   * and would offer to reset a page nobody had touched.
   */
  customised: boolean;
  shelves: ShelfChoiceView[];
}

/**
 * Every shelf id that is off for this reader: the ones they hid, plus the operator's defaults
 * for shelves they have never had an opinion about.
 *
 * THE ORDER OF THE TWO CLAUSES IS THE PRECEDENCE RULE and it is the only place it is written.
 * A shelf named in the preference is decided by the preference and the default is never
 * consulted for it -- so `hidden: false` on a default-hidden shelf turns it back on, which is
 * what makes the settings screen's "Show" button mean something.
 */
function hiddenIds(pref: ShelfPreference, byDefault: DefaultHiddenShelves): Set<string> {
  const opinionated = new Set(pref.map((choice) => choice.id));
  const hidden = new Set(pref.filter((choice) => choice.hidden).map((choice) => choice.id));
  for (const id of byDefault) if (!opinionated.has(id)) hidden.add(id);
  return hidden;
}

/** A well-formed arrangement, or a reason to refuse it. */
export type ParsedShelfChoices = { choices: ShelfChoice[] } | { error: string };

/**
 * How many shelves one arrangement may name.
 *
 * The shipped page is fifteen or sixteen rows and a reader can only ever reorder what they
 * were shown, so this is a bound on a table rather than a limit anybody will meet. It exists
 * because the ids are not checked against the current page (see `parseShelfChoices`), and an
 * unchecked list with no ceiling is a way to write rows nothing will ever read.
 */
export const MAX_SHELF_CHOICES = 100;

/** The longest shelf id worth storing. `genre-<name>` is the longest shape that exists. */
const MAX_SHELF_ID_LENGTH = 100;

/**
 * Read `{ shelves: [{ id, hidden }] }` off a request body.
 *
 * SHAPE, NEVER MEMBERSHIP. Whether an id still names a shelf is deliberately not asked here:
 * the genre rows rotate with the nightly index build, so an id that was real when the browser
 * drew it can be gone by the time the reader presses save, and refusing would turn a routine
 * rotation into a failed save on somebody's screen. `orderShelves` ignores it instead.
 *
 * A DUPLICATE ID IS REFUSED rather than quietly collapsed. The primary key would reject the
 * second row anyway, and a client that sent the same shelf twice has a bug worth a message --
 * silently keeping one of them would answer with a page the caller did not send.
 */
export function parseShelfChoices(body: unknown): ParsedShelfChoices {
  if (body === null || typeof body !== "object") return { error: "body must be an object" };
  const shelves = (body as { shelves?: unknown }).shelves;
  if (!Array.isArray(shelves)) return { error: "shelves must be an array" };
  if (shelves.length > MAX_SHELF_CHOICES) {
    return { error: `shelves must name at most ${MAX_SHELF_CHOICES} shelves` };
  }

  const choices: ShelfChoice[] = [];
  const seen = new Set<string>();
  for (const entry of shelves) {
    if (entry === null || typeof entry !== "object") return { error: "each shelf must be an object" };
    const { id, hidden } = entry as { id?: unknown; hidden?: unknown };
    if (typeof id !== "string" || !id) return { error: "each shelf needs a non-empty id" };
    if (id.length > MAX_SHELF_ID_LENGTH) return { error: "a shelf id that long is not one of ours" };
    if (hidden !== undefined && typeof hidden !== "boolean") return { error: "hidden must be a boolean" };
    if (seen.has(id)) return { error: `${id} is listed twice` };
    seen.add(id);
    choices.push({ id, hidden: hidden === true });
  }
  return { choices };
}
