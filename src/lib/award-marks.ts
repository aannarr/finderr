/**
 * Which titles WON an award's headline prize, as a lookup a render path may use.
 *
 * A card in a browse grid gets its award mark from a `Map` held in memory, never from a
 * query. That is not an optimisation bolted onto a query -- the award tables live in the app
 * database and the cards come out of the title index, so there is no join available between
 * the two connections and a per-card read would be a per-card round trip. The set is what
 * makes the Map the obvious answer: three awards, roughly two hundred anchor winners between
 * them, against ~12k nominations in total. Holding the winners costs a rounding error and
 * every lookup after that is free.
 *
 * ANCHOR WINNERS ONLY. A nomination chip would land on thousands of titles and stop meaning
 * anything; a win of the award's top prize is the signal, and which prize that is per award is
 * `AwardDef.anchorCategory` -- `null` for the winner-only awards, where the edition has one
 * prize and every stored row is it.
 *
 * > [!IMPORTANT] This module is imported by the BROWSER for its `AwardMark` type
 * > Same rule as `./award-registry`, which it reads: no network, no SQLite, no React. The
 * > rows arrive through `AwardWinnerReader`, so `Store` satisfies it and a test fake can too.
 */

import { AWARDS, type AwardDef } from "./award-registry";
import type { Nomination } from "./awards";

/**
 * One title's award mark, as a decorated row carries it.
 *
 * Deliberately three small fields and NOT the award's name or its anchor label: the browser
 * already imports `AWARDS` (through `./lists`), so it resolves "Best Picture" and "96th" from
 * the registry itself. Sending them per card would be forty copies of the same two strings in
 * a grid response, and a second owner of what the prize is called.
 */
export interface AwardMark {
  /** The award's registry id -- the `/awards/:award` segment, and the key to its definition. */
  award: string;
  /** The edition it was won at: the `/awards/:award/:ceremony` key, never a display label. */
  ceremony: number;
  /** That edition's own year label -- `2024`, or `1927/28` for the earliest ceremonies. */
  year: string;
}

/** Exactly what building the marks reads. `Store` satisfies it; a test fake can too. */
export interface AwardWinnerReader {
  awardWinners(award: string, category: string | null): Nomination[];
}

/**
 * Every anchor winner we can identify, keyed by tconst. ONE query per award, none per title.
 *
 * A title that won the top prize at two of these awards keeps the FIRST in registry order,
 * which is the order `/lists` offers them. That case is real rather than theoretical --
 * Parasite took Best Picture and the Palme d'Or -- and one card draws one chip, so something
 * has to choose. Registry order is the choice a reader can predict and a second award can be
 * added without re-deciding.
 *
 * A winner with no `FilmId` contributes nothing: the source has rows whose film we cannot
 * identify, and this file follows the same rule as the rest of the award subsystem -- an id we
 * do not hold is never guessed at from a title string.
 */
export function buildAwardMarks(
  reader: AwardWinnerReader,
  defs: readonly AwardDef[] = AWARDS,
): Map<string, AwardMark> {
  const marks = new Map<string, AwardMark>();
  for (const def of defs) {
    for (const win of reader.awardWinners(def.id, def.anchorCategory)) {
      for (const tconst of win.filmIds) {
        if (tconst === null || marks.has(tconst)) continue;
        marks.set(tconst, { award: def.id, ceremony: win.ceremony, year: win.year });
      }
    }
  }
  return marks;
}

/**
 * The marks, held for the life of the process and rebuilt when an import replaces the rows.
 *
 * The whole point is that `get` is a `Map` read and nothing else, so a grid of forty cards
 * costs forty hash lookups. The one thing that could quietly undo that is rebuilding inside
 * the getter, which would pass every visual check and every timing eyeball -- so the rebuild
 * is an explicit `refresh()` with exactly one caller: the import.
 *
 * An award table that has never been imported yields an empty map, `get` answers null, and no
 * card draws a chip. That is the ordinary first-boot state, not an error.
 */
export class AwardMarkIndex {
  private marks: ReadonlyMap<string, AwardMark>;

  constructor(
    private readonly reader: AwardWinnerReader,
    private readonly defs: readonly AwardDef[] = AWARDS,
  ) {
    this.marks = buildAwardMarks(reader, defs);
  }

  /** Re-read the winners after an import swapped them. Returns how many titles are marked. */
  refresh(): number {
    this.marks = buildAwardMarks(this.reader, this.defs);
    return this.marks.size;
  }

  /** This title's mark, or null. The only call on a render path, and it queries nothing. */
  get(tconst: string): AwardMark | null {
    return this.marks.get(tconst) ?? null;
  }
}
