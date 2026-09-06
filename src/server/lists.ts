/**
 * Everything `/lists` needs that its own catalogue cannot tell it, in ONE payload.
 *
 * Three answers, and they share a response because they share a page and none of them may
 * cost it a round trip. `/lists` is an INDEX -- twenty-nine rows of links -- so a request per
 * row was never on the table, and the rule its route was built under is that anything added
 * to it rides the call already being made:
 *
 * - COMPLETION, "you own 178 of 250". The one number a thin proxy over TMDB cannot answer,
 *   for the same reason the award pages' cannot: it needs the ranked index and the library
 *   mirror at once, and here they are two SQLite files on the same disk.
 * - POSTERS for the curated rows, so eight award lists are recognisable rather than eight
 *   more lines of text. Ids only, from the winners already held in memory.
 * - PEOPLE BOARDS, over the membership the completion counts resolve on the way past. Who
 *   turns up most across the `finderr Top 250` lists is a fact about the lists on this page,
 *   which is why it belongs on it rather than on a page of its own.
 *
 * Every collaborator arrives as an argument -- membership, ownership, winners, artwork,
 * credits -- so the payload can be exercised against four fake tconsts with no index, no
 * library and no server. `index.ts` is where the real ones are wired.
 */

import type { AnchorWin } from "../lib/award-marks";
import { type ComputedList, CURATED, computedLists, isAllTimeList } from "../lib/lists";
import { type CreditTally, creditBoards } from "../lib/people";
import type { PersonLeaderboard } from "../lib/people-leaderboard";

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

/**
 * One poster in a curated row's strip: what to draw, and what it is.
 *
 * TWO FIELDS AND NOT A DECORATED TITLE ROW. A strip is decoration behind a link that already
 * says where it goes, so it needs no library state, no request button and no award chip --
 * and the chip is the one worth naming: `decorate()` stamps an award mark on every title it
 * touches, so a decorated Best Picture winner sitting inside the Best Picture row would draw
 * a chip for the very award whose list it is in. Sending ids past that machinery avoids the
 * question rather than answering it.
 *
 * The poster URL is not on the wire either: it is `/img/t/<tconst>` for every title in the
 * product and `posterUrl()` in the browser already derives it. Sending it would be forty
 * copies of a string the client can spell.
 */
export interface ListPoster {
  tconst: string;
  /** The film's name as the AWARD SOURCE prints it -- see `AnchorWin.title`. */
  title: string;
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
  /**
   * What an award's top prize has gone to, newest first. `AwardMarkIndex.winnersFor`.
   *
   * In memory rather than queried, which is what keeps a strip per curated row free. The
   * whole anchor-winner set is a few hundred rows across eight awards.
   */
  winners: (award: string) => readonly AnchorWin[];
  /** Have we ALREADY resolved artwork for this title? `Store.getArtwork`, in the real wiring. */
  hasPoster: (tconst: string) => boolean;
  /** Credits over a set of titles. `SearchEngine.creditTally` is the real one. */
  credits: (tconsts: string[]) => CreditTally[];
}

export interface CompletionPayload {
  completions: ListCompletion[];
  /** Posters per CURATED list id. An award with none is absent rather than an empty array. */
  posters: Record<string, ListPoster[]>;
  /** Who turns up most across the all-time lists. Empty when the index holds no credits. */
  boards: PersonLeaderboard[];
}

/**
 * How many posters a curated row draws.
 *
 * Five, because that is what fits beside a title and a subtitle in a card a third of a row
 * wide, and because the strip is a hint at what is in the list rather than a view of it. The
 * page that would rather show thirty is `/awards/:award`, which is what the row links to.
 */
export const POSTER_STRIP = 5;

/**
 * The most recent winners of one award that we can actually draw.
 *
 * **A title with no RESOLVED artwork is skipped, never sent as a frame to fill.** `/img/t/:tconst`
 * resolves an unseen poster through Radarr or Sonarr on first request, so shipping ids we have
 * never looked up would turn one page load into forty upstream lookups -- and `/lists` is an
 * index page that is supposed to cost almost nothing. Skipping them also means every frame in
 * the strip fills: no monograms, no gaps.
 *
 * It walks the winners newest-first and stops at `limit`, so the common case reads five rows
 * and the worst case (an award we hold no artwork for at all) reads its own hundred-odd -- a
 * few hundred microseconds against an indexed primary key.
 */
function posterStrip(
  wins: readonly AnchorWin[],
  hasPoster: (tconst: string) => boolean,
  limit = POSTER_STRIP,
): ListPoster[] {
  const strip: ListPoster[] = [];
  for (const win of wins) {
    if (strip.length === limit) break;
    if (hasPoster(win.tconst)) strip.push({ tconst: win.tconst, title: win.title });
  }
  return strip;
}

/**
 * Completion for every computed list, posters for the curated ones, and the people boards.
 *
 * ONE response for the whole page rather than an endpoint per section, because `/lists` draws
 * all of it at once and a request per row is the shape that made that page refuse to fetch
 * anything at all.
 *
 * **36ms for the completion half**, measured 2026-09-03 against the real 1.27M-row index and
 * the 1,969-row library mirror: twenty-one covered seeks on `ix_rank`/`ix_tg_rank` and
 * twenty-one 250-parameter counts on the library's primary key. The FIRST call after a cold
 * boot was 752ms, and every millisecond of that is the OS reading a 550MB file it has never
 * touched -- so the number to plan around is 36ms plus whatever the front page has already
 * warmed, which on any real session is all of it.
 *
 * **The two halves added since cost 17ms and under 1ms**, measured 2026-09-06 on the same
 * machine: the credit rollup is one seek-bounded grouped query (see `creditTally`), and the
 * posters are indexed artwork lookups at 3.2us each -- 196 of them if every award turns out
 * to be undrawable, which is the worst case and is 0.6ms.
 *
 * **AND THE PAYLOAD GREW, which "no additional request" does not bound.** 923 bytes before
 * this card and 4,071 after, measured on the real data at three imported awards -- 764 bytes
 * of posters and 2,363 of boards. At all eight awards the poster half is ~2KB, so ~5.3KB
 * total. That is a page-sized JSON body on a call that already existed, and it is the number
 * to argue with if this ever needs to shrink: fewer posters and a shorter board are the
 * levers, in that order. A second round trip is not one of them.
 *
 * > [!IMPORTANT] THE TWELVE LANGUAGE LISTS ARE THE EXPENSIVE HALF OF THIS LOOP, and their
 * > cost is what decided how many of them there are
 * > **81.0 ms for the twelve, measured 2026-09-06** on a copy of the real 1,288,159-row index
 * > with `ix_lang_code` in place, per-language figures in `LIST_LANGUAGES`. That is against
 * > 36 ms for the other twenty-one lists put together, and the reason is structural rather
 * > than fixable here: a genre or decade list is a covering seek that stops after 250 rows,
 * > while a language list scans DOWN the rank order until 250 films in that language have
 * > accumulated, so a language with a thin catalogue is the expensive one. Swedish would be
 * > 45.5 ms on its own and Finnish 72.4.
 * >
 * > The twelve were chosen against that ladder, so the lever if this ever needs to shrink is
 * > **fewer languages**, and the lever if it needs to GROW is not more of them: it is
 * > denormalising `rank` into `title_lang` the way `title_genre` already carries `votes` and
 * > `year`, which turns every one of these into the same covering seek the genre lists get.
 * > That is `finderr-language-lists-the-thin-tail`, not this function.
 * >
 * > On the wire they are cheap: twelve more `{id,size,owned}` objects is ~470 bytes on a
 * > ~5.3KB body.
 *
 * **The all-time membership is REUSED, not re-queried.** The boards rank over the same ids
 * the completion counts are computed from, and those are already in hand in this loop --
 * asking the index for them a second time would be the one avoidable query here.
 *
 * **A list with no members is OMITTED rather than sent as zero.** An index built before the
 * rank column, or a genre nothing has been ranked in yet, has no list to be complete of --
 * and "you own 0 of 0" reads as an empty library rather than as an absent list. Every
 * surface renders nothing for a missing id, which is the same rule the award pages apply to
 * a ceremony whose films cannot be identified. `posters` and `boards` follow it: an award we
 * can draw nothing for has no key, and a board with nobody on it is not sent.
 */
export function completionPayload({
  year,
  members,
  ownedCount,
  winners,
  hasPoster,
  credits,
}: ListsDeps): CompletionPayload {
  const completions: ListCompletion[] = [];
  const allTime: string[] = [];
  for (const list of computedLists(year)) {
    const ids = members(list);
    if (ids.length === 0) continue;
    if (isAllTimeList(list)) allTime.push(...ids);
    completions.push({ id: list.id, size: ids.length, owned: ownedCount(ids) });
  }

  const posters: Record<string, ListPoster[]> = {};
  for (const list of CURATED) {
    const strip = posterStrip(winners(list.id), hasPoster);
    if (strip.length > 0) posters[list.id] = strip;
  }

  return { completions, posters, boards: creditBoards(credits(allTime)) };
}
