/**
 * Which STREAMING SERVICE a `watchProviders` offer is, whatever TMDB called it.
 *
 * TMDB does not have a service id anybody can join on. It has ~300 provider NAMES, and one
 * service wears several of them -- `Netflix`, `Netflix Standard with Ads`, `Netflix basic
 * with Ads`; `HBO Max` and `HBO Max Amazon Channel`. Every question this codebase asks
 * about a service ("draw one tile", "what else is on it") first has to fold those names
 * into one key, so the fold is the vocabulary and it lives here.
 *
 * IN `src/lib` RATHER THAN IN THE BROWSER, and that move is the whole reason this file
 * exists. `watchServices` was in `web/src/lib/facet-panes.ts`, where a render module is a
 * reasonable home for it -- right up to the moment the SERVER had to answer "which titles
 * are on Netflix", which is the same fold asked from the other end. Two copies of a table
 * with 42 hand-written spellings in it would have drifted on the first service TMDB
 * renamed. The browser still imports every name below; `src/lib/lists.ts` is the precedent
 * for that direction.
 *
 * PURE, and it has to stay that way: this is imported into the browser bundle, so nothing
 * here may reach for `bun:sqlite`, the filesystem or config.
 */

import type { WatchProviders } from "./facets";

/** One service, ready to draw: its mark where we have one, its name in every case. */
export interface WatchService {
  /** TMDB's spelling -- the visible label when there is no mark, the accessible name always. */
  name: string;
  /** The Kometa mark on disk, or null. */
  logo: string | null;
  /**
   * The folded identity, shared by every spelling of this service.
   *
   * What the tile dedupe keys on and what a `/term/service/:key` URL carries, so the chip a
   * reader clicks and the rows the server counts cannot disagree about what "Netflix" is.
   */
  key: string;
}

/**
 * This reader's country's offers, out of the hundred-odd the facet carries.
 *
 * The server caches one answer per title for every reader, so the region is chosen HERE.
 * Unlike `pickCertification` there is no fallback to "whatever country we do have": a
 * German subscription is not an answer to "where can I watch this" asked from Bangkok,
 * and a wrong shelf is worse than an absent one.
 */
export function pickWatchProviders(
  entries: readonly WatchProviders[],
  preferred: readonly string[],
): WatchProviders | null {
  for (const country of preferred) {
    const hit = entries.find((e) => e.country.toUpperCase() === country.toUpperCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * The services this title actually STREAMS on here, deduplicated, in TMDB's order.
 *
 * Two rules, and the second one is a fix.
 *
 * **Streaming only -- `rent` and `buy` are deliberately not drawn.** "Where to watch"
 * answers whether a reader can watch this now; every digital storefront on earth will sell
 * them a copy, and a row of them is a row of non-answers. The facet still CARRIES both,
 * because it is a faithful cache of one upstream document and re-deriving them later would
 * cost a fresh call per title -- the editorial choice lives here, where render decisions
 * live, not in what gets cached.
 *
 * **The dedupe key is the SERVICE, not the name.** TMDB splits one service across several
 * names -- `Netflix`, `Netflix Standard with Ads`, `Netflix basic with Ads` -- and they all
 * wear the same Kometa mark, so keying on the name drew the identical Netflix tile twice
 * with nothing to tell the two apart. This is the exact collision `mergeRatings` guards on
 * the ratings row, arriving from the other direction: there, two spellings of one source;
 * here, three products of one service.
 *
 * Position never breaks a tie -- the winner is ranked on CONTENT, the same rule
 * `mergeRatings` follows and for the same reason. **The DIRECT name beats a reseller's**:
 * `HBO Max Amazon Channel` and `HBO Max` are one key, and the reader is asking which
 * service, so the answer is "HBO Max" whichever order TMDB happened to send them in.
 * Everything else keeps the first writer, because TMDB sends `display_priority` order and a
 * later duplicate reshuffling the row is the race the ratings tile already learned not to
 * have.
 */
export function watchServices(entry: WatchProviders): WatchService[] {
  const byKey = new Map<string, WatchService>();
  for (const name of entry.flatrate) {
    const key = serviceKey(name);
    const held = byKey.get(key);
    if (!held) byKey.set(key, { name, logo: streamingLogo(name), key });
    else if (isResold(held.name) && !isResold(name)) {
      byKey.set(key, { name, logo: streamingLogo(name), key });
    }
  }
  return [...byKey.values()];
}

/**
 * The one identity every spelling of a service folds to.
 *
 * The Kometa slug where we have a mark, and the folded name where we do not. Both are
 * already unique per service and the two spaces cannot collide meaningfully: a folded name
 * that equals a slug IS that service (`netflix`), so merging them is the right answer
 * rather than an accident.
 *
 * URL-SAFE by construction -- lowercase alphanumerics and the hyphens Kometa's slugs carry
 * -- which is what lets it be a path segment without a second encoding rule.
 */
export function serviceKey(name: string): string {
  const folded = foldServiceName(name);
  return STREAMING_MARKS[folded] ?? folded;
}

/**
 * `+` is SPELT OUT before the fold, and that is not cosmetic.
 *
 * Stripping it instead would make "Disney" and "Disney+" the same key, and they are two
 * different services with two different marks -- the same collision `slugifyLogo` in
 * `src/lib/logos.ts` spells `+` out to avoid, measured there across Kometa's 765 names.
 * The rule is mirrored rather than imported because that module reads the logo manifest off
 * disk, and this one is in the browser bundle.
 */
export function streamingLogo(name: string): string | null {
  const slug = STREAMING_MARKS[foldServiceName(name)];
  return slug ? `/logos/streaming/${slug}.png` : null;
}

/**
 * TMDB's name for a service -> the Kometa mark on disk, or null if we have none.
 *
 * The same shape as `ratingLogo`, and for the same reason: the client names a file
 * directly rather than reading the logo manifest, so a test asserts every path this can
 * emit exists in `src/logos.json`.
 *
 * The table is keyed on TMDB's vocabulary folded to alphanumerics, because TMDB spells one
 * service several ways -- "Disney Plus" and "Disney+", "Paramount Plus Premium" and
 * "Paramount+" -- and every spelling wears the same mark. Kometa publishes 26 streaming
 * marks against TMDB's ~300 services, so MOST services have none: the row prints the name
 * instead, which is why the name is what the facet carries.
 *
 * Exported for the manifest guard in the tests, which asserts every slug here is a file
 * the logo importer actually wrote. Reading the table beats re-typing its keys in a test.
 */
export const STREAMING_MARKS: Record<string, string> = {
  netflix: "netflix",
  netflixkids: "netflix",
  netflixstandardwithads: "netflix",
  netflixbasicwithads: "netflix",
  amazonprimevideo: "prime-video",
  amazonprimevideowithads: "prime-video",
  amazonprimevideofreewithads: "prime-video",
  appletv: "appletv",
  appletvstore: "appletv",
  appletvplus: "appletv-plus",
  disneyplus: "disney-plus",
  disney: "disney",
  hbomax: "hbo-max",
  max: "max",
  hulu: "hulu",
  paramountplus: "paramount-plus",
  paramountplusessential: "paramount-plus",
  paramountpluspremium: "paramount-plus",
  peacock: "peacock",
  peacockpremium: "peacock",
  peacockpremiumplus: "peacock",
  crunchyroll: "crunchyroll",
  tubi: "tubi",
  tubitv: "tubi",
  youtube: "youtube",
  youtubefree: "youtube",
  youtubepremium: "youtube",
  amcplus: "amc-plus",
  discoveryplus: "discovery-plus",
  betplus: "bet-plus",
  crave: "crave",
  now: "now",
  nowtv: "now",
  nowtvcinema: "now",
  itvx: "itvx",
  channel4: "channel-4",
  my5: "my-5",
  hayu: "hayu",
  filmin: "filmin",
  atresplayer: "atres-player",
  movistarplusplus: "movistar-plus-plus",
};

/**
 * The storefronts a service can be RESOLD through, as suffixes on TMDB's own names.
 *
 * `HBO Max Amazon Channel` is HBO Max, bought through Prime. TMDB lists the reseller as a
 * separate provider, so a title on both rendered two tiles -- one wearing the HBO mark and
 * one printing the long name beside it, which is the duplicate caught on Game of
 * Thrones after the Netflix one was fixed. Folding the suffix away answers the question the
 * pane is actually asking: WHICH SERVICE, not through whose billing.
 *
 * A closed list, deliberately. A blanket `/channel$/` would eat a service genuinely named
 * for a channel, and there is no way to tell the two apart from the string alone.
 */
const RESELLER_SUFFIXES = /(amazonchannel|appletvchannel|rokupremiumchannel)$/;

/** Whether TMDB's name for this offer is the reseller's rather than the service's own. */
function isResold(name: string): boolean {
  return RESELLER_SUFFIXES.test(baseFold(name));
}

/**
 * TMDB's spelling, reduced to letters and digits.
 *
 * `+` is spelt out BEFORE the non-alphanumerics go, which is the whole reason this is a
 * function rather than one regex: stripping it instead would make `Disney` and `Disney+`
 * one key, and they are two different subscriptions wearing two different marks.
 *
 * The reseller suffix SURVIVES here, because `isResold` needs to see it. `foldServiceName`
 * is the one that takes it off.
 */
function baseFold(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The one key both the mark table and the tile dedupe agree on: which SERVICE this is,
 * with the reseller's billing arrangement folded away.
 */
function foldServiceName(name: string): string {
  return baseFold(name).replace(RESELLER_SUFFIXES, "");
}
