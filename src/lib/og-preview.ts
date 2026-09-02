/**
 * The Open Graph preview page: what a stranger's chat client is shown for a shared
 * `/title/:tconst` link.
 *
 * > [!IMPORTANT] This module is PURE and takes no config object, no store and no fetch
 * > Everything it needs arrives as arguments, so the whole page -- escaping, tag order,
 * > the description fallback, the sign-in destination -- is testable without a server, a
 * > database or a network. The server half decides what it is ALLOWED to look up; this
 * > half decides what the answer looks like.
 *
 * **Why a second HTML surface exists at all.** An anonymous visitor is normally served
 * `login.html` and never the app shell, deliberately (`src/server/index.ts`). A crawler
 * unfurling a shared link gets that same bare sign-in page, so every finderr link posted
 * anywhere renders as an unlabelled box. This page is the narrow exception: enough to
 * describe ONE title, and nothing that describes this deployment.
 *
 * **What it must never carry**, and the rule is stricter than it looks: no library state,
 * no request state, no `requested_by`, no arr link, no episode state, no facet beyond the
 * synopsis. Everything here is a fact about the FILM, published by IMDb, for an id the
 * reader already had. Nothing here is a fact about this server having it.
 */

/** The local index row this page is built from -- a subset of `TitleRow`, by design. */
export interface PreviewTitle {
  tconst: string;
  title: string;
  year: number | null;
  kind: string;
  genres: string;
  rating: number;
  votes: number;
}

export interface PreviewInput {
  title: PreviewTitle;
  /** The `synopsis` facet if one is already cached. Never fetched for this page. */
  synopsis: string | null;
  /** Absolute URL of the poster, or null to ship no `og:image` at all. */
  imageUrl: string | null;
  /** This deployment's public origin, from `publicOrigin()`. */
  origin: string;
  /** What the sign-in button should return the reader to. Already validated. */
  returnPath: string;
  siteName?: string;
}

/**
 * HTML-escape for both text nodes and double-quoted attribute values.
 *
 * The synopsis is PLUGIN-FED -- it arrives from `api.radarr.video` or TMDB through a
 * provider and is stored verbatim -- and this is the one page in the product with no login
 * in front of it. A bare `"` closes a `content="..."` attribute; `<` opens a tag. The CSP
 * (`script-src 'self'`) means an injected `<script>` would not execute, but defence in
 * depth is not a reason to emit broken markup, and the CSP is one header edit away from
 * being relaxed by somebody who does not know this page depends on it.
 *
 * `'` and `` ` `` are escaped too, so this stays correct if a value ever moves into a
 * single-quoted attribute.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/** IMDb's `titleType` mapped onto the two Open Graph types that exist for this. */
export function ogType(kind: string): string {
  return kind === "tvSeries" || kind === "tvMiniSeries" || kind === "tvEpisode"
    ? "video.tv_show"
    : "video.movie";
}

/** `Batman (1989)`, or just the title when the index has no year. */
export function previewTitle(t: PreviewTitle): string {
  return t.year ? `${t.title} (${t.year})` : t.title;
}

/**
 * The description, preferring the real synopsis and falling back to what the index knows.
 *
 * The fallback is not a placeholder -- `Comedy, Drama · 1989 · ★7.7` is a genuinely useful
 * unfurl and it is available for every one of the 1.27M indexed titles with no network
 * call at all. A title whose synopsis has never been fetched is the COMMON case for a cold
 * share, so this path runs more often than the synopsis one.
 *
 * Truncated on a word boundary: Slack and Twitter cut at roughly 200 and 200 characters
 * respectively, and a description cut mid-word by somebody else looks like a bug in us.
 */
export function previewDescription(t: PreviewTitle, synopsis: string | null, limit = 200): string {
  const text = synopsis?.trim();
  if (text) return truncateWords(text, limit);

  const parts: string[] = [];
  const genres = t.genres
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  if (genres.length) parts.push(genres.slice(0, 3).join(", "));
  if (t.year) parts.push(String(t.year));
  // A rating with no votes behind it is noise rather than information.
  if (t.rating > 0 && t.votes > 0) parts.push(`★${t.rating.toFixed(1)}`);
  return parts.join(" · ");
}

/**
 * The muted line under the heading: year, genre, rating.
 *
 * Shares `previewDescription`'s fallback exactly, which is what lets the card render the
 * synopsis and only the synopsis in its body. Drawing both unconditionally printed the same
 * three facts twice for any title whose synopsis has not been fetched -- the COMMON case for
 * a cold share, and the one where the page looks most like it is broken.
 */
export function factLine(t: PreviewTitle): string {
  return previewDescription(t, null);
}

function truncateWords(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The whole page, as one string.
 *
 * Self-contained on purpose: no stylesheet link, no script tag, no reference to a hashed
 * asset. A crawler never runs any of it, and a HUMAN who follows the link sees something
 * legible in the same request rather than a flash of nothing. It also means this page
 * cannot go stale against a rebuilt web bundle, and it names no route the app has.
 *
 * The sign-in link carries the destination, which is the entire point of the exercise: a
 * shared link that lands somebody on the front page after they authenticate has thrown
 * away the thing that was shared.
 */
export function renderPreviewPage(input: PreviewInput): string {
  const { title: t, synopsis, imageUrl, origin, returnPath } = input;
  const siteName = input.siteName ?? "finderr";

  const heading = previewTitle(t);
  const description = previewDescription(t, synopsis);
  // The unfurl always carries a description, because an empty one is a worse card. The
  // VISIBLE body is the synopsis alone -- see `factLine`.
  const body = synopsis?.trim() ? truncateWords(synopsis, 400) : "";
  const canonical = `${origin}/title/${t.tconst}`;
  const signInHref = `/?next=${encodeURIComponent(returnPath)}`;

  const meta: [string, string][] = [
    ["og:type", ogType(t.kind)],
    ["og:site_name", siteName],
    ["og:title", heading],
    ["og:url", canonical],
  ];
  if (description) meta.push(["og:description", description]);
  if (imageUrl) {
    meta.push(["og:image", imageUrl]);
    // Slack lays the card out before the bytes arrive, so the aspect ratio is worth
    // stating. Every poster this proxy serves is a TMDB w342, which is 342x513.
    meta.push(["og:image:width", "342"]);
    meta.push(["og:image:height", "513"]);
    meta.push(["og:image:alt", `Poster for ${heading}`]);
  }

  const tags = [
    ...meta.map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`),
    // `summary` rather than `summary_large_image`: a poster is portrait, and the large
    // card centre-crops a wide strip out of the middle of it, which on a movie poster is
    // reliably the actor's chin.
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(heading)}">`,
    ...(description ? [`<meta name="twitter:description" content="${escapeHtml(description)}">`] : []),
    ...(imageUrl ? [`<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`] : []),
  ].join("\n    ");

  const poster = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="" width="171" height="257" class="poster">`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(heading)} — ${escapeHtml(siteName)}</title>
    <link rel="canonical" href="${escapeHtml(canonical)}">
    ${tags}
    <style>
      :root { color-scheme: dark }
      body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
             background:#0b0b0d; color:#e8e8ea; font:16px/1.5 ui-sans-serif,system-ui,sans-serif; padding:2rem }
      .card { display:flex; gap:1.5rem; max-width:36rem; align-items:flex-start }
      .poster { border-radius:.5rem; flex:none; background:#17171a }
      h1 { font-size:1.35rem; margin:0 0 .25rem; letter-spacing:-.01em }
      .meta { color:#9a9aa2; font-size:.875rem; margin:0 0 .75rem }
      p { margin:0 0 1.25rem }
      a { display:inline-block; background:#e8e8ea; color:#0b0b0d; text-decoration:none;
          padding:.5rem .9rem; border-radius:.375rem; font-weight:600; font-size:.875rem }
      @media (max-width:32rem) { .card { flex-direction:column } }
    </style>
  </head>
  <body>
    <main class="card">
      ${poster}
      <div>
        <h1>${escapeHtml(t.title)}</h1>
        <p class="meta">${escapeHtml(factLine(t))}</p>
${body ? `        <p>${escapeHtml(body)}</p>\n` : ""}        <a href="${escapeHtml(signInHref)}">Sign in to ${escapeHtml(siteName)}</a>
      </div>
    </main>
  </body>
</html>
`;
}
