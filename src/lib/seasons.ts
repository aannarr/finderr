/**
 * The one owner of how a season selection is encoded.
 *
 * A request stores which seasons the reader asked for as a comma-joined string in a
 * single column (`request.seasons`), and three places need to agree on that spelling:
 * the handler that validates what the browser sent, the store that writes the row, and
 * the worker that reads it back to build Sonarr's payload. Writing the `split(",")` out
 * three times is how the three drift, so it lives here once.
 *
 * `null` means "the reader never chose". It is NOT the same as a list naming every
 * season -- see `MediaRequest.seasons`. Keeping the two distinguishable is the whole
 * reason this is nullable rather than defaulting to a full list at write time.
 */

/** The largest season number we will believe. Sonarr's own ceiling is far lower. */
const MAX_SEASON = 1000;

/**
 * Normalise a selection into the stored form: sorted, deduplicated, comma-joined.
 *
 * Sorting and deduplicating here rather than at the call site means two readers who
 * ticked the same seasons in a different order produce the same row, so a stored value
 * can be compared as a string.
 */
export function encodeSeasons(seasons: readonly number[] | null | undefined): string | null {
  if (!seasons || seasons.length === 0) return null;
  const unique = [...new Set(seasons)].sort((a, b) => a - b);
  return unique.join(",");
}

/**
 * Read a stored value back. Returns null for "all seasons", never an empty array --
 * an empty array would mean "monitor nothing", which is a request nobody can have made.
 */
export function decodeSeasons(stored: string | null | undefined): number[] | null {
  if (!stored) return null;
  const nums = stored
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n));
  return nums.length > 0 ? nums : null;
}

/**
 * Validate what arrived over the wire.
 *
 * Returns the cleaned list, or `null` for "not specified", or an ERROR STRING the
 * handler can hand straight back as a 400. Three shapes are refused rather than
 * quietly coerced, because each one means the client is confused and guessing at its
 * intent would queue a download nobody asked for:
 *
 * - a non-array, or an element that is not a whole number
 * - a negative season (0 is legitimate -- it is the specials)
 * - an EMPTY array, which reads as "monitor no seasons at all"
 */
export function parseSeasonsInput(value: unknown): { seasons: number[] | null } | { error: string } {
  if (value === undefined || value === null) return { seasons: null };
  if (!Array.isArray(value)) return { error: "seasons must be an array of season numbers" };
  if (value.length === 0) return { error: "seasons must name at least one season" };

  const out: number[] = [];
  for (const raw of value) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return { error: "seasons must be whole numbers" };
    }
    if (raw < 0 || raw > MAX_SEASON) return { error: `season ${raw} is out of range` };
    out.push(raw);
  }
  return { seasons: [...new Set(out)].sort((a, b) => a - b) };
}
