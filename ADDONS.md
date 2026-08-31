# Writing a finderr addon

An addon is a file that exports `meta` and `init`. It teaches finderr a fact it did not
know how to fetch, and finderr renders that fact without ever waiting on it.

There are **two ways to install one** and **one thing an addon can currently do**. This
document is honest about both, including the second half of that sentence -- see
[What an addon cannot do yet](#what-an-addon-cannot-do-yet), because the gap between what
is designed and what is built is wide and the design docs read as if it were not.

> [!NOTE] "Addon" and "plugin" are the same thing
> The code says `plugin` throughout (`src/plugins/`, `loadPlugins`, `PluginRegistry`) and
> nothing is being renamed for a document. Read them as synonyms.

The machine-readable contract lives at [`src/plugins/README.md`](src/plugins/README.md)
and is deliberately terse. This is the long version.

---

## Hello world

Twenty lines, no dependencies, no API key. It gives every film a made-up critics score so
you can watch the pipeline work end to end.

```ts
// src/plugins/hello-world.ts
export const meta = {
  id: "hello-world",                  // kebab-case; namespaces this addon's data forever
  entities: ["movie"],                // "movie" | "series" | "episode"
  hosts: [],                          // no network, so nothing to declare
};

export function init(c) {
  return {
    facets: {                         // the keys ARE what this addon provides
      ratings: async (entity) => {
        c.log(`asked about ${entity.title} (${entity.year})`);
        return {
          data: [{ source: "HelloWorld", kind: "critics", value: 73, outOf: 100 }],
          freshness: "settled",       // a CLASS, never a duration -- see below
        };
      },
    },
  };
}
```

`init` runs once at load and **returns** the addon's extension points. It is a factory, the
same shape a Rollup or Docusaurus plugin uses: whatever it closes over is that addon's
private state, and `c` never has to be passed to a handler because it is already in scope.

Drop it in `src/plugins/`, restart, open any film. A ratings tile appears with the text
`HelloWorld` on it (no logo is mapped for that source, so the label is the fallback).
Delete the file, restart, and it is gone -- including from the cache, without a migration.

To see it having actually fetched something, swap the body for a real call:

```ts
export const meta = {
  id: "hello-world",
  entities: ["movie"],
  hosts: ["api.radarr.video"],        // the ONLY host this addon may reach
};

export function init(c) {
  return {
    facets: {
      ratings: async (entity) => {
        const res = await c.fetch(`https://api.radarr.video/v1/movie/imdb/${entity.tconst}`);
        if (!res.ok) return null;                     // "nothing here" -- cached as empty
        const [movie] = await res.json();             // the endpoint answers with an ARRAY
        const imdb = movie?.MovieRatings?.Imdb;       // {Count, Value, Type}
        if (typeof imdb?.Value !== "number") return null;
        return {
          data: [{ source: "Imdb", kind: "user", value: imdb.Value, outOf: 10, count: imdb.Count }],
          freshness: "moving",
        };
      },
    },
  };
}
```

`c.fetch` is the only way out. Point it anywhere not in `meta.hosts` and it throws before
a packet leaves, which the resolver records as this addon contributing nothing.

On a stock install this second one draws no new tile, and that is the merge rule working:
`servarr-metadata` already emits `Imdb` off the same document, contributions dedupe on
`source|kind`, and the richer of the two wins. It is here to show the call, not to add a
fact. Point it at a source nobody else carries and the tile appears.

---

## Installing an addon

### As a file

Any `.ts`, `.js` or `.mjs` at the top level of the plugins directory is loaded at boot.
`*.test.ts` and `*.d.ts` are not. An addon that wants more than one file puts the rest in
a **subdirectory named after it** -- `my-addon.ts` beside `my-addon/` -- which the loader
never load-attempts, because `Bun.Glob`'s `*` does not cross a `/`.

```yaml
# /config/config.yml -- or FINDERR_PLUGINS_DIR
pluginsDir: /data/addons        # empty = the built-in src/plugins that ships with source
```

Mounting a directory is how a container gets an addon without a rebuild.

### As an installed module

For code that is versioned and published rather than pasted into a directory:

```bash
bun add finderr-addon-letterboxd
```

```yaml
pluginModules:
  - finderr-addon-letterboxd
  - "@someone/finderr-tvmaze"
  - ./local-work/my-addon.ts      # relative and absolute paths work too
```

```bash
FINDERR_PLUGIN_MODULES=finderr-addon-letterboxd,@someone/finderr-tvmaze
```

Specifiers are resolved with the runtime's own resolver from the **app root** -- `/app` in
the container -- so a bare name finds what `bun install` wrote. A specifier that resolves
to nothing is logged loudly at boot and skipped; it never stops the server, and it never
stops the other addons loading.

Both paths run through the same loader, the same validation and the same guardrails. A
published package gets no capability a local file lacks.

### Which wins

The directory is walked first, then the modules, and **first registration wins the id**.
So cloning a published addon into your plugins directory and editing it is a working
override, and the ignored one says so in the log:

```
plugin finderr-addon-letterboxd ignored: id 'letterboxd' is already registered by /data/addons/letterboxd.ts
```

> [!CAUTION] Naming a package in `pluginModules` runs its code with the server's privileges
> `meta.hosts` gates `c.fetch`. It does not gate the module: an addon can `import("node:fs")`
> at load time like any other dependency, read `/data`, and reach the network through the
> global `fetch` it was never supposed to use. There is no sandbox, and a `postinstall`
> script has already run before finderr is involved at all.
>
> Treat this list as exactly as sensitive as `package.json`, because it is the same trust
> decision. finderr holds Radarr and Sonarr API keys in ENV -- keys that grant full control
> of the arr stack -- so a hostile addon is a total compromise of the media stack, not a bad
> ratings tile. **Read the source of anything you install, pin the version, and never accept
> an addon suggestion from a stranger on the internet.**
>
> This is also why nothing here is a "marketplace" and why finderr must not grow a UI that
> installs addons: the moment an addon can be added by clicking, the trust decision moves
> from a person reading code to a person reading a description.

---

## The context object

`init(c)` receives the context **once**, and every handler closes over it. There is one
context type, not a wider one for `init` and a narrower one for handlers -- nothing
registers by side effect, so there is no capability to withhold.

| | What it is |
|---|---|
| `c.fetch(url, init?)` | The only way to the network. Refuses undeclared hosts and plain http, sets an honest `User-Agent`, applies a 15 s timeout, and paces calls per host across every addon. |
| `c.kv` | Permanent per-addon key/value storage, namespaced `plugin:<id>:<key>` so two addons cannot collide. |
| `c.log(msg)` | Prefixed with the addon id, straight to the server log. |
| `c.pluginId` | Your own id, for when a message needs it. |

**`c.kv` is for the expensive half of a lookup, not for data.** A resolved Rotten Tomatoes
`emsId`, a `tconst -> tvdbId` crosswalk: identifiers that never change and must survive a
facet expiring, so a refresh re-fetches against a known id instead of re-running a fuzzy
match. Facet values belong in the facet cache, which core manages for you.

---

## What an addon can do today

Exactly one thing: **provide a facet**, under the `facets` key of what `init` returns. A
facet is a fact type core declares, with a shape core owns, and there are sixteen of them
(fifteen providable plus one core-only).

Typing `facets: { ` in an editor lists all fifteen, and each key infers its own return
type -- `ratings` wants a `Rating[]`, `seasons` wants a `Season[]`. That discoverability is
the reason the surface is shaped this way.

| Facet | Entities | Merge | An addon could supply it from |
|---|---|---|---|
| `synopsis` | movie, series, episode | single | a translated plot summary, a spoiler-free blurb |
| `ratings` | movie, series | list | Letterboxd, MyAnimeList, Douban, IMDb, Trakt |
| `cast` | movie, series | list | any credits source, with headshots |
| `crew` | movie, series | list | directors, writers, composers |
| `certification` | movie, series | list | BBFC, FSK, Kijkwijzer, MPAA |
| `trailer` | movie, series | list | TMDB videos, Vimeo, a local file |
| `releaseDates` | movie | single | cinema / physical / digital, per country |
| `seasons` | series | list | named seasons with art |
| `episodes` | series | list | air dates, titles, stills |
| `collection` | movie | single | franchise membership and its members |
| `related` | movie, series | list | **a recommender** -- this is the interesting one |
| `keywords` | movie, series | list | tags, themes, moods |
| `watchProviders` | movie, series | list | JustWatch-shaped streaming availability |
| `externalIds` | movie, series, episode | object | any id space core does not already hold |
| `links` | movie, series, episode | list | an official site, a wiki, a fan page -- see the note below |
| `availability` | movie, series | single | **core-only.** Comes from the local library mirror; an addon could only make it wrong. |

> [!IMPORTANT] `links` is for addresses no id can express -- do NOT send one core can build
> Anything reachable FROM an id is built at render time out of `externalIds`: IMDb, Trakt,
> Letterboxd, TMDB, TheTVDB, TVmaze, MyAnimeList, AniDB and AniList all already render, and
> IMDb, Trakt and Letterboxd are on screen before any addon answers, because our own
> `tconst` **is** an IMDb id. **Contributing one of those is contributing a second copy of a
> fact core already holds, and the copies eventually disagree** -- the row deduplicates on
> the URL, so the usual outcome is that your call bought nothing.
>
> If your source knows an ID, put it in `externalIds` and core builds the link. If it knows
> an ADDRESS and nothing else -- a studio's campaign page, a wiki article -- that is `links`.
> `kind` names what is at the other end and doubles as the label; send a `name` when you have
> a better one ("Warner Bros." beats "Official site").
>
> **A new id space becomes a link with one entry in `LINK_SITES`** (`web/src/lib/facet-panes.ts`)
> and no addon change at all. An id space with no entry there renders nothing rather than a
> guessed URL, which is deliberate: `tvrage` arrives on nearly every series, and the real
> TVRage shut down in 2018.

Concretely, addons that would be worth writing today and are not blocked on anything:

- **A second ratings source.** Letterboxd, Douban, MyAnimeList, Trakt. `ratings` merges as
  a list, so it appears beside the existing tiles rather than replacing them.
- **A better `related`.** "More like this" is a genuinely hard problem with many defensible
  answers, and it is one function behind one facet. A local genre/era heuristic, an
  embedding lookup, or somebody's API -- all swappable without touching a component.
- **Non-English `synopsis` or `certification`.** The vocabulary already carries `language`
  and `country`; nothing in the UI assumes English or the MPAA.
- **TV trailers.** Films get one from Radarr's lookup for free; series resolve `trailer` as
  empty because neither Sonarr nor skyhook carries the field. TMDB's `/tv/{id}/videos` has
  it, and that is an addon, not a core change.
- **A second `watchProviders`.** The `tmdb` addon serves it off JustWatch's catalogue, so
  the pane draws -- but only where TMDB has coverage, and it goes dark without an API key.
  A keyless or regional source merges beside it. (This bullet used to read "nothing provides
  it, and it needs a TMDB key, which is a decision"; the key landed at `9f7eb2f` and the
  addon that spends it landed the same day.)
- **`links`.** An official site arrives from `servarr-metadata` for a film and nothing at all
  for a series. A wiki, a fan page or a soundtrack listing is one small addon.

### The three rules that make it composable

**1. Core owns the shape, you own the source.** Two addons contributing `ratings` merge
into one list because both fit `Rating[]`. Every entry names its own `source`, so a missing
addon leaves a gap rather than a hole.

**2. Return a freshness CLASS, never a duration.** You know what kind of fact you fetched;
only core knows how settled this particular title is.

| Class | Means | Effective TTL |
|---|---|---|
| `immutable` | cannot change | never expires |
| `settled` / `recent` / `fresh` / `moving` | **one band**, picked from the title's age | 90 d / 14 d / 3 d / 12 h |
| `volatile` | churns for reasons unrelated to the title's age | 7 d |

Naming any of the four middle classes says "this fact settles as the title settles", and
core picks the rung: this year is `fresh`, last year is `recent`, older is `settled`, a
future year is `moving`. So the same lookup caches for months on a 2010 film and hours on
one released this week, and neither provider knows which is which. Omitting `freshness`
means `settled`.

**3. Never throw at the host, but do return `null`.** A throw, a hang or a malformed answer
is caught, logged, and leaves the facet resolved without your contribution -- one `failed`
row with a 10-minute TTL, and no effect on anything else. But `null` says "we asked and
there is nothing", which **caches properly**. Use it.

### Things the loader will refuse, loudly and non-fatally

Every one of these is a log line and a skipped addon, never a crash:

| | |
|---|---|
| no `meta` or no `init` export | addon ignored |
| an `id` that is not kebab-case | addon ignored -- the id namespaces your data |
| an id another addon already registered | addon ignored, and the log names the incumbent |
| an `init` that throws | addon ignored, and nothing it returned stands |
| an `init` that returns nothing, or no providers | addon ignored |
| a file that will not even import | addon ignored |
| a module specifier that resolves to nothing | addon ignored |
| a facet key core does not declare | **that key dropped**, its siblings still register |
| `availability` (core-owned) | that key dropped |
| a facet key whose value is not a function | that key dropped |
| an unknown top-level group (`on`, `panes`, ...) | logged and ignored, the rest loads |

The split in that table is the rule: a broken **addon** is skipped whole, a broken **key**
costs only itself. Same principle the resolver applies one level up, where a provider that
throws loses its own contribution and nothing else.

### Two things that bite

**Editing an addon needs a restart.** Modules are cached by path for the life of the
process. Adding and deleting do not need one.

**Your `configVersion` is content-addressed, and it invalidates your own cache.** A
directory addon hashes its entry file plus its sibling directory; an installed module
hashes `name@version` plus its entry file. So correcting a mapping takes effect on the next
view instead of at the end of a 90-day TTL. The gap worth knowing: an unbundled package
edited in place under a version that does not move hashes the same -- bump the version, or
work on it as a directory addon.

---

## Drawing your own pane

A facet is a FACT core has a name for. A pane is for everything else -- something you want
to SAY about a title that no facet describes. Declare it in the `panes` group beside
`facets`:

```ts
export const meta = { id: "budget-note", entities: ["movie"] };

export function init(c) {
  return {
    panes: [
      {
        slot: "title.after-cast",
        id: "note",
        needs: ["keywords"],
        render: (facets) => [
          { type: "text", value: `Tagged: ${facets.keywords.data.join(", ")}` },
          { type: "link", label: "More like this", href: "/browse?genre=Heist" },
        ],
      },
    ],
  };
}
```

That addon provides **no facet at all** and still renders. Drop the file in, restart, and
the block appears under the cast on every film whose `keywords` have resolved. Delete the
file and it is gone, with no core edit and no migration -- the same property the facet path
has.

### `render` runs on the SERVER, and that is why it returns blocks

Your function is called on finderr's server, over the facets it has **already** resolved
from local SQLite, and only the resulting blocks are sent to the browser. It is not called
in the page.

This is deliberate and it is not going to change:

- **A function cannot be serialised.** Shipping your code to the browser would be the only
  alternative, and then your addon is welded to our React version forever and your bug
  takes the whole page down.
- **It must not block the render path.** `render` is synchronous and must stay that way.
  You cannot `await` in it and you cannot fetch from it -- fetching is what `facets` is
  for, and a facet's answer is what `render` reads.

So `render` is a pure function from resolved facets to blocks. Do not put a network call,
a timer, or anything that can throw slowly in it. Something that DOES throw costs you your
own pane and nothing else: it is logged with your plugin id, and the rest of the page draws.

### Slots

| Slot | Where it draws |
|---|---|
| `title.after-synopsis` | under the synopsis |
| `title.after-ratings` | under the ratings row |
| `title.after-cast` | under the cast strip |
| `title.after-seasons` | under the season/episode pane |
| `title.end` | after everything core drew |

They are NAMES, not indexes, so core adding or reordering its own panes cannot move yours.
**An unknown slot is logged once and that pane no-ops** -- the same forward-compatibility
rule an unknown group follows, so an addon written for a finderr with more slots than yours
loses that pane and keeps the rest.

### Blocks

| Block | Shape |
|---|---|
| `text` | `{ type: "text", value: string }` |
| `chips` | `{ type: "chips", items: string[] }` |
| `rows` | `{ type: "rows", rows: { label, value }[] }` |
| `link` | `{ type: "link", label: string, href: string }` |

A malformed block, or one of a type core does not know, is **dropped individually** -- half
a pane beats a broken page. The vocabulary is deliberately small; ask for a block rather
than trying to smuggle layout through `text`.

**`href` must be same-origin.** It has to start with `/`, must not start with `//`, and
must contain no backslash, tab, line feed or carriage return. finderr is internet-facing
while the metadata providers sit on the LAN, so an upstream URL is both unreachable from
outside and a leak of which providers are behind us. An absolute URL, a protocol-relative
one and a `javascript:` one are all refused on the server, so the block simply does not
arrive.

The character rule is not fussiness, and it is the part worth knowing if you build an href
from upstream data. **A browser does not compare strings -- it runs the WHATWG URL parser,
which rewrites your input before it means anything.** `\` folds to `/` for http(s), and
tab/LF/CR are stripped outright. So all four of these look same-origin and are not:

| Your `href` | What the browser resolves |
|---|---|
| `/\evil.com/x` | `https://evil.com` |
| `/<TAB>/evil.com/x` | `https://evil.com` |
| `/<LF>/evil.com/x` | `https://evil.com` |
| `/<CR>/evil.com/x` | `https://evil.com` |

Percent-encoding is safe and is NOT filtered -- `/collection/tmdb%3A2344` is a real path and
stays same-origin, because the parser does not decode before deciding the authority.

If you are interpolating a title, a slug or anything a provider gave you into a path,
encode it (`encodeURIComponent`) rather than trusting it.

**There is no image block.** An image needs the `/img/f/<key>` proxy, and the way to get
one is a facet with a declared image field -- which core already walks and rewrites. An
image block would be a second, unguarded route to the same place.

### `needs`

List the facets your pane reads. Until every one of them is `ready`, your pane is
**absent** -- not a skeleton. Core's panes reserve space because core knows how tall they
will be; yours is an unknown quantity, and a skeleton that never resolves is worse than
nothing appearing. It draws on the next read once the facet lands.

---

## What an addon cannot do yet

**There are two extension groups: `facets` and `panes`.** Everything below is designed in
[`finderr-plugin-system-with-lifecycle-hooks`](.rclaude/project/cards/finderr-plugin-system-with-lifecycle-hooks.md)
and **none of it is built**. `on`, `shelves`, `routes`, `config` and `c.dataDir` do not
exist.

Returning one anyway is safe, and deliberately so: an unknown group is a log line, your
`facets` still register, and the addon still loads. So an addon written against a finderr
that has lifecycle hooks degrades on one that does not, rather than failing to install.
That forward compatibility is the reason the surface returns an object at all.

Named here so nobody documents them into existence, and so an addon author knows what to
ask for:

| Would-be group | Examples | Would enable |
|---|---|---|
| `on` -- request lifecycle | `itemWillQueue`, `itemWasSent`, `itemDidBecomeAvailable`, `itemDidFail` | **notifications** -- Discord, WhatsApp, ntfy, webhooks, all as addons instead of four core features; quotas and profile rules as policy |
| `on` -- search | `searchWillRun`, `searchDidRun`, `resultsWillRender`, `searchDidReturnNothing` | query rewriting, "did you mean", badge injection |
| `on` -- entities | `willBuildPersonDetails`, `willBuildRelated`, `entityWillLink` | person bios, a real recommender, suppressing a link that would dead-end |
| `on` -- signals | `resultWasClicked`, `searchWasAbandoned` | search tuning against real queries rather than invented ones |
| `on` -- system | `periodic`, `indexWasRebuilt`, `libraryDidSync` | anything cron-shaped, cache invalidation |
| `shelves` | a built shelf | an addon putting its own row on the front page |
| `routes`, `config` | a page, a settings screen | addon-authored pages and settings |

Facet names and event names are two vocabularies, which is why they would land in separate
groups rather than one flat object. Astro's `astro:config:setup` prefixes are what merging
them costs.

Two of these are the ones people actually hit first:

**No per-addon configuration.** An addon needing an API key has nowhere to put it. `c.kv`
is storage, not configuration -- there is no way to set a value before first run, no UI, no
ENV convention, and a `type: "secret"` field that is write-only in the API does not exist.
Today's answer is that an addon reads `process.env` itself, which works and is ugly: it
puts the addon's secrets in finderr's own namespace with no validation and no `test`
button. **This is the largest single gap** and it is what blocks every addon that is not
keyless.

**Addon-authored UI is HALF built.** `panes` shipped, so an addon can draw its own block on
the title page (see the section above). `routes` and `config` did not, so an addon still has
no page of its own and no settings screen.

---

## Testing an addon

Fixtures on disk, never the network. `loadPlugins` takes a `fetchImpl`, so a test drives
the real loader and the real resolver against recorded responses:

```ts
const registry = await loadPlugins({
  dir: BUILTIN_PLUGINS_DIR,
  kv: store,
  policy: { minIntervalMsPerHost: 0 },   // do not spend real seconds on pacing
  fetchImpl: async (url) => new Response(await Bun.file(fixtureFor(url)).text()),
});
```

> [!WARNING] Log fetch calls only for YOUR hosts
> Every addon shares the one injected `fetchImpl`. A test that records every URL into an
> array and asserts `toEqual([...its own URLs])` goes red the moment an unrelated addon
> registers. Filter on `new URL(url).hostname` being one of your declared hosts.
> `src/plugins/servarr-metadata.test.ts` is the pattern.

---

## Worked examples in this repo

| | |
|---|---|
| [`src/plugins/servarr-metadata.ts`](src/plugins/servarr-metadata.ts) | Thirteen facets from two keyless Servarr proxies. Read it for the multi-file layout and for how a provider serving many facets from ONE upstream document must **coalesce its own in-flight fetches** -- the resolver starts every provider in one synchronous burst, so thirteen facets means thirteen identical calls otherwise. |
| [`src/plugins/rotten-tomatoes.ts`](src/plugins/rotten-tomatoes.ts) | One facet, and the shorter read. A scored fuzzy matcher tested entirely against fixtures, and an identity parked in `c.kv` permanently so a refresh re-fetches scores against a known id. |

Two properties of the ratings row that catch out a second provider of an existing source:
contributions dedupe on `source|kind` and **the richer one wins** (a `url` beats none, then
a `count` beats none), so match the exact source string another addon already uses --
`servarr-metadata` emits `RottenTomatoes`, `Metacritic`, `Imdb`, `Tmdb`, `Trakt`. And a
tile draws the source's official **mark**, not its name; an unmapped source falls back to
text, which is fine, and adding a mark is one entry in `ratingLogo()` plus a PNG.

---

## Being a good citizen on somebody else's API

`api.radarr.video` and `skyhook.sonarr.tv` are Servarr's own infrastructure, paid for by
them, intended for Radarr and Sonarr clients. RT's Algolia index is a browser-side index we
are uninvited on. finderr uses all three and would lose nearly every facet at once if that
access went away.

So: cache hard, send an honest User-Agent (core does this for you and will not let you
override it), resolve **one click deep only**, and never sweep the index. Core's pacer
floors calls per host and the pre-warm loop pauses between titles -- but those only work
if every outbound call goes through `c.fetch`. A second, unpaced route to a third party is
how a polite addon becomes a rude one, and it is the thing most likely to get us all
blocked.
