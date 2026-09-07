import {
  type PreviewPerson,
  type PreviewTitle,
  renderPersonPreviewPage,
  renderPreviewPage,
} from "../lib/og-preview";
import { cacheHeaders, sharedPerSession, withImageExt } from "./cache-policy";
import { PREVIEW_IMAGE_PATH } from "./preview-resolver";

/**
 * Everything the preview page is allowed to touch, as injected functions.
 *
 * > [!IMPORTANT] The seam exists so the SAFETY PROPERTIES can be tested, not for tidiness
 * > This is the one handler in the product that answers an anonymous caller with real
 * > content, and the two things it must never do -- warm a facet, resolve a poster without
 * > a bound -- are invisible in a comment and obvious in a fake. `index.ts` supplies the
 * > real implementations and `preview.test.ts` supplies counting ones, so "a preview costs
 * > no upstream call" is an assertion rather than a promise.
 *
 * Same reason `shelves.ts` and `health.ts` were lifted out of `index.ts` before it.
 */
export interface PreviewDeps {
  /** The local index row, or null when we do not index this id. */
  rowFor(tconst: string): PreviewTitle | null;
  /**
   * The cached synopsis, or null.
   *
   * **Reads the facet cache and never warms it.** `FacetResolver.warm()` starts every
   * provider that owes this title an answer, so calling it here would let one shared link
   * buy thirteen upstream calls -- from a stranger, with no session, for any of 1.27M ids.
   */
  cachedSynopsis(tconst: string): string | null;
  /**
   * What the artwork cache already knows. `undefined` means never looked; a row with a
   * null url means looked and there is no poster, which must NOT re-ask.
   */
  cachedPoster(tconst: string): { url: string | null } | undefined;
  /** Resolve a never-seen poster, ALREADY BOUNDED. Returns null when refused. */
  resolvePoster(tconst: string, kind: string): Promise<string | null>;
  /** Per-caller fairness. False means fall through to the ordinary shell. */
  allow(req: Request): boolean;
  origin(req: Request): string;
  siteName: string;
  headers: Record<string, string>;
}

/**
 * The Open Graph page for a shared link, or `null` to fall through to the sign-in shell.
 *
 * **`null` is the only failure mode, and never a status code.** A crawler shown a 429 or a
 * 500 caches it and the link stays broken in that channel long after the cause is gone;
 * a crawler shown the ordinary sign-in page simply renders no card and the next share is
 * free to succeed. The fall-through is the error handling.
 */
export async function previewResponse(
  req: Request,
  tconst: string,
  deps: PreviewDeps,
): Promise<Response | null> {
  const row = deps.rowFor(tconst);
  if (!row) return null;
  if (!deps.allow(req)) return null;

  const known = deps.cachedPoster(tconst);
  const posterUrl = known !== undefined ? known.url : await deps.resolvePoster(tconst, row.kind);

  const origin = deps.origin(req);
  return cardResponse(
    renderPreviewPage({
      title: row,
      synopsis: deps.cachedSynopsis(tconst),
      imageUrl: posterUrl ? withImageExt(`${origin}${PREVIEW_IMAGE_PATH}/${tconst}`) : null,
      origin,
      returnPath: `/title/${tconst}`,
      siteName: deps.siteName,
    }),
    deps.headers,
  );
}

/** What a person card is allowed to touch. Local SQLite only, and no bounded exception. */
export interface PersonPreviewDeps {
  /**
   * The person, their best-known titles and how many credits we hold, or `null`.
   *
   * ONE dep rather than three, because all three come out of a single `personPage()` call
   * and splitting them would invite a second read of the same rows per unfurl.
   */
  pageFor(nconst: string): { person: PreviewPerson; knownFor: string[]; credits: number } | null;
  /**
   * The face we have already filed under this person, or null.
   *
   * **There is no bounded-resolve escape hatch here, and that is the difference from the
   * title card.** A poster can be bought from Radarr for an id we have never seen; a
   * headshot only ever arrives as a side effect of somebody signed in opening a title page,
   * so there is nothing to go and fetch. A person with no face cached unfurls without one,
   * which is the ordinary degraded card rather than a gap worth an upstream call.
   */
  faceKey(nconst: string): string | null;
  /** Per-caller fairness, shared with the title card -- one bucket, one shared surface. */
  allow(req: Request): boolean;
  origin(req: Request): string;
  siteName: string;
  headers: Record<string, string>;
}

/**
 * The Open Graph page for a shared person link, or `null` to fall through to the shell.
 *
 * Same `null`-is-the-only-failure rule as `previewResponse`, and for the same reason: a
 * crawler that caches a 429 keeps the link broken in that channel long after the minute
 * that produced it. An nconst we do not index is a fall-through, never a 404 -- the shell
 * is a correct answer to "what is at this address" for a signed-out reader either way.
 */
export function personPreviewResponse(
  req: Request,
  nconst: string,
  deps: PersonPreviewDeps,
): Response | null {
  const page = deps.pageFor(nconst);
  if (!page) return null;
  if (!deps.allow(req)) return null;

  const origin = deps.origin(req);
  const key = deps.faceKey(nconst);
  return cardResponse(
    renderPersonPreviewPage({
      person: page.person,
      knownFor: page.knownFor,
      credits: page.credits,
      imageUrl: key ? withImageExt(`${origin}${PREVIEW_IMAGE_PATH}/${nconst}`) : null,
      origin,
      returnPath: `/person/${nconst}`,
      siteName: deps.siteName,
    }),
    deps.headers,
  );
}

/**
 * One set of headers for both cards.
 *
 * > [!IMPORTANT] The `Vary: Cookie` this policy carries is not optional and it is not tidiness
 * > Both URLs serve TWO different bodies -- the app shell to a session, a card to everybody
 * > else -- and the app shell is deliberately withheld from anonymous visitors. Without
 * > `Vary`, Caddy or CloudFlare may store one and serve it to the other, which hands a
 * > stranger the bundle naming every route finderr has and defeats the whole `login.html`
 * > split. `cache-policy.ts` is why the pair cannot be separated by an edit to this file.
 *
 * Ten minutes at the edge, because the caller worth optimising for is a crawler fanning out
 * over one shared link. Shared by both cards so the person page cannot acquire a different
 * caching rule by omission, which is exactly how the two definitions of the front page
 * drifted apart before `shelves.ts` collapsed them.
 */
function cardResponse(html: string, headers: Record<string, string>): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...cacheHeaders(sharedPerSession(600)),
      ...headers,
    },
  });
}
