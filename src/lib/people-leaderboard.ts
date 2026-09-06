/**
 * A ranked list of PEOPLE, and the one rule that makes such a list worth reading twice.
 *
 * The shape rather than any particular ranking: a board is a heading, a caveat, a unit and a
 * column of people with a number each. What the number COUNTS is the parameter -- Oscar
 * nominations today, credits or shared titles tomorrow -- which is what stops the second
 * people-ranking surface from being a second page.
 *
 * > [!IMPORTANT] The order is TOTAL, and that is the whole reason this is a function
 * > A leaderboard is read, screenshotted and come back to. Two people tied on the count must
 * > land in the same order every time it is drawn, so the sort ends in `name` and then
 * > `nconst` -- the same tail keys `frequentCollaborators` and `searchPeople` already use.
 * > A list that reshuffles between page loads is worse than one that is merely imperfect.
 *
 * No React, no SQL, no fetch. The browser imports these types directly, exactly as
 * `web/src/routes/ListsRoute.tsx` imports the list catalogue: one owner for the shape the
 * server sends and the page draws.
 */

/** One person on a board: who they are, the number they are ranked on, and the fact beside it. */
export interface RankedPerson {
  nconst: string;
  name: string;
  /** What the board ranks on. Always at least 1 -- see `rankPeople`. */
  value: number;
  /**
   * The other number worth seeing on the row, already phrased.
   *
   * A STRING rather than a second number, because only the board that built it knows what
   * it means: "won 5" under a nomination count, "45 nominations" under a win count. Phrasing
   * it here keeps one owner of the sentence, the way `anchorNoun` does for the completion
   * line. `null` on a board where the rank number is the whole story.
   */
  note: string | null;
}

/** One ranked list, ready to draw. */
export interface PersonLeaderboard {
  /** Stable within a page -- the React key and the heading's anchor. */
  id: string;
  title: string;
  /**
   * One sentence under the heading, and where a board's honest caveat goes.
   *
   * "Most nominated, never won" is the list people screenshot and the one that most needs
   * saying what it is NOT -- a person who has won everything else reads as a loser on a
   * table that knows about one prize. `null` for a board that needs no disclaimer.
   */
  blurb: string | null;
  /** What `value` counts. Singular and plural, because English does not derive one. */
  unit: { one: string; many: string };
  entries: RankedPerson[];
}

/** A board is a page's worth of names, not a directory. */
export const DEFAULT_BOARD_SIZE = 25;

export interface RankOptions<T> {
  /** The number to rank on. Anything at zero or below is left off the board entirely. */
  value: (person: T) => number;
  note?: (person: T) => string | null;
  limit?: number;
}

/**
 * Rank people by one number, highest first, deterministically.
 *
 * **Zero is not a low score, it is not being on this board.** "Most wins" over everybody who
 * has ever been nominated would otherwise run to thousands of people who have won nothing,
 * which is a list of who the board is not about. Filtering here rather than at each caller
 * is what stops the third board forgetting.
 *
 * `name` is compared with `localeCompare` rather than `<`, so an accented name sorts where a
 * reader expects rather than after `Z`.
 */
export function rankPeople<T extends { nconst: string; name: string }>(
  people: readonly T[],
  opts: RankOptions<T>,
): RankedPerson[] {
  return people
    .map((person) => ({
      nconst: person.nconst,
      name: person.name,
      value: opts.value(person),
      note: opts.note?.(person) ?? null,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name) || a.nconst.localeCompare(b.nconst))
    .slice(0, opts.limit ?? DEFAULT_BOARD_SIZE);
}
