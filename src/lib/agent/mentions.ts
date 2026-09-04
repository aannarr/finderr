/**
 * Turning the ids inside an answer into things a reader can click.
 *
 * The model writes prose and names entities in it. Until this existed those names were flat
 * text and the only navigable things on screen were the cards beside the answer -- so the
 * sentence *"Emmy Rossum was in Shameless"* sat next to a card for Shameless and neither one
 * knew about the other. That is a chatbot bolted to finderr rather than finderr answering.
 *
 * The second rule of this product is that every noun on screen is a destination. This is that
 * rule applied to the one surface that had been exempt from it.
 *
 * > [!IMPORTANT] THE DEAD-END RULE: AN ID THAT DOES NOT RESOLVE STAYS PLAIN TEXT
 * > A model can emit a well-formed `tt99999999` that has never existed. Rendering a link
 * > from the SHAPE of an id would give a reader a confident-looking destination that 404s,
 * > which is worse than the plain text it replaced -- navigable does not outrank honest.
 * >
 * > So every candidate is looked up before it becomes a link, and a miss is simply left
 * > alone. That is also why this is a BATCH: one query for the whole answer rather than one
 * > per mention, because the render path may not go to the database N times for one
 * > paragraph. `PersonLink` in `web/src/components/TitlePanes.tsx` follows the same rule for
 * > cast names, and `titleLinks()` follows it for external ids.
 *
 * > [!CAUTION] RESOLUTION IS AGAINST OUR INDEX, NOT AGAINST THE MODEL'S CLAIM
 * > The label rendered is the title we hold, never the text the model wrote around the id.
 * > A model that writes "tt0903747 (The Sopranos)" is wrong -- that is Breaking Bad -- and
 * > echoing its label would launder the error into something that looks verified. The link
 * > text comes from the row.
 */

import type { Database } from "bun:sqlite";

/** A resolved id, ready for the client to draw as a link. */
export interface Mention {
  id: string;
  kind: "title" | "person";
  /** OUR label for it, never the model's. */
  label: string;
  /** Where it goes. Same shape `navigate` returns, so there is one spelling of a route. */
  path: string;
  year?: number | null;
}

/**
 * Every `tt…`/`nm…` that appears in a string.
 *
 * The boundary matters: `\b` alone would match the `tt1234567` inside `xtt1234567`, and a
 * lookalike that resolves to a real row would render a link over a fragment of another word.
 * IMDb ids are 7+ digits in practice, but shorter ones exist in the corpus, so the digit
 * count is deliberately not floored -- a wrong-length id simply fails to resolve, which is
 * the same safe outcome as any other miss.
 */
export function idsIn(text: string): string[] {
  const found = text.match(/(?<![A-Za-z0-9])(?:tt|nm)\d+(?![A-Za-z0-9])/g);
  return found ? [...new Set(found)] : [];
}

/** `?,?,?` for a variable IN list. SQLite has no array binding. */
function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

/**
 * Resolve every id mentioned in `text`, in ONE query per kind.
 *
 * Two queries rather than one union: `title` and `person` are different tables with different
 * columns, and a union would need padding columns that mean nothing for half the rows. Two
 * statements is still O(1) in the length of the answer, which is the property that matters.
 *
 * Capped, because the query is built from the ids found and an answer that somehow named a
 * thousand of them should not become a thousand-parameter statement. Past the cap the extra
 * mentions stay plain text -- the dead-end rule's outcome, reached by a different road.
 */
export const MAX_MENTIONS = 60;

export function resolveMentions(db: Database, text: string): Mention[] {
  const ids = idsIn(text).slice(0, MAX_MENTIONS);
  if (ids.length === 0) return [];

  const tconsts = ids.filter((i) => i.startsWith("tt"));
  const nconsts = ids.filter((i) => i.startsWith("nm"));
  const out: Mention[] = [];

  if (tconsts.length > 0) {
    const rows = db
      .query(`select tconst, title, year from title where tconst in (${placeholders(tconsts.length)})`)
      .all(...tconsts) as { tconst: string; title: string; year: number | null }[];
    for (const r of rows) {
      out.push({ id: r.tconst, kind: "title", label: r.title, year: r.year, path: `/title/${r.tconst}/` });
    }
  }

  if (nconsts.length > 0) {
    /*
      Guarded by the table's existence, not assumed.

      An index built before the cast stage has no `person` table at all, and this runs on the
      render path -- a bare query would throw `no such table: person` and take an otherwise
      good answer down with it. Same rule `hasPeople` follows in `SearchEngine`; the read
      degrades to "those ids stay plain text", which is exactly the dead-end outcome.
    */
    const hasPeople =
      (db.query("select name from sqlite_master where type='table' and name='person'").all() as unknown[])
        .length > 0;
    if (hasPeople) {
      const rows = db
        .query(`select nconst, name from person where nconst in (${placeholders(nconsts.length)})`)
        .all(...nconsts) as { nconst: string; name: string }[];
      for (const r of rows) {
        out.push({ id: r.nconst, kind: "person", label: r.name, path: `/person/${r.nconst}/` });
      }
    }
  }

  return out;
}
