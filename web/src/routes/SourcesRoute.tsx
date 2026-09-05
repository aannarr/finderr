/**
 * `/sources` -- who the facts belong to.
 *
 * > [!IMPORTANT] `ATTRIBUTION.md` at the repo root is the SINGLE OWNER of this text
 * > It is imported with Vite's `?raw`, so the document a reader sees here and the document
 * > a reader sees on GitHub are the same bytes. A second copy of a credits list is how one
 * > of them ends up naming a source we stopped using -- and this is the one page in the
 * > product where being out of date is a licence problem rather than a stale sentence.
 * > `attribution.test.ts` pins that every source in the tree is named in that file.
 *
 * THE WHOLE ROUTE IS LAZY, and it is the only one that is. The text is a few kilobytes
 * nobody reads on the way to a film, so it rides in its own chunk and costs the search page
 * nothing -- `?raw` puts the markdown INSIDE that chunk, which is why there is no endpoint
 * here, no fetch, no loading state and nothing for the Dockerfile to remember to copy.
 *
 * Rendered through the app's own `Markdown`, which builds React elements and never HTML, so
 * this page needs no sanitiser of its own. Two consequences for anybody editing the
 * document: there is no table block, so use headings and lists, and there are no autolinks,
 * so an address needs `[label](url)`.
 */

import attribution from "../../../ATTRIBUTION.md?raw";
import { Markdown } from "../components/Markdown";

/**
 * TMDB's own mark, from the logo set the importer already pulls, served from our origin.
 *
 * Drawn rather than described because TMDB asks for the logo alongside the notice, and it
 * is deliberately small: their guidance is that it stays less prominent than our own
 * branding. Every other source is credited in the prose -- this one has a stated shape.
 */
function TmdbMark() {
  return (
    <a
      href="https://www.themoviedb.org"
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 text-xs text-muted hover:text-ink"
    >
      <img src="/logos/rating/tmdb.png" alt="The Movie Database" className="h-4 w-auto" />
    </a>
  );
}

export function SourcesRoute() {
  return (
    <div className="max-w-prose">
      <Markdown text={attribution} />
      <div className="mt-8 border-t border-line pt-4">
        <TmdbMark />
      </div>
    </div>
  );
}
