import { type PreviewTitle, renderPreviewPage } from "../lib/og-preview";
import { cacheHeaders, sharedPerSession } from "./cache-policy";
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
  return new Response(
    renderPreviewPage({
      title: row,
      synopsis: deps.cachedSynopsis(tconst),
      imageUrl: posterUrl ? `${origin}${PREVIEW_IMAGE_PATH}/${tconst}` : null,
      origin,
      returnPath: `/title/${tconst}`,
      siteName: deps.siteName,
    }),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        /*
          The `Vary: Cookie` this policy carries is not optional and it is not tidiness.

          This URL serves TWO different bodies -- the app shell to a session, this page to
          everybody else -- and the app shell is deliberately withheld from anonymous
          visitors. Without `Vary`, Caddy or CloudFlare may store one and serve it to the
          other, which hands a stranger the bundle naming every route finderr has and
          defeats the whole `login.html` split. `cache-policy.ts` is why the pair cannot
          be separated by an edit to this file.

          Ten minutes at the edge, because the caller worth optimising for is a crawler
          fanning out over one shared link.
        */
        ...cacheHeaders(sharedPerSession(600)),
        ...deps.headers,
      },
    },
  );
}
