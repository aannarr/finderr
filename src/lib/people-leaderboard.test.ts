/**
 * The one rule a leaderboard has to keep: the same rows produce the same order, every time.
 *
 * Pure input, pure output, no database -- which is the whole reason `rankPeople` takes rows
 * rather than a reader. Everything about what a board MEANS is tested in `awards.test.ts`;
 * this file is only about the sort.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_BOARD_SIZE, rankPeople } from "./people-leaderboard";

interface Tally {
  nconst: string;
  name: string;
  nominations: number;
  wins: number;
}

const person = (nconst: string, name: string, nominations: number, wins = 0): Tally => ({
  nconst,
  name,
  nominations,
  wins,
});

const byNominations = { value: (p: Tally) => p.nominations };

describe("rankPeople", () => {
  test("highest first, and the number travels with the row", () => {
    const ranked = rankPeople(
      [person("nm2", "Second", 5), person("nm1", "First", 9), person("nm3", "Third", 1)],
      byNominations,
    );
    expect(ranked.map((r) => r.name)).toEqual(["First", "Second", "Third"]);
    expect(ranked[0]?.value).toBe(9);
  });

  /**
   * The card's rule, and the reason this is a function rather than a `sort` at each caller: a
   * leaderboard is screenshotted and come back to, so two people on the same count must not
   * swap between page loads. `sort` is not stable across engines for equal keys, and even
   * where it is, the INPUT order here is a SQLite group-by with no `order by` -- which is
   * exactly the kind of order nobody promised.
   */
  test("a tie breaks on name, then on nconst -- never on the order the rows arrived in", () => {
    const tied = [
      person("nm9", "Zoe Adams", 4),
      person("nm1", "Ada Bell", 4),
      person("nm4", "Ada Bell", 4),
      person("nm2", "Ada Bell", 4),
    ];
    const order = () => rankPeople(tied, byNominations).map((r) => r.nconst);
    expect(order()).toEqual(["nm1", "nm2", "nm4", "nm9"]);
    // The same rows shuffled must give the same answer, which is the property that matters.
    expect(rankPeople([...tied].reverse(), byNominations).map((r) => r.nconst)).toEqual(order());
  });

  test("an accented name sorts where a reader expects rather than after Z", () => {
    const ranked = rankPeople(
      [person("nm2", "Zeta", 3), person("nm1", "Ángel", 3), person("nm3", "Bela", 3)],
      byNominations,
    );
    expect(ranked.map((r) => r.name)).toEqual(["Ángel", "Bela", "Zeta"]);
  });

  /** Zero is not a low score, it is not being on this board -- see `rankPeople`. */
  test("nobody scoring zero is on the board at all", () => {
    const ranked = rankPeople([person("nm1", "Won", 3, 2), person("nm2", "Never", 12, 0)], {
      value: (p) => p.wins,
    });
    expect(ranked.map((r) => r.name)).toEqual(["Won"]);
  });

  test("the note is phrased by the board and rides on the row", () => {
    const ranked = rankPeople([person("nm1", "Somebody", 8, 3)], {
      ...byNominations,
      note: (p) => `won ${p.wins}`,
    });
    expect(ranked[0]?.note).toBe("won 3");
  });

  test("no note is null rather than an empty string, so a page can test for it", () => {
    expect(rankPeople([person("nm1", "Somebody", 8)], byNominations)[0]?.note).toBeNull();
  });

  test("a board is a page of names, not a directory", () => {
    const many = Array.from({ length: DEFAULT_BOARD_SIZE + 10 }, (_, i) =>
      person(`nm${i}`, `Person ${i}`, i + 1),
    );
    expect(rankPeople(many, byNominations)).toHaveLength(DEFAULT_BOARD_SIZE);
    expect(rankPeople(many, { ...byNominations, limit: 3 })).toHaveLength(3);
  });

  test("nobody at all is an empty board rather than a throw", () => {
    expect(rankPeople([], byNominations)).toEqual([]);
  });
});
