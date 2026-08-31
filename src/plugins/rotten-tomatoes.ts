/**
 * Rotten Tomatoes: the Tomatometer, and the audience score nothing else carries.
 *
 * Servarr's Radarr proxy already relays a `RottenTomatoes` critics score, so the critics
 * entry below is a duplicate of one we can get for free -- a better duplicate, because it
 * comes from RT itself and carries the link to the page. The 91% popcorn number is the
 * reason this plugin exists: no Servarr proxy has it and no other free source does either.
 *
 * `source` is the exact string `servarr/radarr.ts` uses, deliberately: the ratings row
 * dedupes on `source|kind`, so matching it collapses the two critics entries into one
 * tile instead of printing `rottentomatoes` next to `Metacritic` and `IMDb`.
 *
 * UNOFFICIAL AND UNCONTRACTED. It can vanish tomorrow. Every failure path here ends with
 * "no RT entries", never with a blanked ratings row -- which is what the facet being a
 * LIST of self-describing sources buys us.
 */

import type { FacetEntity, FreshnessClass, Rating } from "../lib/facets";
import type { PluginContext, PluginExports, PluginKv, PluginMeta } from "../lib/plugins";
import { RT_ALGOLIA_HOST, type RtHit, searchTitles } from "./rotten-tomatoes/algolia";
import { bestMatch } from "./rotten-tomatoes/match";

export const meta = {
  id: "rotten-tomatoes",
  entities: ["movie", "series"],
  hosts: [RT_ALGOLIA_HOST],
} as const satisfies PluginMeta;

/** The label the ratings row prints, and the key it dedupes the Tomatometer on. */
const SOURCE = "RottenTomatoes";

/**
 * Both numbers move, so this is the same class `servarr-metadata` gives `ratings`.
 *
 * The instinct to say `settled` for a 2010 film belongs to core, not here: how settled a
 * title is depends on the title's age, which the freshness ladder reads and a plugin
 * cannot see. This says what KIND of fact it is and stops.
 */
const FRESHNESS: FreshnessClass = "moving";

export function init(c: PluginContext): PluginExports {
  return {
    facets: {
      ratings: async (entity) => {
        const hit = await resolveHit(c, entity);
        if (!hit) return null;
        const data = ratingsOf(hit);
        // A hit with neither score is a real "RT has nothing to say about this", same as
        // no hit at all -- the chip is absent either way, so both cache as an empty facet.
        return data.length === 0 ? null : { data, freshness: FRESHNESS };
      },
    },
  };
}

/**
 * RT's entry for this title: matched once, then recognised by id forever after.
 *
 * The search runs on every refresh because the scores are the point of the refresh. The
 * MATCH does not: the identity resolved the first time lives in `c.kv`, and later
 * refreshes pick their hit by that id rather than re-scoring. So the fuzzy matcher runs
 * once per title ever, and a refresh can never quietly change which film we are showing
 * scores for. Seerr re-guesses on every cache expiry.
 */
async function resolveHit(ctx: PluginContext, entity: FacetEntity): Promise<RtHit | null> {
  const known = storedIdentity(ctx.kv, entity.tconst);
  const hits = await searchTitles(ctx.fetch, entity);

  // A known id that is no longer in the results means RT retired that entry. Answering
  // with nothing lets the empty facet expire and the search be tried again later, which
  // is a slower recovery than re-matching and a much safer one.
  if (known) return hits.find((hit) => hit.emsId === known.emsId) ?? null;

  const matched = bestMatch(hits, entity);
  // Only successes are stored. A film RT has not indexed yet may well be there next month,
  // and a permanently cached "no match" would keep it invisible forever.
  if (matched) storeIdentity(ctx.kv, entity.tconst, matched);
  return matched;
}

/**
 * What one fuzzy match bought, kept forever: RT's own primary key and its page slug.
 *
 * In `c.kv` rather than in the facet cache precisely because the facet expires and this
 * must not -- re-running the matcher is both the expensive half and the risky half.
 */
interface RtIdentity {
  emsId: string;
  vanity: string;
}

function identityKey(tconst: string): string {
  return `hit:${tconst}`;
}

function storedIdentity(kv: PluginKv, tconst: string): RtIdentity | null {
  const raw = kv.get(identityKey(tconst));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RtIdentity;
  } catch {
    // A row this plugin cannot read is one an older version of it wrote. Re-matching is a
    // correct recovery; throwing here would fail the facet on every view until someone
    // cleared the table by hand.
    return null;
  }
}

function storeIdentity(kv: PluginKv, tconst: string, hit: RtHit): void {
  const identity: RtIdentity = { emsId: hit.emsId, vanity: hit.vanity };
  kv.set(identityKey(tconst), JSON.stringify(identity));
}

/**
 * The two scores, each included only when RT actually has it.
 *
 * Plenty of entries carry one and not the other -- an unreleased film has critics and no
 * audience, a short has an audience and no critics -- and a missing score must be an
 * absent entry rather than a zero.
 *
 * `certifiedFresh` and `scoreSentiment` are deliberately dropped: core's `Rating` shape
 * has nowhere to put them, and widening a shared shape for one provider's icon state is
 * the ratings row's decision to make, not this plugin's.
 */
function ratingsOf(hit: RtHit): Rating[] {
  const scores = hit.rottenTomatoes;
  if (!scores) return [];
  const url = pageUrl(hit);
  const entries: [Rating["kind"], number | null | undefined][] = [
    ["critics", scores.criticsScore],
    ["audience", scores.audienceScore],
  ];
  return entries.flatMap(([kind, value]) =>
    typeof value === "number" ? [{ source: SOURCE, kind, value, outOf: 100, url }] : [],
  );
}

/** Where a human goes to see this. `/m/` for films, `/tv/` for series. */
function pageUrl(hit: RtHit): string {
  return `https://www.rottentomatoes.com/${hit.type === "tv" ? "tv" : "m"}/${hit.vanity}`;
}
