/**
 * The Open Graph preview page: what a stranger's chat client is shown for a shared
 * `/title/:tconst` or `/person/:nconst` link.
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
 * describe ONE title or ONE person, and nothing that describes this deployment.
 *
 * Apple names that exact failure in [TN3156], and it is the reason the person half exists
 * rather than being a nicety: *"For pages that require authentication, the main resource
 * should provide metadata for the page to which access is being provided, and not for the
 * authentication page itself. This avoids showing 'Sign In' as the title for every page
 * behind an authentication wall."* Before this, `/person/nm0000138` unfurled as the word
 * `finderr` beside a favicon, which is the sign-in shell's own `<title>`.
 *
 * **What it must never carry**, and the rule is stricter than it looks: no library state,
 * no request state, no `requested_by`, no arr link, no episode state, no facet beyond the
 * synopsis. Everything here is a fact published by IMDb, for an id the reader already had.
 * Nothing here is a fact about this server having it.
 *
 * [TN3156]: https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages
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

/** The `person` row a filmography card is built from -- a subset of `Person`, by design. */
export interface PreviewPerson {
  nconst: string;
  name: string;
  birthYear: number | null;
  deathYear: number | null;
}

export interface PersonPreviewInput {
  person: PreviewPerson;
  /**
   * The titles they are best known for, votes-ordered, already capped by the caller.
   *
   * Plain strings rather than rows: the card prints names and nothing else, and handing
   * this half a `TitleRow` would invite it to draw library state onto an anonymous page.
   */
  knownFor: readonly string[];
  /** Total credits we hold for them, which `knownFor` is the head of. */
  credits: number;
  /** Absolute URL of the headshot, or null to ship no `og:image` at all. */
  imageUrl: string | null;
  origin: string;
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

/**
 * `1937 – 2014`, `b. 1970`, `d. 2014`, or nothing at all.
 *
 * A birth year alone is the common case and the one worth getting right: printing a bare
 * `1970` beside a name reads as a film year on a card whose neighbours are all film years.
 * An unknown birth year with a known death year still says something, so it is not dropped.
 */
export function personLifespan(p: PreviewPerson): string {
  if (p.birthYear && p.deathYear) return `${p.birthYear} – ${p.deathYear}`;
  if (p.birthYear) return `b. ${p.birthYear}`;
  if (p.deathYear) return `d. ${p.deathYear}`;
  return "";
}

/**
 * The muted line under a person's name: lifespan and how much of them we hold.
 *
 * `credits` is OUR count, not IMDb's, and it is smaller on purpose -- the index keeps only
 * titles clearing `castMinVotes`. Printing it is still honest, because the number describes
 * the filmography this link actually leads to.
 */
export function personFactLine(p: PreviewPerson, credits: number): string {
  const parts = [personLifespan(p)].filter(Boolean);
  if (credits > 0) parts.push(credits === 1 ? "1 credit" : `${credits.toLocaleString("en")} credits`);
  return parts.join(" · ");
}

/**
 * `Known for The Dark Knight, Inception and Memento.`
 *
 * Chosen over a role summary (`Acting · Directing`) deliberately: the reader unfurling this
 * link is deciding whether they care, and three titles answer that where a job title does
 * not. It also needs no credit-category vocabulary on the server -- `creditLabel` lives in
 * `web/src/lib/credits.ts` and importing it here would pull a browser module into the
 * server, the mirror of the cross-import `decadeOf` and `personNameKey` already refuse.
 *
 * Falls back to the fact line, so a person with credits we cannot name still unfurls with
 * something rather than with an empty description.
 */
export function personDescription(
  p: PreviewPerson,
  knownFor: readonly string[],
  credits: number,
  limit = 200,
): string {
  const named = knownFor.map((t) => t.trim()).filter(Boolean);
  if (!named.length) return personFactLine(p, credits);

  const head = named.slice(0, -1).join(", ");
  const list = named.length > 1 ? `${head} and ${named[named.length - 1]}` : named[0];
  return truncateWords(`Known for ${list}.`, limit);
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
  const heading = previewTitle(t);

  return renderCard({
    ogType: ogType(t.kind),
    heading,
    displayName: t.title,
    factLine: factLine(t),
    description: previewDescription(t, synopsis),
    // The unfurl always carries a description, because an empty one is a worse card. The
    // VISIBLE body is the synopsis alone -- see `factLine`.
    body: synopsis?.trim() ? truncateWords(synopsis, 400) : "",
    imageUrl,
    imageAlt: `Poster for ${heading}`,
    canonical: `${origin}/title/${t.tconst}`,
    returnPath,
    siteName: input.siteName ?? "finderr",
  });
}

/**
 * The same card for a PERSON, and the only differences are the four values it is given.
 *
 * `og:type` is `profile`, which is Open Graph's own vertical for a human being and what
 * tells a client this is not a film. Everything else -- the escaping, the icon links, the
 * sign-in destination, the image tags -- is `renderCard`'s, because a second copy of that
 * markup is a second place the `apple-touch-icon` would have to be remembered.
 */
export function renderPersonPreviewPage(input: PersonPreviewInput): string {
  const { person: p, knownFor, credits, imageUrl, origin, returnPath } = input;

  return renderCard({
    ogType: "profile",
    heading: p.name,
    displayName: p.name,
    factLine: personFactLine(p, credits),
    description: personDescription(p, knownFor, credits),
    // The fact line already prints the lifespan and the credit count, so repeating the
    // description under it would print the same sentence twice -- the duplication
    // `factLine` was split out to stop on the title card.
    body: "",
    imageUrl,
    imageAlt: `Photograph of ${p.name}`,
    canonical: `${origin}/person/${p.nconst}`,
    returnPath,
    siteName: input.siteName ?? "finderr",
  });
}

/** Everything the one card template needs, with every editorial decision already taken. */
interface PreviewCard {
  ogType: string;
  /** `og:title` and the document title. Carries the year for a film. */
  heading: string;
  /** The `<h1>`, which drops the year the fact line is about to print. */
  displayName: string;
  factLine: string;
  description: string;
  body: string;
  imageUrl: string | null;
  imageAlt: string;
  canonical: string;
  returnPath: string;
  siteName: string;
}

/**
 * The image every card ships, and why both numbers are stated.
 *
 * Slack lays the card out before the bytes arrive, so the aspect ratio has to be declared.
 * `PREVIEW_IMAGE_SIZE` in `src/server/preview-resolver.ts` is the single owner of the width
 * we actually request and these must agree with it; a TMDB `w780` poster and a TMDB `w780`
 * headshot are both 2:3, which is what lets one pair of numbers serve both cards.
 */
const IMAGE_W = 780;
const IMAGE_H = 1170;

/** How large the poster is DRAWN for a human who follows the link, in CSS pixels. */
const DRAWN_W = 171;
const DRAWN_H = 257;

function renderCard(card: PreviewCard): string {
  const { heading, description, imageUrl, canonical, siteName } = card;
  const signInHref = `/?next=${encodeURIComponent(card.returnPath)}`;

  const meta: [string, string][] = [
    ["og:type", card.ogType],
    ["og:site_name", siteName],
    ["og:title", heading],
    ["og:url", canonical],
  ];
  if (description) meta.push(["og:description", description]);
  if (imageUrl) {
    meta.push(["og:image", imageUrl]);
    meta.push(["og:image:width", String(IMAGE_W)]);
    meta.push(["og:image:height", String(IMAGE_H)]);
    meta.push(["og:image:alt", card.imageAlt]);
  }

  const tags = [
    ...meta.map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`),
    // `summary` rather than `summary_large_image`: a poster is portrait, and the large
    // card centre-crops a wide strip out of the middle of it, which on a movie poster is
    // reliably the actor's chin.
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(heading)}">`,
    ...(description ? [`<meta name="twitter:description" content="${escapeHtml(description)}">`] : []),
    ...(imageUrl
      ? [
          `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`,
          `<meta name="twitter:image:alt" content="${escapeHtml(card.imageAlt)}">`,
        ]
      : []),
  ].join("\n    ");

  const poster = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="" width="${DRAWN_W}" height="${DRAWN_H}" class="poster">`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(heading)} — ${escapeHtml(siteName)}</title>
    <link rel="canonical" href="${escapeHtml(canonical)}">
    ${ICON_LINKS}
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
        <h1>${escapeHtml(card.displayName)}</h1>
        <p class="meta">${escapeHtml(card.factLine)}</p>
${card.body ? `        <p>${escapeHtml(card.body)}</p>\n` : ""}        <a href="${escapeHtml(signInHref)}">Sign in to ${escapeHtml(siteName)}</a>
      </div>
    </main>
  </body>
</html>
`;
}

/**
 * The icon a chat client falls back to when it will not use `og:image`.
 *
 * > [!IMPORTANT] This is not decoration, and its absence is what produced the bare card
 * > Apple's [TN3156] says the preview *"will use an `apple-touch-icon`, a favicon, or an
 * > icon specified by `<link rel="...">`"* alongside the image, and *"if you do not have a
 * > preview image of sufficient size or quality, use an `apple-touch-icon` instead."* This
 * > page shipped none of the three, so a client that rejected the poster had nothing left
 * > to draw and fell back to the domain's own card.
 *
 * The paths are the ones `bun run icons:build` writes into `web/public/`, and they are
 * ROOT-RELATIVE so the same string is correct on every origin this ever runs on. That is
 * also why they are not `origin`-prefixed like `og:image` is: an `og:` tag is read by a
 * third party that has no base URL, a `<link>` is resolved by whoever fetched the page.
 *
 * [TN3156]: https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages
 */
const ICON_LINKS = [
  `<link rel="icon" href="/favicon.ico" sizes="48x48">`,
  `<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">`,
  `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
].join("\n    ");
