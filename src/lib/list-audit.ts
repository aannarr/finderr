/**
 * Does `LIST_LANGUAGES` still say what its docstring claims it says?
 *
 * `src/lib/lists.ts` states a MECHANICAL rule -- a language gets a list when it has at least
 * `LIST_SIZE` ranked non-English films -- and then claims the array is exactly the set of
 * codes over that floor. Nothing checked the claim. It was audited by hand once, and the
 * corpus moves under it: `sh` sat over the floor and out of the array from the day the array
 * grew past twelve, and the crosswalk widening carried `zh`, `el` and `tl` over it in a single
 * commit. Every one of those was found by a person noticing.
 *
 * `lists.test.ts` cannot catch it, and that is structural rather than an oversight: every
 * assertion there derives FROM `LIST_LANGUAGES`, so it is true by construction whatever the
 * array contains. Deleting a row leaves the whole suite green. Catching drift needs the one
 * thing a unit test does not have -- the corpus -- which is why this is a pure comparison
 * here and a job with an index at `src/jobs/audit-lists.ts`.
 *
 * PURE, and the counts are injected. The audit can then be tested against a fixed map of
 * fifteen codes, and the only thing that needs a 1.9 GB database is the job.
 */

import { LIST_LANGUAGES, LIST_SIZE, type ListLanguage } from "./lists";

/** A language over the floor that no list offers. The array is behind the corpus. */
export interface UnlistedLanguage {
  code: string;
  films: number;
}

/** A language with a list whose corpus no longer fills it. The array is ahead of the corpus. */
export interface ShortLanguage extends ListLanguage {
  films: number;
}

export interface ListLanguageAudit {
  /** Codes at or over `LIST_SIZE` with no row in `LIST_LANGUAGES`, worst first. */
  unlisted: UnlistedLanguage[];
  /**
   * Rows in `LIST_LANGUAGES` under `LIST_SIZE`, worst first -- or `null` for an index that
   * cannot answer the question.
   *
   * `null` and `[]` are DIFFERENT ANSWERS and a caller must keep them apart: `[]` is "every
   * list is filled", `null` is "this index predates the crosswalk widening, so a shortfall
   * here would be the FILE's undercount rather than the array's mistake". See
   * `auditListLanguages` for why only this direction has to care.
   */
  short: ShortLanguage[] | null;
  /** How many distinct codes the corpus reaches at all, floor or no floor. */
  counted: number;
}

/**
 * Compare the corpus against the array, in both directions the docstring claims.
 *
 * `crosswalkWidened` decides whether the SHORT direction is answerable, and the asymmetry is
 * real rather than caution. Widening `LANGUAGE_CROSSWALK` only ever ADDS folds, so a code over
 * the floor on an older build is still over it on a newer one and `unlisted` is safe to
 * measure anywhere. The other direction inverts: on a pre-widening index `el` reaches 3 films
 * and `tl` reaches 204, both legitimately listed, because the widening is what carried them
 * over. Reporting those as the array's fault would be a red gate for the file's age, which is
 * the "red for the wrong reason" failure `gate.ts` exists to refuse.
 *
 * The counts must already exclude `UNKNOWN_LANG` -- see `SearchEngine.rankedNonEnglishCounts`,
 * which strips it where every other reader of that storage device has it stripped.
 */
export function auditListLanguages(
  counts: ReadonlyMap<string, number>,
  crosswalkWidened: boolean,
): ListLanguageAudit {
  const listed = new Set(LIST_LANGUAGES.map((l) => l.code));

  const unlisted = [...counts]
    .filter(([code, n]) => n >= LIST_SIZE && !listed.has(code))
    .map(([code, n]) => ({ code, films: n }))
    .sort((a, b) => b.films - a.films || a.code.localeCompare(b.code));

  const short = crosswalkWidened
    ? LIST_LANGUAGES.map((l) => ({ ...l, films: counts.get(l.code) ?? 0 }))
        .filter((l) => l.films < LIST_SIZE)
        .sort((a, b) => a.films - b.films || a.code.localeCompare(b.code))
    : null;

  return { unlisted, short, counted: counts.size };
}

/** Did the audit find something a person has to fix? A direction it could not measure is not a failure. */
export function auditFailed(a: ListLanguageAudit): boolean {
  return a.unlisted.length > 0 || (a.short?.length ?? 0) > 0;
}

const filmCount = (n: number): string => `${n} film${n === 1 ? "" : "s"}`;

/**
 * The audit as something a person reads in a terminal, one `[lists]` line per fact.
 *
 * Separate from `auditListLanguages` for the reason `formatSearchReport` is separate from
 * `buildSearchReport`: the verdict can be asserted on without going through prose.
 *
 * The unmeasured direction is printed ABOVE the verdict, because it is what makes the verdict
 * mean something other than what a reader would assume -- the same order `canary.ts` prints
 * its degraded line in.
 */
export function formatListLanguageAudit(a: ListLanguageAudit): string {
  const lines = [
    `[lists] ${a.counted} languages in the corpus, floor ${LIST_SIZE} ranked non-English films, ` +
      `${LIST_LANGUAGES.length} listed`,
  ];

  if (a.short === null) {
    lines.push(
      "[lists] NOT MEASURED: this index predates the crosswalk widening, so a listed language " +
        "can fall short for the file's reasons rather than the array's. Rebuild with " +
        "`bun run index:build` to check that direction.",
    );
  }

  if (!auditFailed(a)) {
    lines.push(
      a.short === null
        ? "[lists] PASS: no unlisted language clears the floor"
        : "[lists] PASS: LIST_LANGUAGES is exactly the set of codes over the floor",
    );
    return lines.join("\n");
  }

  lines.push(
    `[lists] FAIL: ${a.unlisted.length} over the floor with no list` +
      (a.short === null ? "" : `, ${a.short.length} listed under it`),
  );
  for (const l of a.unlisted) {
    lines.push(`[lists]   no list: ${l.code} (${filmCount(l.films)}) -- add it to LIST_LANGUAGES`);
  }
  for (const l of a.short ?? []) {
    lines.push(
      `[lists]   under floor: ${l.code} "${l.name}" (${filmCount(l.films)}) -- drop it or say why it stays`,
    );
  }
  return lines.join("\n");
}
