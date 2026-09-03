/**
 * How much of each computed list this instance actually holds.
 *
 * The one number a thin proxy over TMDB cannot answer, for the same reason the award
 * pages' completion count cannot be bought anywhere: it needs the ranked index and the
 * library mirror at once, and here they are two SQLite files on the same disk.
 *
 * Both collaborators arrive as arguments -- the membership query and the ownership count --
 * so the payload can be exercised against four fake tconsts with no index, no library and
 * no server. `index.ts` is where the real ones are wired.
 */

import { type ComputedList, computedLists } from "../lib/lists";

/** What `/lists` and a ranked `/browse` print: "you own 178 of 250 films". */
export interface ListCompletion {
  id: string;
  /**
   * How many titles the list HAS, which is at most `LIST_SIZE` and can be fewer.
   *
   * Sent rather than assumed, because a list with a thin slice behind it genuinely is
   * shorter -- an index still building, or a genre with under 250 ranked titles. Printing
   * "of 250" for a list holding 31 would be a denominator nobody could reach.
   */
  size: number;
  owned: number;
}

/** The index side: the head of one list, as ids. `SearchEngine.rankedMembers` is the real one. */
export type RankedMembers = (list: ComputedList) => string[];

/** The library side: how many of those ids we hold. `Store.ownedCount` is the real one. */
export type OwnedCount = (tconsts: string[]) => number;

export interface ListsDeps {
  /** The year the catalogue is generated for -- the decade lists depend on it. */
  year: number;
  members: RankedMembers;
  ownedCount: OwnedCount;
}

export interface CompletionPayload {
  completions: ListCompletion[];
}

/**
 * Completion for every computed list, in one payload.
 *
 * ONE response for the whole catalogue rather than an endpoint per list, because `/lists`
 * draws twenty-one rows at once and twenty-one requests to fill in twenty-one numbers is
 * the shape that made that page refuse to fetch anything at all.
 *
 * **36ms for the whole payload**, measured 2026-09-03 against the real 1.27M-row index and
 * the 1,969-row library mirror: twenty-one covered seeks on `ix_rank`/`ix_tg_rank` and
 * twenty-one 250-parameter counts on the library's primary key. The FIRST call after a cold
 * boot was 752ms, and every millisecond of that is the OS reading a 550MB file it has never
 * touched -- so the number to plan around is 36ms plus whatever the front page has already
 * warmed, which on any real session is all of it.
 *
 * **A list with no members is OMITTED rather than sent as zero.** An index built before the
 * rank column, or a genre nothing has been ranked in yet, has no list to be complete of --
 * and "you own 0 of 0" reads as an empty library rather than as an absent list. Every
 * surface renders nothing for a missing id, which is the same rule the award pages apply to
 * a ceremony whose films cannot be identified.
 */
export function completionPayload({ year, members, ownedCount }: ListsDeps): CompletionPayload {
  const completions: ListCompletion[] = [];
  for (const list of computedLists(year)) {
    const ids = members(list);
    if (ids.length === 0) continue;
    completions.push({ id: list.id, size: ids.length, owned: ownedCount(ids) });
  }
  return { completions };
}
