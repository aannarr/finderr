# Attribution

finderr holds almost no facts of its own. The corpus, the metadata, the artwork, the awards
and the scores all belong to somebody else, and most of them are handed out for free by
people under no obligation to do so. This file says who they are.

It is the single owner of that list. `/sources` in the running app renders this exact file,
so there is one document rather than a page and a README that disagree.

## Required notices

Three sources ask for specific wording. It is reproduced here verbatim, and the app prints
each one where the data it covers is drawn.

> Information courtesy of IMDb (https://www.imdb.com). Used with permission.

> This product uses the TMDB API but is not endorsed or certified by TMDB.

Watch-provider availability comes from TMDB and originates with **JustWatch**, who ask to be
credited by name. The "Where to watch" row on a title page carries that credit beside the
data itself.

## The corpus

**IMDb non-commercial datasets** -- [https://developer.imdb.com/non-commercial-datasets/](https://developer.imdb.com/non-commercial-datasets/)

Every title finderr knows about, and the vote counts the ranking is built on. Downloaded
nightly from `datasets.imdbws.com` and read entirely into local SQLite; finderr never calls
IMDb at render time and never proxies a request to them. Used under IMDb's non-commercial
terms, which is what finderr is: a private household instance behind an invitation.

## Metadata

**TMDB** -- [https://www.themoviedb.org](https://www.themoviedb.org) -- `api.themoviedb.org`, `image.tmdb.org`

Poster and backdrop artwork, cast headshots, watch providers, and keywords for series.
Images are fetched by our server and re-served from our own origin, never hotlinked to a
reader's browser.

**Servarr project** -- `api.radarr.video`, `skyhook.sonarr.tv`

Cast, crew, seasons, episodes, certifications, keywords, trailers, collections and five
rating sources, keylessly. This is Radarr and Sonarr's own infrastructure, paid for by the
Servarr project and intended for Radarr and Sonarr clients -- finderr is a third party using
it on sufferance. So it caches hard, sends an honest User-Agent, resolves one click deep and
never sweeps the index.

**Rotten Tomatoes** -- [https://www.rottentomatoes.com](https://www.rottentomatoes.com) -- `79frdp12pn-dsn.algolia.net`

The audience score, read from the public browser-side search index that rottentomatoes.com
itself queries. Tomatometer and Audience Score are trademarks of Fandango Media, LLC.

**Plex** -- [https://www.plex.tv](https://www.plex.tv)

Your own server, asked what it holds and where to play it. Nothing about your library leaves
the machine.

## Awards

**oscar_data** by DLu -- [https://github.com/DLu/oscar_data](https://github.com/DLu/oscar_data) -- BSD-2-Clause

Every Academy Award nomination since 1929, with the person and title identifiers that make
each one a link. Each import pins the exact commit it parsed, and the award page prints that
commit.

**Wikidata** -- [https://www.wikidata.org](https://www.wikidata.org) -- CC0-1.0

The Palme d'Or and Primetime Emmy winner lists, by SPARQL query. Wikidata has no commit and
changes while a query is running, so the honest provenance is the question we asked and the
moment we asked it -- both are printed on the award page, query included, so a reader can run
it themselves.

## Artwork and marks

**Kometa** -- [https://github.com/Kometa-Team/Kometa](https://github.com/Kometa-Team/Kometa) -- MIT

The studio, network, streaming-service and rating-source marks, imported once from a pinned
commit and served from our own origin. The MIT licence covers the collection; each individual
mark remains the trademark of the company it depicts and is used here only to identify that
company's own data.

## Software

finderr's third-party dependencies and their licences are declared in `package.json` and
pinned in `bun.lock`. The ones worth naming: **cockatiel** (MIT) for every timeout, bulkhead
and retry policy in the tree, **SimpleWebAuthn** (MIT) for the passkey ceremonies, and
**TanStack Router** (MIT).

## Corrections

If you own one of these sources and something here is wrong, incomplete, or not the credit
you ask for, open an issue -- it will be fixed rather than argued about.
