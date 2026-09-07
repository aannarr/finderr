# finderr

A fast media request UI for the arr stack. Arr.

Type a title badly and finderr still finds it, in a few milliseconds. It tells you if
Radarr or Sonarr already has it and hands it over if not. I wrote it from scratch to
replace [Seerr](https://github.com/seerr-team/seerr/): same idea, one process, a ~150 MB
image, and a search that never waits on the network.

```
budapest hostel  ->  The Grand Budapest Hotel (2014)     typo + word order + missing word
strager thigs    ->  Stranger Things (2016)
interstelar      ->  Interstellar (2014)                 not the 439-vote film also called that
buda pest        ->  Budapest / The Grand Budapest Hotel split word
Nile City        ->  NileCity 105.6 (1995)               a space the title does not have
alien 1992       ->  Alien³ (1992)                       superscript, via NFKD
Låt den rätte    ->  Let the Right One In (2008)         original titles are indexed too
The Matrix 2021  ->  The Matrix Resurrections            the year beats the exact title match
```

All of that is one plain search box. There is no "fuzzy" checkbox.

> [!NOTE]
> This is a v0. My household uses it every day, but the
> [known gaps](#known-gaps-and-non-goals) list is long and I mean every line of it. Read
> it before you throw Seerr out.

## Why

Seerr is slow because every page is a live TMDB round trip. A search, a poster, the cast,
the row of recommendations -- all fetched while you sit there, behind a cache that holds a
thousand entries for five minutes and is gone on the next restart. It mirrors Radarr and
Sonarr into its own database much as finderr does, so "do I have this already?" is not the
slow part; everything you actually came to read is. On a NAS that round trip is the whole
experience, and I got sick of it.

finderr keeps the whole searchable universe local: 1.27 million titles from the IMDb
datasets in one SQLite file, plus a mirror of both arr libraries that refreshes every
minute. Every page comes off disk. finderr only hits the network for things that actually
change, in the background, after the page has painted.

One rule runs the whole codebase: the render path touches nothing but local SQLite and
local disk. A handler that can block on a network call while somebody is waiting is a bug,
and I treat it as one. Metadata comes in from cached addons a moment later and fills in
behind the page.

## Speed

I keep saying finderr is fast, so here is what that means and where the numbers came from.
All of them are measured against the real index. `bun run bench` is in the repo and prints
them for your own hardware.

### Two databases, tuned as opposites

There are two SQLite files here and they have nothing in common but the engine.

`titles.db` is the search index. It gets built to a temp file, gated, and promoted with a
rename, and from that moment nothing writes a row to it ever again. No concurrent writers to
protect, no integrity to preserve at runtime, nothing to recover if it dies. So every setting
that trades durability for speed is free rather than reckless, and I take all of them.

`finderr.db` is the app: users, sessions, requests, the metadata cache, the search log.
Written to constantly. Lose it and you lose your accounts and your request history. It gets
the careful settings.

| | `titles.db` | `finderr.db` |
|---|---|---|
| Written | once per build, then never | constantly, by real concurrent writers |
| `journal_mode` | off during the build, none needed after | `wal` |
| `synchronous` | `off` during the build | `normal` |
| `temp_store` | `memory` for reads, `file` for the build | default |
| `cache_size` | derived from the memory budget | default |
| `mmap_size` | derived: the index's size, capped at the budget | default |
| `query_only` | on | off, obviously |
| Foreign keys | nothing declares one | on |
| If you lose it | rebuild it from IMDb overnight | that was the only copy |

The mistake worth avoiding is treating them as one kind of thing. A read-only file that is
replaced wholesale every night wants pragmas that would be irresponsible on the file holding
somebody's account.

Those two derived rows used to be constants -- 256 MB and 2 GB -- and they were sized against
what the machine had rather than against what the container was allowed. Nothing in SQLite or
Bun reads a cgroup limit, so an instance capped below the size of its own index was quietly
told to map more memory than it had. finderr reads the limit itself now and sizes both to it.

### How little memory can it have?

Less than you would guess. The queries touch about 500 MB of a 1.9 GB index, so **1 GB is
comfortable and 512 MB works**, and neither the disk nor the core count is what decides it.
[TUNING.md](TUNING.md) has the ladder that measured it and the settings for each budget.

### Disk and build time are cheap. Latency is not.

Standing rule since 2026-09-04: precompute it, denormalise it, store the derived column, add
the covering index, widen the row. "That would make the build slower" is not an argument
against a faster page. The build runs unattended at 09:00 UTC while everyone is asleep. The
query runs while somebody is standing there waiting for it.

Three things came out of that.

#### The render path seeks now instead of sorting

Three query plans were collecting every matching row and sorting it in a temp b-tree, so a
page cost whatever the corpus cost rather than what the page cost. p50 against the real
index:

| | Before | After |
|---|---|---|
| `/browse?genre=Drama&sort=rank` | 807.48 ms | 0.11 ms |
| the same at offset 200 | 1,074 ms | 0.24 ms |
| the Top 250 | 82.23 ms | 0.06 ms |
| a ranked list's members | 349.75 ms | 0.11 ms |
| `/browse?decade=2010` | 161.11 ms | 0.92 ms |
| "Best of the 2010s" | 372.53 ms | 1.25 ms |
| the front page's genre aggregate | 23.79 ms | 0.01 ms |

Most of it was index column order. `ix_tg_rank` was `(genre, kind, rank desc)`, which cannot
be read in order by a query that pins no kind, and every computed top list in the product is
exactly that query. Reshaping it to `(genre, rank desc, kind)` costs no extra bytes at all
and made the kind-pinned case faster too. A decade is a range on the leading column, so no
index can order across it: a votes-sorted decade is split into ten single-year seeks and
merged, and a rank-sorted one names its index directly, because the planner keeps choosing
`ix_year` and sorting anyway.

#### Every browse total is counted at build time

Once the rows were a seek, the `COUNT` was the entire remaining cost: 137 ms to count a
genre and decade against 0.32 ms to fetch the rows you asked for. A count has to visit every
matching row, so unlike an ordered read it cannot be turned into a seek, and the only way to
stop paying for it while someone waits is to have paid already. `browse_count` holds one row per (kind, genre, year): 9,102 rows,
0.30 MB, 6.75 s on the build, and every total is now a sum over a few hundred rows at 0.02
to 0.50 ms.

#### The index is read into the page cache at boot, and again after every swap

My NAS is a Celeron with nine SATA disks in RAID5, where every page a query touches and the
cache does not hold is a head seek. Measured against freshly cloned indexes the cache had
never read, every scenario cost 0.6 to 3.5 seconds cold against 0.02 to 49 ms warm. A striped
array is quick at sequential reads and terrible at seeks, so one background sequential read
buys the whole tax back:

```
no prefault    first front page 5,026 ms   second 1,070 ms
prefaulted     first front page 1,125 ms   second 1,088 ms   (the prefault: 3.40 s at 215 MB/s)
```

It runs after a swap as well, which is the half that would have rotted quietly. A promoted
index is a different inode with a cold cache, so a nightly refresh without it hands the whole
penalty straight back at 09:00 while every test covering the boot path stays green.

### The same rule deletes an index that does not pay for itself

`ix_ep_rating` went in on the same "bytes are cheap" reasoning and nobody measured it.
Benchmarked across 30 query/parent pairs on the 7.8M-row episode table, it matched the
parent-only index within noise on every single one. Its one measurable win was filtering a
15,456-episode soap by minimum rating: 0.016 ms with it, 0.662 ms without. That is 445 MB for
0.65 ms on the worst case in the corpus, and on that disk array those bytes are worse than
idle, because the prefault above has to read them at ~300 MB/s before anything else can be
cached. Dropped, with the stage version bumped so an existing index reclaims the space.

### The harness

```bash
bun run bench                # every render-path scenario, 100 runs, p50/p95/p99, cold, and the plan
bun run bench -- --reindex   # rebuild the clone's indexes and precomputes first, then measure again
```

It never restates a query. A scenario is a name, some example arguments and a call into the
real code, and the runner records whatever statements that call actually ran and explains
those. A list of SQL strings with example parameters is a second copy of every query, and the
copy is always the one nobody updates, so you end up benchmarking a query that no longer
exists and reading a green table about it.

Cold is measured against a fresh reflink clone rather than a fresh handle. The OS page cache
outlives the process, so reopening a `Database` measures a warm file through a new connection,
which is how cold numbers end up looking like warm ones. It matters: a deep ranked genre
browse is 5.50 ms warm and 98.3 ms cold, and a container that has just restarted pays the
second one.

The pass/fail gate lives in the test suite instead, and it asserts the query PLAN rather than
a wall clock. A threshold in milliseconds is a fact about the machine that ran it. "The
planner never sorts here" is a fact about the code.

### Memory

The shipped compose caps the container at 1.5 GB and the index build runs inside that.
Serving idles far below it.

The fuzzy tier is 78 MB resident. It replaced a trigram index I had written by hand that got
rebuilt in RAM on every boot: 1.5 GB, nine million live objects, and enough garbage collection
to burn 14% of a core on a container doing nothing at all. `spellfix1` does the same job out
of one table on disk.

The build spills its sorter to disk rather than into RAM. `temp_store = memory` left SQLite
nowhere to put the sorter for a covering index over 7.8M episodes, and the NAS build was
OOM-killed at exactly that step, leaving a 1.42 GB half-built file that was correctly never
promoted. Spilling to spinning disks is slower. A build that dies is slower still.

The front page can be held in memory for about 200 KiB of heap. `FINDERR_KEEP_SHELVES_FRESH=1`
takes `/api/discover` from ~100 ms to ~33 ms by rebuilding each shelf from the timer that owns
its data instead of computing all fifteen per request. It changes *when* rows are computed and
never which ones: what you already own is still applied per request, so a title you just
downloaded leaves the recommendation shelves immediately.

## Screenshots

<!--
  Not in the tree yet. When they land they go in docs/screenshots/:
    docs/screenshots/search.png    -- a misspelt query, the right answer on top
    docs/screenshots/title.png     -- a title page with cast, seasons and the Play button
    docs/screenshots/browse.png    -- the browse grid with year and genre chips
    docs/screenshots/login.png     -- the invite-only sign-in page
-->

_No screenshots yet. The queries above are what it looks like._

## What it does

Search survives typos, swapped words, missing words and pasted release names. Three tiers
escalate on their own: full-text, relaxed full-text, then SQLite's `spellfix1` for edit
distance. One scorer ranks everything every tier found, so the best answer wins no matter
which tier caught it. Details under [How search works](#how-search-works).

It also reads intent out of the query. `stranger things s3` is the series and season 3.
`bridgerton 1080p x265` is Bridgerton. `blade runner 2049` is a title, not a year. What it
pulls out of the text is used to score, never to filter, so a year you misremember
demotes the result instead of returning nothing.

Browse and discovery are local too: chips for genre, decade, year and kind. The front
page is a stack of shelves -- recently added, the finderr Top 250, top films, series worth
starting, airing soon, releasing soon, coming soon, this decade, one row per genre -- and
every one of them is an index query. Every view has a URL. Back steps through your
refinements and any result set is a link you can send someone.

Ranking a "best of" list is a build-time job, not a `ORDER BY rating`. The index build
writes a weighted `rank` column: a Bayesian average that pulls a title's own rating toward
the corpus mean in proportion to how few people voted, so a 10.0 from six voters does not
outrank *The Shawshank Redemption*. `/lists` is the catalogue that falls out of it -- a Top
250, a per-genre and a per-decade list, each of them a plain browse with `sort=rank` behind
it, so adding one costs a row in a table and no new query.

Awards are in the index too. Every Academy Award nomination since 1929 comes from
[oscar_data](https://github.com/DLu/oscar_data); the Palme d'Or and the Primetime Emmy for
Outstanding Drama Series come from [Wikidata](https://www.wikidata.org/), which records the
winners and not the field. `/awards/oscars`, `/awards/palme-dor` and
`/awards/emmy-drama-series` are each a timeline of every edition, each edition is its own
page, and a title or a person that was ever nominated carries its wins on its page. They
are local tables like everything else: imported on a daily timer, read off disk, and they
cost no API call at render.

The title page paints at once and fills in behind itself: synopsis, ratings from IMDb,
TMDB, Metacritic, Trakt and Rotten Tomatoes (critics and audience), a trailer link, cast
with headshots, crew, named seasons with air dates per episode, collection, more like
this, certification, release dates, keywords, Oscar wins and nominations, and a "Where to
watch" row for your own country. Nothing on it waits for a provider.

A series gets its episode scores off the same local index: 7.8 million episodes with IMDb's
rating on each, drawn three ways in one panel. A grid of every season by episode number, so
the good run and the bad season are a shape you see rather than a number you read. The
episode list itself, each row carrying its air date, its score, whether we hold it and a
button to ask for it. And a timeline. Under half of all episodes carry a rating at all,
which is why the column is nullable: a new episode has none for weeks, and writing `0.0`
there would say "rated terribly" where the truth is "nobody has rated it yet".

Person and collection pages come from the local index too. Cast and crew names are links,
a filmography is one click, and the reverse index is built from IMDb's `title.principals`
dump, so it costs no API call at all. Typing a name finds the person as well as the titles:
they come back in their own row above the results, best known first, with the face we
already hold from some title's cast.

Requests return immediately. The POST answers `202`, a background worker adds the title
to Radarr or Sonarr, and a toast tells you how it went. For a series you pick the seasons
before anything is queued. Retry is a button. There are four grains: a whole title, a
season selection, and -- for a series Sonarr already holds, which is the case the first two
refuse -- one episode, or every aired episode of a season you have no file for. That last
one is the gap the season panel has been drawing all along, filled in one button. An admin
can also override the quality profile and root folder for one request without touching the
defaults.

Changing your mind is a button too. Anything on your requests page that has not arrived yet
carries Withdraw: it drops finderr's record of the ask, gives you back the daily quota row it
spent, and tells Radarr or Sonarr to stop monitoring the title so nothing keeps searching for
it. It deletes no movie, no series and no file, ever. A request that has already arrived
offers no Withdraw at all, because at that point the only thing left to undo is the media
itself.

Undoing that is a separate button, and it belongs to an administrator. On `/requests` and on
the request log, an admin looking at something that has arrived gets Remove. It asks the arr
what is actually on disk first and says so -- how many files, how big, what quality, and
whether Plex is still serving it -- and it makes deleting the files a deliberate tick rather
than a side effect: leave it and the title simply stops being in Radarr or Sonarr. The row is
not deleted afterwards, it turns into "Removed", so the log still explains where a film went
and records who took it out. Asking for it again works, and costs a request like any other.
The control appears nowhere else -- not on a title page, not on a card, not in search.

With a Plex token, a title you already own gets a Play button that deep-links into the
Plex app or web player, instead of a line of text saying you have it.

`/requests` is where your own asks live, newest arrivals first, each with the same honest
sentence about why it is slow that the title page gives. Anything that arrived and you have
not seen yet is counted in the header, and the count survives closing the app -- one per
request, so a season pack finishing is one piece of news rather than twenty.

`/watchlist` is the other kind of list, and the difference is who wrote it: every row on
`/lists` is a query anybody gets the same answer to, and this one is the titles you kept. The
bookmark beside Request on any card, and under the request button on any title page, puts one
there. **Saving downloads nothing.** It writes one row, spends none of your daily quota,
starts no search and never speaks to Radarr or Sonarr -- Request is still the only control in
finderr that does, which is exactly why the two sit side by side at different weights. Your
list is private: nobody else sees it, not even an admin, and deleting an account takes its
list with it.

`/log` is the same thing for the whole household: everything the server has ever been asked
for, newest asked first, with the state of each. Everybody can see WHAT was requested and
WHEN -- that is what stops three people asking for the same film and makes "is it coming?"
answerable without finding an admin. **WHO asked is sent only to administrators**, who also
get a chip per person to narrow the log to one of them. The name is stripped on the server
rather than hidden in the page, so an ordinary reader is never sent it at all.

Point Radarr and Sonarr back at finderr and they push those states as they happen instead
of finderr noticing on its next poll -- including the one no poll can see, an import the
arr has given up on. That one reads **"Needs a manual import"** rather than "Processing"
forever. It is optional and the poller stays; see
[Letting the arrs tell you](#letting-the-arrs-tell-you).

It installs. Add it to a home screen and it opens as an app: its own window, the content
inside the notch and above the home indicator, a service worker that keeps posters and
bundles on the device and shows an offline page instead of a browser error, and the front
page you left restored before the first paint. HTML is never cached, so a release lands the
moment the network is up. **Notifications** are opt-in per device, on the account page: when
something you asked for arrives, finderr tells you without being open. On iPhone and iPad
that needs the installed app over HTTPS -- Safari does not offer push to a tab, and the app
says so rather than showing a button that cannot work.

Sign-in is invite-only, with passkeys or a Plex account. No sign-up page, no password
table. One deployment-wide exception, off unless you turn it on: point finderr at your Plex
server and [everyone it is shared with](#letting-everyone-your-plex-server-is-shared-with-in)
can sign in without an invitation. On a server with no accounts the first visitor creates the admin — a window that
shuts permanently once anybody has, and never reopens — and the first boot also prints an
invite link, which keeps working afterwards. Admins mint invites, manage users and roles,
and can reset anyone's access. Everybody gets an account page to
name their passkeys, add another one, and connect or disconnect their Plex login. An
anonymous visitor gets a bare login page and nothing else.

Metadata comes from addons, not from core. Three ship in the box: the Servarr metadata
proxies (keyless), Rotten Tomatoes' public index (the audience score, keyless), and TMDB
(needs a key; buys streaming availability and series keywords). Writing your own is one
file with two exports. See [ADDONS.md](ADDONS.md).

There is an assistant, in beta, for every signed-in account on a deployment that
configures an OpenRouter key. It exists for one shape of question that a search box
genuinely cannot take: the ones that are a join across cast, credits and episodes rather
than a title you already know the name of. [Why there is one at
all](#the-assistant-and-why-there-is-one-at-all).

It is a small thing to run and a greedy one to store. One process, one SQLite index, one
app database, a ~150 MB image, no Postgres and no Redis, and it runs without a TMDB key.
Then it takes several gigabytes of disk and I would take more if it bought another
millisecond. [Speed](#speed) is that argument in full.

## Install

### What you need

- Docker, amd64 or arm64. The image is built for both and needs no AVX, so an old
  Celeron NAS is fine.
- A running Radarr and Sonarr and their API keys (Settings -> General in each).
- RAM: the shipped compose caps the container at 1.5 GB and the index build runs inside
  that. Serving idles far lower.
- Disk: give it 10 GB. The index is around 2 GB and the previous generation is kept beside
  it, the IMDb dumps are another 1.3 GB, and the poster cache ceiling is 2 GB by default.
  It is a lot, and it is deliberate: see [Speed](#speed) for what those bytes buy. One heads
  up: if that volume has a filesystem quota, check it first. A full quota on a shared NAS
  volume takes down whatever else lives there.
- Optional: a TMDB API key for streaming availability and series keywords, and a Plex
  token for the Play button.

### 1. Docker Compose from the published image

The image is `ghcr.io/aannarr/finderr:latest`, multi-arch, built and published by CI on
every push to `main`.

```yaml
# docker-compose.yml
services:
  finderr:
    image: ghcr.io/aannarr/finderr:latest
    container_name: finderr
    restart: unless-stopped
    ports:
      - "7979:7979"
    volumes:
      - ./data:/data          # index, poster cache, app db, dumps. Persist this.
    environment:
      FINDERR_RADARR_URL: http://radarr:7878
      FINDERR_RADARR_API_KEY: ${RADARR_API_KEY:?set it in .env}
      FINDERR_RADARR_ROOT_FOLDER: /media/movies        # as Radarr sees it
      FINDERR_RADARR_QUALITY_PROFILE_ID: "4"           # 4 = HD-1080p on a stock install
      FINDERR_SONARR_URL: http://sonarr:8989
      FINDERR_SONARR_API_KEY: ${SONARR_API_KEY:?set it in .env}
      FINDERR_SONARR_ROOT_FOLDER: /media/tv
      FINDERR_SONARR_QUALITY_PROFILE_ID: "4"
      # optional
      FINDERR_TMDB_API_KEY: ${TMDB_API_KEY:-}
      FINDERR_PLEX_URL: http://plex:32400
      FINDERR_PLEX_TOKEN: ${PLEX_TOKEN:-}
      # identity -- read the note below before setting these
      FINDERR_AUTH_RP_ID: finderr.example.com
      FINDERR_AUTH_ORIGINS: https://finderr.example.com,http://192.168.1.10:7979
    # hardening the shipped compose file uses; all optional
    read_only: true
    tmpfs: [ "/tmp:size=64m,mode=1777" ]
    security_opt: [ "no-new-privileges:true" ]
    cap_drop: [ ALL ]
    user: "1001:1001"
    mem_limit: 1500m
```

```bash
docker compose up -d
docker compose logs finderr | grep invite                     # the backup admin link
```

That is the whole install. There is no separate first-build step: with no index at
`/data/titles.db`, finderr comes up anyway, serves a page telling you what it is doing, and
builds one in the background. Open `http://<host>:7979` and watch it — the page reloads
itself when the index lands. Every route that needs an index answers `503` until then, and
`/api/health` stays green throughout, so the container does not fail its own healthcheck
while doing what you asked.

The build downloads the IMDb dumps (a few hundred MB), builds the index, runs a canary
suite of real queries against it, and only then swaps it live. A few minutes on a
desktop-class CPU and appreciably longer on a low-power NAS; the figures are measured and
re-measured in the module docstring of `src/lib/index-builder.ts`, which is the only place
in the repo they are written down, because a build time restated in six files goes stale in
five of them. After the first one it refreshes itself daily and swaps in place. No restart.

> [!NOTE]
> Set `FINDERR_INDEX_REFRESH_ON_BOOT=false` if you would rather build the index yourself.
> finderr then exits when there is no index, and you build one with
> `docker compose run --rm finderr bun src/jobs/build-index.ts`. It has to be `run --rm`
> and not `exec`: with `restart` set, a container that exits for want of an index is
> restarting, and `exec` fails with *"Container is restarting"* forever — the thing that
> would stop the restarting is the command you are trying to run. Once an index exists,
> `exec` works for everything else.

Open `http://<host>:7979` and create your account.

#### Creating your first admin

Two doors, and both are open on a first boot.

**Just open the app.** While no account exists at all, finderr offers to create one instead
of asking for an invitation, and that account is the admin. This is how Jellyfin, Sonarr and
Radarr do it, and it means the install needs no shell.

It is a window, so understand what it is: until somebody takes it, whoever reaches the port
first becomes the admin of a process holding your Radarr, Sonarr and Plex credentials. Take
it as soon as the app is up, or do not publish the port until you have. The window **closes
for good the moment an account exists** and does not reopen — not on restart, and not if you
later delete every user. From then on it is invitations only.

**Or follow the link from the log.** The first boot also mints an admin invitation and
prints it, once:

```bash
docker compose logs finderr | grep invite
```

Open that link and create your account. The token is never stored — only a hash of it —
so it cannot be listed again afterwards. This door does not close, which is what makes it
the recovery path: it works long after the first-visitor window has shut. If the line has
scrolled away or the invite has expired, mint another with the system API key rather than
hunting for it:

```bash
curl -s -X POST http://<host>:7979/api/admin/invites \
  -H "Authorization: Bearer $FINDERR_ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -d '{"role":"admin"}' | jq -r .url
```

That endpoint is how an admin — or a script — does everything a person can do from
`/admin`. It needs `FINDERR_ADMIN_API_KEY` to be set; without it, the admin API answers
only to an admin's own session, which is a legitimate way to run and simply means you
cannot bootstrap from a shell.

`/api/health` tells you where you stand: `auth.users: 0` means nobody has an account yet,
so both doors above are still open.

#### Letting everyone your Plex server is shared with in

Invitations do not scale to a household that already exists somewhere else. If you share a
Plex server with twenty people, you can let finderr take that as the membership list:

```yaml
environment:
  FINDERR_PLEX_MACHINE_ID: <your server's machineIdentifier>
  FINDERR_PLEX_OPEN_SIGNUP: 1
```

Anybody whose Plex account can see that server then signs in with "Continue with Plex" and
gets an ordinary user account on the spot. No invitation, nothing for you to mint, and
never more than the `user` role — an admin is still something you have to make on purpose.

The machine id is not optional here and finderr refuses to start without it, because a
Plex account on its own proves only that somebody spent a minute making one. It is the
`machineIdentifier` of your server; the quickest way to read it is
`curl -s -H "X-Plex-Token: $PLEX_TOKEN" http://<plex>:32400/identity`. Setting it also
turns on the second gate for everybody else, so an already-invited user who was later
un-shared stops being able to sign in — that is the gate working.

Un-sharing on Plex is how you take access away, and it applies at their next sign-in: the
finderr account outlives the share, so disable the user on `/admin` if you need it gone
now. Re-checking with plex.tv on every page load would put a network call on the render
path, which is a trade this app does not make anywhere.

> [!CAUTION]
> This changes who can reach a process holding your Radarr and Sonarr API keys — from
> people you invited one at a time to everybody on your Plex server, including anybody they
> hand a Plex login to. It is a good trade for a household; read
> [Putting it on the internet](#putting-it-on-the-internet) again before making it on a
> public hostname.

#### Running without any login at all

Some people run one arr stack for one household behind one front door, the way Sonarr and
Radarr allow with their local-access setting. finderr can do the same:

```yaml
environment:
  FINDERR_NO_AUTH: 1
```

Every request is then signed in as an admin account called `the_user`, created on first
boot. No login screen, no invitation, nothing to redeem.

One flag and one constant: there is deliberately no environment variable for the account
name. The account is real rather than a synthetic anonymous caller, so `requested_by`,
the admin request log and every role-gated surface behave exactly as they do with the
login wall up — which is what stops this mode from quietly not exercising what ships.

> [!CAUTION]
> This removes authentication completely. Anyone who can reach the port is an admin — and
> this process holds your Radarr, Sonarr and Plex credentials and can start real
> downloads. Nothing in the code will stop you: there is no forced loopback bind and no
> refusal to start, because whether your network is trustworthy is your call and not
> something a program can know. **Do not combine it with the section below.**

It announces itself in three places so it can never be running by accident: a banner in
the boot log, `auth.noAuth` in `/api/health`, and an orange strip across the top of
every page. That strip is deliberate — a screenshot of a login-less finderr is otherwise
identical to a screenshot of a locked one.

It takes a name rather than a plain on/off switch on purpose. The account is real, so
requests are still attributed to it and the admin screens behave exactly as they do with
a normal sign-in; a nameless anonymous mode would quietly stop exercising half the app.

#### Pick the identity settings before the first passkey exists

`FINDERR_AUTH_RP_ID` is the domain every passkey is bound to and it is permanent. Change
it after the first passkey is registered and every credential on the system stops
verifying, for everyone, with no fix short of re-inviting every user. Set it to the name
finderr will finally live at, even if DNS is not there yet.

Two more things the browser decides for you. A passkey cannot be created over plain http
(`localhost` is the only exemption), so on a LAN address the passkey buttons hide
themselves and "Continue with Plex" is the door that works. And the session cookie's
`Secure` flag is derived from `FINDERR_AUTH_ORIGINS`: it turns on only when every listed
origin is https, because a browser silently drops a `Secure` cookie sent over http and you
would be logged out on the very next request with no error anywhere.

#### Putting it on the internet

I run it on the public internet. Here is what you have to do first, and what is still on
you;

- Put a reverse proxy with TLS in front, and set `FINDERR_AUTH_TRUST_PROXY=true` so the
  rate limiter sees real client addresses instead of the proxy's. That flag is wrong
  silently in both directions, so set it to match what is actually in front.
- Put a CDN or WAF in front of the proxy if you can. The built-in limiter is in memory and
  resets on restart. It slows brute force down; it does not stop it.
- Remember what is in the container: the Radarr and Sonarr API keys, which grant full
  control of both. An RCE here is worse than one in Radarr.

Copy [`docker-compose.override.example.yml`](docker-compose.override.example.yml) to
`docker-compose.override.yml` for a proxy-label example. The real file is gitignored so
your hostnames never end up in the repo.

### 2. From source

```bash
git clone https://github.com/aannarr/finderr.git && cd finderr
bun install
cp .env.example .env               # arr keys, optional TMDB and Plex, auth
bun run logos:import               # studio / network / rating marks, ~12 MB, optional
bun run index:build                # downloads the dumps, builds, gates, promotes
bun run awards:import              # the Oscars, Cannes and the Emmy -- optional, see below
bun run build                      # the web UI
bun start                          # http://localhost:7979
```

`logos:import` pulls the studio, network, streaming and rating marks from a pinned
[Kometa](https://github.com/Kometa-Team/Kometa/) commit into `web/public/logos/`. They
belong to their trademark holders and are not tracked here. Skip the step and every badge
prints its name instead. The Docker build runs it for you.

`awards:import` is optional in the same way `index:build` is: the server imports the rows
itself twelve seconds after a cold boot and re-checks daily, so you only run it by hand to
fill the awards pages before the first check. `--award <id>` does one of them; `--award
oscars --file oscars.tsv` reads the Academy's 2.2 MB file from disk on a machine with no
route to GitHub. Each award is imported and reported separately, so a Wikidata outage
costs the Oscars nothing. A failed import is logged and swallowed -- that award's page
comes up empty and nothing else changes.

`bun run dev` gives you hot reload (API on 7979, Vite on 7980). The repo's own
`docker-compose.yml` builds the image locally and reads the unprefixed names in `.env`;
`docker compose up -d --build` is the whole deploy loop.

> [!WARNING]
> Never point a dev server at a data directory a container is also using. Two writers on
> one SQLite file over a Docker Desktop bind mount corrupts it. I did not reason my way to
> that; I did it. Give the dev server its own `FINDERR_DATA_DIR` and share only the
> read-only `titles.db` (a symlink is fine):
>
> ```bash
> mkdir -p ~/finderr-dev && ln -s "$PWD/data/titles.db" ~/finderr-dev/titles.db
> FINDERR_DATA_DIR=~/finderr-dev FINDERR_PORT=9779 bun start
> ```

On macOS the fuzzy tier needs Homebrew's SQLite, because Apple's build has extension
loading disabled: `brew install sqlite && bun run spellfix:build`. Without it finderr logs
loudly and serves the two full-text tiers only.

### Upgrading

```bash
docker compose pull && docker compose up -d
```

That is the whole thing. There is no migration step to run and no order to get right.

Releases sometimes add a stage to the index: cast and crew were one, and the bulk id
crosswalk was another. finderr records which stages the index it is serving actually
carries, so on boot it can tell that the file predates something this build knows how to
produce. When it finds one missing it rebuilds in the background and swaps the result in
without a restart, and it says so in the log:

```
[finderr] the open index is missing: ids -- rebuilding in the background.
          The current index keeps serving until it is ready.
[finderr] index reloaded in place -- 1,275,695 titles, canary 42/42, 425ms. No restart.
```

Nothing goes down while that happens. The index you already have answers every query
correctly, it just lacks an optimisation, so it keeps serving at full speed for the few
minutes the rebuild takes. There is no maintenance page, because there is nothing to
apologise for. The one place you do see a progress page is a FIRST install, where there is
genuinely nothing to serve yet: the server comes up, explains itself, and refreshes when
the index is ready.

The app database migrates itself on open, and the metadata cache survives an upgrade. A
plugin whose code changed keeps serving its last answer for a title while it fetches a
fresh one, so a release does not empty the cache and go re-fetch it all from other
people's servers.

## Configuration

Environment variables are the primary surface. A YAML file at `/config/config.yml` is
optional and ENV always wins, so a compose file can override a baked-in config without a
rebuild.

| Variable | Default | Notes |
|---|---|---|
| `FINDERR_PORT` | `7979` | |
| `FINDERR_HOST` | `0.0.0.0` | |
| `FINDERR_DATA_DIR` | `/data` | Index, poster cache, app DB, dumps. Persist it |
| `FINDERR_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `FINDERR_RADARR_URL` | | Required. Container name or a LAN address; the repo's compose falls back to `http://radarr:7878` |
| `FINDERR_RADARR_API_KEY` | | Required |
| `FINDERR_RADARR_ROOT_FOLDER` | | As Radarr sees it, not as finderr does. Compose fallback `/media/movies` |
| `FINDERR_RADARR_QUALITY_PROFILE_ID` | `4` if unset | Check yours; 4 is HD-1080p on a stock install |
| `FINDERR_RADARR_PUBLIC_URL` | falls back to the URL above | Where an **admin's browser** reaches Radarr, for the "Open in Radarr" link. Set it when finderr is public and Radarr is on a private address; that link is the only place finderr hands a browser an upstream URL, and it is sent to admins only |
| `FINDERR_SONARR_*` | | The same five keys; compose falls back to `http://sonarr:8989` and `/media/tv` |
| `FINDERR_EPISODE_REFRESH_SECONDS` | `21600` | How stale one series' episode list may get before it is walked again. Sonarr answers per series, so this is a load dial, not a freshness one |
| `FINDERR_EPISODE_REFRESH_BATCH` | `25` | Series walked per library refresh, neediest first. `0` turns the episode mirror off, and with it the per-episode marks and requests |
| `FINDERR_TMDB_API_KEY` | | Optional. **The SEED for one setting, not the setting.** It is the key the `tmdb` addon uses (streaming availability, and a series' keywords, cast, trailer, "more like this" and official site) **and** the one the upcoming and trending sync uses -- one value, one place it is stored. Save a key on **Administration → Addons** and it wins over this variable for both from then on, so rotating it rotates the whole product |
| `FINDERR_TMDB_IMAGE_BASE` | `https://image.tmdb.org/t/p` | Where a TMDB image path becomes a URL, for the poster proxy and for cast headshots. The same shape as the key above: a seed for a setting the admin page can take over. Change it only for a TMDB mirror |
| `FINDERR_PLEX_URL` | | Optional, e.g. `http://plex:32400`. With a token, owned titles get a Play button |
| `FINDERR_PLEX_TOKEN` | | Sent as `X-Plex-Token`, never in a URL. finderr only reads, but the token itself is full account access |
| `FINDERR_PLEX_MACHINE_ID` | | Your Plex server's `machineIdentifier`. Set it and a Plex sign-in additionally requires that the account can see that server — a second gate on top of the invitation, never instead of it. It does not feed the Play links, which read the id from the server itself |
| `FINDERR_PLEX_OPEN_SIGNUP` | `false` | Let anybody your Plex server is shared with sign in with no invitation, as a `user`. Refused at boot without the id above, since without a server to belong to it would admit every Plex account there is. See [Letting everyone your Plex server is shared with in](#letting-everyone-your-plex-server-is-shared-with-in) |
| `FINDERR_AUTH_RP_ID` | `localhost` | The bare domain passkeys are bound to. Permanent, see above |
| `FINDERR_AUTH_RP_NAME` | `finderr` | What the OS prompt shows |
| `FINDERR_AUTH_ORIGINS` | `http://localhost:7979,http://localhost:7980` | Comma-separated. Every origin that may complete a sign-in |
| `FINDERR_AUTH_SESSION_DAYS` | `30` | |
| `FINDERR_AUTH_INVITE_HOURS` | `72` | |
| `FINDERR_AUTH_COOKIE_SECURE` | derived | Empty = on when every origin is https |
| `FINDERR_AUTH_TRUST_PROXY` | `false` | Believe `X-Forwarded-For`. Only behind a proxy you control |
| `FINDERR_AUTH_RATE_PER_MINUTE` | `20` | Per IP, on the sign-in routes |
| `FINDERR_SEARCH_RATE_PER_MINUTE` | `120` | Per IP, on `/api/search` |
| `FINDERR_AGENT_CHEAP_RATE_PER_MINUTE` | `120` | Per **agent key**, on everything a local SQLite seek answers. In addition to the per-IP limits, never instead of them |
| `FINDERR_AGENT_EXPENSIVE_RATE_PER_MINUTE` | `20` | Per **agent key**, on `/api/search`, `GET /api/title/:tconst` and the request POSTs — the operations that cost real CPU, a blocking provider wait, or a download. Also the cap on how many blocking title reads one key can have in flight |
| `FINDERR_REQUEST_QUOTA_PER_DAY` | `0` | **The SEED for the site quota, not the value.** Titles one ordinary user may request per UTC day; `0` is unlimited. An admin sets this on `/admin` and it is then stored, after which this variable stops having any effect -- see [Site defaults](#site-defaults). Until somebody saves one, this is what applies. Counted in **titles**, so a series is one however many seasons are picked, and re-requesting something already queued costs nothing. Admins are exempt, the episode and season grains do not count because they write no `request` row, and a user over the limit gets `429` naming their reset time |
| `FINDERR_SEARCH_LOG` | `true` | Keep what people search for, so the ranking can be tuned against real queries instead of invented ones. A row is **the query, a timestamp and a result count** — no session, no user, no address — and a click report adds which title was opened and at what rank. Set it to `false` and nothing is buffered and nothing is written; the tables stay. Read it with `bun run search:report` |
| `FINDERR_SEARCH_LOG_KEEP_ROWS` | `50000` | Rows kept per table, oldest deleted first. A disk bound rather than a retention policy: there is no identity in this data to expire |
| `FINDERR_PUSH_ENABLED` | `true` | Offer web push notifications when a request arrives. Costs nothing until somebody turns them on: the VAPID key pair is generated on the first ask and stored in the app database. Setting it to `false` stops finderr talking to Google's, Apple's and Mozilla's push services on your users' behalf, and keeps existing subscriptions rather than deleting them |
| `FINDERR_PUSH_CONTACT` | `mailto:finderr@localhost` | The `sub` claim in every VAPID token — how a push service reaches **you** if something goes wrong. The default is well-formed and accepted by every service tested; set a real address if yours refuses it, or so somebody can actually reach you |
| `FINDERR_WEBHOOK_USERNAME` | `finderr` | Basic-auth user Radarr and Sonarr send to `/api/webhook/arr`. See [Letting the arrs tell you](#letting-the-arrs-tell-you) |
| `FINDERR_WEBHOOK_PASSWORD` | | **Empty means the webhook route refuses everybody**, which is the default. It is the one public route that changes state, so this password is the whole of its authentication |
| `FINDERR_WEBHOOK_LAN_ONLY` | `false` | Also refuse a webhook whose source address is not on a private network. Read through `FINDERR_AUTH_TRUST_PROXY`, so with a proxy in front and that off, every caller looks like the proxy and this is worthless |
| `FINDERR_WEBHOOK_RATE_PER_MINUTE` | `300` | Per IP, on the webhook route. Generous because a season pack is a burst |
| `FINDERR_ADMIN_API_KEY` | | Optional. Lets a script administer finderr (`Authorization: Bearer`) and unlocks the full `/api/health` payload. 24 characters minimum |
| `FINDERR_NO_AUTH` | `false` | **Turns authentication off.** Signs every caller in as an admin called `the_user`. Single-user installs only — see [Running without any login at all](#running-without-any-login-at-all) |
| `FINDERR_INDEX_REFRESH_CRON` | `0 9 * * *` | When the daily refresh runs |
| `FINDERR_INDEX_REFRESH_TZ` | `UTC` | IANA zone for the cron. The dumps publish on UTC |
| `FINDERR_INDEX_REFRESH_ON_BOOT` | `true` | Build an index on boot when there is none, instead of exiting. The server listens and serves a progress page while it runs |
| `FINDERR_INDEX_TITLE_TYPES` | `movie,tvSeries,tvMiniSeries,tvMovie` | IMDb title types to ingest |
| `FINDERR_INDEX_INCLUDE_ADULT` | `false` | |
| `FINDERR_INDEX_FUZZY_MIN_VOTES` | `100` | Below this a title is full-text only; above it typos find it too |
| `FINDERR_INDEX_RANK_PRIOR_VOTES` | `25000` | How much evidence a title needs before its own rating outweighs the corpus mean in the `rank` column. Raise it to demand more votes before something can climb a Top 250; lower it to let smaller titles move |
| `FINDERR_INDEX_CAST_MIN_VOTES` | `1000` | Cast and crew are indexed for titles above this. `0` indexes everybody and the build takes tens of minutes |
| `FINDERR_INDEX_CAST_CATEGORIES` | ten IMDb job categories | Which credits earn a row. Empty = no cast tables, no person pages |
| `FINDERR_INDEX_CAST_REFRESH_DAYS` | `7` | How often the 100M-row `title.principals` dump is re-scanned. Other builds carry the cast tables forward in seconds |
| `FINDERR_INDEX_EPISODE_SERIES_MIN_VOTES` | `0` | Votes a series needs before its episodes are indexed. `0` means every episode of every series, which is what makes the episode scores answer for a show nobody has heard of. Raise it to shrink the index and the build, and read the census in `src/lib/config.ts` before you do: at 1,000 it covers 12,797 series out of 240,909 |
| `FINDERR_LIBRARY_REFRESH_SECONDS` | `60` | Arr and Plex mirror interval |
| `FINDERR_KEEP_SHELVES_FRESH` | `false` | Hold the front page in memory instead of computing all fifteen shelves per request, rebuilding each shelf from the timer that owns its data — the arr mirror every 60s, the TMDB mirrors every 6h, the index once a day. `/api/discover` goes from ~100ms to ~33ms for about 200 KiB of heap. It changes *when* rows are computed and never which: what you own is still applied per request, so a title you just downloaded leaves the recommendation shelves immediately. `/api/health` reports `shelves` with a per-tier build time |
| `FINDERR_ARTWORK_CACHE_MAX_BYTES` | `2000000000` | Poster cache ceiling, least-recently-written evicted first |
| `FINDERR_TMDB_CACHE_IMAGES` | `true` | |
| `FINDERR_RESOURCE_LOG_SECONDS` | `300` | One-line RSS/heap/GC summary in the log. `0` disables |
| `FINDERR_OPENROUTER_API_KEY` | | Optional, and the whole on/off switch for [the assistant](#the-assistant-and-why-there-is-one-at-all). No key means the feature does not exist rather than failing |
| `FINDERR_AI_MODELS` | `meta/muse-spark-1.3-contributor` | Comma list, best first, so an admin can benchmark an alternative without a deploy; only the first is used. **This and the cap below are one decision**: the cap has no reservation machinery and is only safe because one conversation costs a fraction of a cent on the default. A frontier model here quietly turns the cap into a suggestion. **The default is a data-sharing tier**: it is roughly 21x cheaper because the provider may train on the prompts and completions it receives, which are your users' questions and public index rows, never a credential. Set `meta/muse-spark-1.3` instead to pay full price and opt out |
| `FINDERR_AI_DAILY_LIMIT_USD` | `1` | Per ordinary user per day, counted from the `ai_call` ledger rather than a running total. The day is the container's local calendar, not UTC, so a household's budget does not reset mid-evening. Admins are exempt from this cap and from nothing else; every call is recorded either way |
| `FINDERR_PLUGINS_DIR` | | Addon directory. Empty = the built-in `src/plugins` |
| `FINDERR_PLUGIN_MODULES` | | Comma-separated installed packages. Runs their code; read [ADDONS.md](ADDONS.md) first |
| `FINDERR_CONFIG_FILE` | `/config/config.yml` | Optional YAML, same keys in camelCase |

`/api/health` answers `{"ok":true}` to anyone, which is all the container probe needs.
With the admin key (or an admin session) it reports index rows and build time, the last
in-place swap and its canary score, library, Plex and upcoming mirror counts, the award
import (row count and the commit it was parsed from), addon coverage of the front page,
per-provider and per-host timings saying where a cold title's second actually went, user
and session counts, and memory. **Most of it is drawn on `/admin`**, so a shell and the
system key are no longer the only way to read it — see [Site defaults](#site-defaults).

### Site defaults

Two things apply to everybody and are set on `/admin` rather than in the environment: the
**daily request quota** and whether a **new account gets the assistant**. Both start from
what the deployment configured, and once an admin saves one, the environment stops deciding
it — a value you can change from a web page cannot also be one a container restart silently
overrules. That is the whole trade, and there is exactly one place in the code that resolves
it (`src/lib/site-settings.ts`), so nothing can disagree about which source wins.

The quota is a *fallback*: a person with no allowance of their own is bound by it, and one
with an allowance set on `/admin/users/:id` is not. Zero means unlimited, wherever it appears,
and administrators are never limited.

The assistant default is *not* a fallback and the difference matters. It decides what the
**next account created** starts at and touches nobody who is already here — an account's
assistant switch is a plain yes or no with no "follow the site" state to fall back into.
Turning it off stops new invitees from getting the assistant; changing somebody who already
has it is done on their own page.

The same screen draws what `/api/health` knows: index rows and build date, the last in-place
swap **with its canary score**, whether the page-cache prefault ran and how much of it the
container's memory cap kept, which arrs are configured, the library and Plex mirror counts,
which addons are loaded and what each is allowed to fetch, and the **twenty slowest requests**
with the arguments that made them slow. Each of those has a reading worth acting on — a
`REFUSED` swap means searches still work and the library is quietly a day old — and the page
says so in words rather than leaving a number to be judged.

### Letting the arrs tell you

finderr reconciles every open request against Radarr's and Sonarr's queues on a
thirty-second timer, and that keeps working whatever you do here. What it cannot see, at
any interval, is an import the arr has given up on: the download finished, the file is on
disk, and nothing will move it until a person opens Radarr and imports it by hand. Seerr
shows that as "Processing" forever. Point the arrs at finderr and it says
**"Needs a manual import"** instead, which is something you can act on.

Set a password, then add the connection in each arr:

1. `WEBHOOK_PASSWORD=` in `.env` (any long random string — `openssl rand -base64 24`).
   Restart finderr.
2. In Radarr: **Settings → Connect → + → Webhook**. In Sonarr: the same path.
3. **URL** `http://finderr:7979/api/webhook/arr` — whatever address the *arr* can reach
   finderr at, which on a shared Docker network is the service name. **Method** POST.
   **Username** `finderr`, **Password** the one you just set.
4. Tick **On Grab**, **On Import**, **On Import Complete** (Sonarr only) and
   **On Manual Interaction Required**. The rest are accepted and ignored, so ticking them
   costs nothing but noise.
5. Press **Test**. finderr logs `arr webhook: test received -- the connection works`, and
   `/api/health` starts counting: `webhook.received` staying at `0` after a real grab means
   the connection was not saved.

Nothing here is required and nothing breaks without it. A webhook that never arrives --
finderr restarting, a network blip, a connection you disabled -- costs you the speed and
the manual-import warning, and the poller finishes the job as it always did.

## How search works

```
IMDb daily dumps ──► index builder ──► titles.db (SQLite + FTS5 + spellfix1)
                          │                    │
                     drift gates          SearchEngine ◄── in-place swap, canary-gated
                          │                    │
                     atomic swap               ▼
                                          Bun.serve ──► REST ──► React (Vite) client
                                               ▲
Radarr / Sonarr / Plex ──► library mirror ─────┘        addons ──► facet cache (SQLite)
       (every 60 s)        (local SQLite)                (background, paced, hard-cached)
```

### The ladder

Three tiers, escalated on their own when a tier returns zero rows, a low score, low token
coverage or a thin margin between the top two. You never ask for fuzzy matching.

| Tier | Mechanism | Typical |
|---|---|---|
| `fts` | FTS5 AND over normalised title + original title + a de-spaced blob | 0-5 ms |
| `or` | Same, OR'd, stopwords dropped, gated on token coverage | 30-70 ms |
| `fuzzy` | SQLite's `spellfix1` (edit distance + phonetics) over a vocabulary stored in the index | ~12 ms |

Candidates pile up across tiers and the one scorer weights votes, year, kind and title
similarity on a single scale. The fuzzy vocabulary only holds titles above
`FUZZY_MIN_VOTES`, which is what stops a typo surfacing some 40-vote short over the film
you meant.

`spellfix1` replaced a hand-rolled trigram index that got rebuilt in RAM on every boot.
That thing cost 1.5 GB and nine million live objects, and kept the garbage collector busy
enough to burn 14% of a core on an idle container. The extension does the same job from
one disk-backed table at 78 MB resident. Measurements are in
[`vendor/sqlite-spellfix/README.md`](vendor/sqlite-spellfix/README.md).

### Query understanding

The raw string is parsed into intent before any search runs. Whatever gets pulled out of
the text becomes scoring, not filtering.

| You type | Parsed as |
|---|---|
| `The Matrix 1999` | text `the matrix`, year 1999 |
| `stranger things s3` | text `stranger things`, kind series, season 3 |
| `bridgerton 1080p x265` | text `bridgerton`, release junk stripped |
| `blade runner 2049` | text unchanged; 2049 is the title |
| `horror 1980s` | text `horror`, decade 1980 |

Franchise ordinals (`Rocky 4`) do not auto-resolve to one film, on purpose. A title-prefix
guess sent `Rocky 4` to *Rocky III* and `Alien 3` to *Alien Nation*, so I ripped it out.
The OR tier returns the whole franchise and you pick.

### Tuning it against real queries

Every constant in the scorer was picked to make the canary suite pass, and that suite was
written by an agent. It is a suite grading its own homework: 100% means the cases agree
with the numbers that were chosen to satisfy them, and says nothing about whether either
matches how anyone searches. So finderr keeps a log of what people actually type.

A search row is **the query, a timestamp and a result count**. A click report adds which
title was opened and at what rank. There is no session id, no user id, no address and no
cookie in either table — a click on rank 4 is a ranking failure whoever made it, and none
of the questions worth asking needs to know who typed something. Writes are buffered in
memory and flushed every 30 seconds, so nothing on the render path waits on SQLite, and a
prefix somebody typed on the way to a longer query is dropped rather than stored as a
search of its own.

```bash
bun run search:report                # replay every logged query against the live index
bun run search:report -- --no-replay # counts only, no index needed
```

The report answers the questions the constants were guesses about: how many queries carry
a year, which tier actually answers them, whether anyone searches in a non-English title,
which queries found nothing — and it lists the real queries whose reader had to look past
the top row. Those are the cases that have earned a place in the canary. Adding one is a
person's decision; inventing more cases is the problem this replaces.

`FINDERR_SEARCH_LOG=false` turns the whole thing off.

### The daily refresh

The refresh rebuilds, it never patches. A full rebuild is cheaper and safer than diffing
1.27M rows. IMDb honours conditional GETs, so a day with no new dump costs one HEAD
request and zero bytes. When there is a new one, four gates stand between it and your
users, and the build targets `titles.new.db` until all of them pass:

| Gate | Catches | On failure |
|---|---|---|
| Header assertion | IMDb reorders or renames a TSV column | Hard fail. Never ingest into shifted columns |
| Volume | truncated download, bad gunzip | Abort if under 95% of the live row count |
| Canary | ranking silently regressing | Abort unless real queries still pass |
| ETag | nothing changed | Skip the whole cycle |

The canary is the one that matters. A dump can be structurally perfect and still wreck
results: a tokenizer change, or IMDb re-scoring its votes. Only running real queries
catches that, and the same suite validates the new file in the running process before the
engine swaps to it. A refused swap shows up in `/api/health` as `index.reload.ok: false`.

You can run it against any index without building one:

```bash
bun run canary                       # the configured index
bun run canary path/to/titles.db     # some other one
```

Five of its cases can only be answered by the fuzzy tier, so on a checkout with no
`spellfix1` they are reported as skipped and named, not counted as ranking failures. The
score stays honest about what it measured, and the output says which capability is missing
and how to get it.

A second check needs the same thing. The language lists on `/lists` follow one mechanical
rule -- a language gets a list when the index holds at least 250 ranked films in it that
are not also in English -- and no unit test can evaluate that, because a unit test has no
corpus. So the array of languages and the corpus drifted apart twice, both times found by
somebody noticing rather than by anything failing:

```bash
bun run lists:audit                       # the index this machine has
bun run lists:audit path/to/titles.db     # some other one
```

It reports both directions: a language over the floor with no list, and a list whose
language has fallen under it. Against an index built before the language crosswalk widened,
the second direction is reported as not measured rather than as a failure -- on such a file
a listed language can fall short for the file's reasons rather than the array's.

`bun run gate` runs the four green commands, then the canary, then this. The last two
tolerate having no index to read, and say so loudly instead of passing quietly.

The build also pulls a fifth file that is not IMDb's: an id crosswalk, `tconst` to TMDB
and TheTVDB id, queried in bulk out of Wikidata through
[QLever](https://qlever.cs.uni-freiburg.de/). It covers 95% of films and 92% of series at
the vote floor, and rather more of the ones anybody looks up. What it buys is a round trip
off every cold title page: `api.themoviedb.org/3/find/tt…` was the single most expensive
call in the whole facet chain and it answers a question a 12 MB download already knows.
The tail it misses is looked up live exactly as before, so partial coverage costs nothing
but the calls it saves. A fresher crosswalk on its own does not trigger a rebuild.

```bash
bun run index:build -- --dry-run     # build and gate, do not promote
bun run index:build -- --no-fetch    # rebuild from dumps already on disk
bun run index:build -- --force       # ignore ETags
```

## How metadata works

Core knows nothing about cast, ratings or seasons. It declares a facet vocabulary -- the
fact types an addon may provide, `synopsis`, `ratings`, `cast`, `seasons`,
`watchProviders` and a dozen more, all listed in [ADDONS.md](ADDONS.md) -- and an addon
fills them in. The resolver caches every contribution
in SQLite with a freshness class that scales with the title's age, so a 2010 film's cast is
fetched once and a series airing this week re-checks its episode list every twelve hours.
A page never waits. It paints from local data and polls until the server says nothing is
still owed.

Three addons ship:

| Addon | Source | Key | Gives |
|---|---|---|---|
| `servarr-metadata` | `api.radarr.video`, `skyhook.sonarr.tv` | none | cast, crew, ratings from five sources, certification, keywords, trailer, collection, related, synopsis, release dates, seasons, episodes |
| `rotten-tomatoes` | RT's public index | none | the audience score, which nothing else carries |
| `tmdb` | `api.themoviedb.org` | yes | streaming availability per country, and for a series: keywords, a cast with person ids on it, the trailer, "more like this" and the official site |

The first two are somebody else's servers being generous: Servarr's own metadata proxies,
paid for by them, meant for Radarr and Sonarr clients. finderr caches hard, honours their
TTLs, sends an honest User-Agent, paces every call per host, and resolves one click deep
only -- on view and on front-page pre-warm, never a sweep. If you fork this, keep the
caching and the pacing. A rude fork gets the whole fleet blocked, and losing that access
would cost nearly every facet at once.

An addon is one file exporting `meta` and `init`. [ADDONS.md](ADDONS.md) is the guide: a
twenty-line hello world, both install paths, every facet you can provide, how to draw your
own pane on the title page, and a straight account of what the extension surface does not
do yet.

## The assistant, and why there is one at all

Everything shipped a chat box this year and most of them are a worse search box with a
spinner in front of it. I did not want one of those. What changed my mind was a question
somebody asked me out loud, and this is it verbatim:

> Who is that actor that's in that show Furious and that show that the actor from The Bear is
> also in?

Try that in a search box. Try it in Google. It is three lookups and a graph walk, and all
three are things finderr already holds on local disk: 1.28 million titles, 453,000 people,
1.38 million credits, 7.8 million episodes, rebuilt from IMDb every night. The answer is Emmy
Rossum, via Shameless and Jeremy Allen White, and finderr gets there in a few hundred
milliseconds because not one step of it is a network call.

That is the whole case for it. Three specific things a conversation over this index does that
nothing else available to me does:

- **Questions that are joins rather than documents.** "What have Pacino and De Niro both been
  in", "who does Nolan keep working with", "is there anything connecting Severance and
  Yellowjackets". A search engine answers those when somebody has already written the
  article. The index answers them whether or not anybody has.
- **Recency.** The index was rebuilt this morning; a model's weights were frozen months ago.
  Ask about something out last week and the model is confidently wrong while the tool
  underneath it is simply right. The system prompt says so in as many words: the index knows
  about titles released after your cutoff, and it is right and you are wrong.
- **It can act.** "Get me the Star Trek episodes rated over 8" ends with those episodes
  queued in Sonarr. One sentence doing what is otherwise a filter, a scroll and forty clicks.

### The tools are a wall, not advice

Eleven of them over the index: resolve a title, resolve a person, read either, list cast,
list credits, list episodes, browse, find connections, open a page in the UI, and request.
**Every one past the two resolvers takes `tt…` and `nm…` ids and nothing else**, so
`list_cast("Furious")` is a schema violation rather than a bad idea. A description is advice,
and a confident model talks straight past advice. A type is a wall. Across every model I
measured, that wall on its own took answering-from-memory to zero.

### A connection is a claim too

Resolving both ends of a link does not license the link. Measured on 2026-09-04: a model
resolved two shows correctly, pulled both cast lists with two separate calls, and then
asserted that people from The Bear appear in Furious. They share nobody. Every proper noun in
that sentence came back from a tool and the sentence was still false.

So the harness reads what each tool RETURNED and works out which relations it actually
established. Two `list_cast` calls, one title each, establish nothing between those titles,
because each row names only the title its own call asked about. One call over both, returning
a row that names both ids, is the database asserting the overlap. Spotting a name in both
lists yourself is an inference, and the agent is told to ask for the join instead of making
one.

Names in the answer become links the same way, and only that way. The model brackets an id
after each thing it names, the server resolves every id against the index, and a link is
built from a resolved id and never from the shape of one. A model can emit a well-formed
`tt99999999` that never existed; a miss keeps the name and drops the brackets. The label comes
from our row rather than from the model's sentence, so if it writes the wrong name for a real
id you see both and can tell that something is off.

### Grading it

```bash
bun run agent:eval           # thirteen scenarios, graded on ids
```

Never on prose, and never by a second model. A judge is a second thing to be wrong, it costs
money per case, and it makes a regression indistinguishable from the judge having an off day.
Each case names the exact id that has to appear in the answer, and the grader resolves that id
back to its name through the same index the agent read, because a model writes "Emmy Rossum"
and not "nm0002536".

Correctness and route are two separate scores. A model that gets there by a route I did not
imagine is correct and inefficient, which is a real state worth reporting. It used to be
scored as a failure, which was the benchmark lying about the thing it exists to measure.

### Which model, and why that one

The default is **`meta/muse-spark-1.3-contributor`**, and it is the recommendation rather than
merely what shipped. Six advanced cases, 2026-09-05:

| Model | Correct | Ideal route | Median | Per question | Per dollar |
|---|---|---|---|---|---|
| `meta/muse-spark-1.3-contributor` | **6/6** | 5/6 | 9.4s | **$0.0004** | ~2,400 |
| `meta/muse-spark-1.3` | **6/6** | **6/6** | **8.2s** | $0.0111 | ~90 |
| `z-ai/glm-5.3-flash` | 5/6 | 5/6 | 18.9s | $0.00085 | ~1,180 |

It beat the model it replaced on accuracy, on latency and on price at the same time, which is
rare enough to be worth stating: there was no trade-off to weigh. Full price buys the ROUTE and
not the answer. The one case that separated the tiers was the Furious question, where the cheap
tier reached the right answer through three cast and credit calls instead of asking for the
join once.

`-contributor` is a data-sharing tier and that is the whole of the discount: roughly 21x
cheaper because the provider may train on what it receives. Here that is a user's question and
index rows already published on the site; no credential is in reach, because the tools run in
this process and the model only ever sees their results. If that is the wrong trade for your
install, `FINDERR_AI_MODELS=meta/muse-spark-1.3` opts out at full price.

One caveat about the older number, since it is easy to misread. `glm-5.3-flash` scored 5/6 here
because it skipped the tools entirely on one case and answered from its weights. Re-run three
times in isolation it passed every time. **That is a roughly one-in-four flake and not an
inability** -- worth knowing if you are choosing between them, and worth not repeating as
though the model cannot do it.

### The money, and who is allowed to spend it

`ai_call` is one row per call: model, tokens, cost, outcome. The daily cap reads that table
rather than a running counter, because a counter is a second owner of a fact the log already
holds and it drifts on any failure between the call and the increment. Every outcome writes a
row, failures included, because a run that died on turn six still spent five turns of tokens.

One conversation is bounded by its turn and tool-call limits, so the worst overshoot past the
cap is about $0.003 against a $1 default -- measured on `glm-5.3-flash`, and the model that
replaced it costs half as much per question, so the headroom got wider rather than narrower.
That is the only reason the check can be a plain "have you spent more than the limit" with no
reservation machinery, and it is why the model list and the cap are one decision instead of
two. Put a frontier model in that list and the same check leaks most of the budget.

Every signed-in account may use it, and there is no setting that changes that: `aiGate` in
`src/lib/ai-spend.ts` owns who may spend, and the deployment's own key is its only condition.
A question typed in here goes to a third party, so what somebody searches for leaves the house
-- and on the default model that third party may train on it, which is the discount being paid
for. The honest handling is to say that at a per-account opt-in and let each person decide,
and that opt-in is not built. It was defensible to ship without one while the audience was the
administrators who turned the feature on, because there was nobody left to ask who had not
already answered. That stopped being true when the audience widened on 2026-09-05: an invited
household member now has the same box and nothing asks them first. The opt-in is the next
thing owed here, and a role check is not a substitute for it.

With no `FINDERR_OPENROUTER_API_KEY` the feature does not exist rather than failing, the same
way no TMDB key means no streaming availability. A fresh checkout has no assistant and says
nothing about one.

## API

Everything except `/api/health`, `/api/index-status`, `/api/webhook/arr` and the sign-in
routes needs a session cookie, an agent key, or the admin bearer key. The webhook is the
exception that is not really one: it is authenticated, just by a password of its own rather
than by a session, because Radarr and Sonarr have no cookie.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | `{"ok":true}` anonymously; the full payload to an admin |
| `GET` | `/api/agent/manifest` | agent keys only. This API described to the key that asked, as markdown, generated from the live route table |
| `GET`/`POST`/`DELETE` | `/api/auth/agent-key` | your one agent key. A person in a browser only — a key cannot manage credentials, its own included |
| `GET` | `/api/index-status` | public. What the boot build is doing, for the progress page |
| `GET` | `/api/search?q=&genre=&decade=&year=&kind=&limit=` | hits, facets, parsed intent, the tier that answered, plus `people` — matching names, best known first. The facet chips narrow the titles only. `people` is absent, not empty, on an index built before it carried a people index |
| `GET` | `/api/title/:tconst` | the local row at once, facets as they land, plus `work` saying what is still owed |
| `GET` | `/api/browse?genre=&decade=&year=&kind=&sort=&offset=` | paginated. `sort=rank` is the weighted list order, anything else is votes |
| `GET` | `/api/discover` | the front-page shelves, pure index queries, in the order the caller arranged them and without the ones they hid |
| `GET` | `/api/shelves/preference` | every shelf you could arrange, in your order, hidden ones included and marked -- a page that omitted them would make hiding a one-way door. `customised` says whether any of it is yours |
| `PUT` | `/api/shelves/preference` `{shelves:[{id,hidden?}]}` | save an arrangement. The body is the whole preference, so saving twice leaves the same page. Answers with the same payload the `GET` does, already resolved: an id no shelf carries any more is dropped, and a shelf you never mentioned is back where the release put it |
| `DELETE` | `/api/shelves/preference` | back to the shipped default. Resetting something you never arranged answers the default page rather than a `404` |
| `GET` | `/api/agent/chat` | whether the assistant is available to you and which model answers. `404` when no key is configured and `404` when you are not signed in, because a surface you may not use does not announce itself |
| `POST` | `/api/agent/chat` | one turn. Streams the run as SSE when `Accept` asks for it and returns plain JSON otherwise, from one route, because they are one operation with one gate, one ledger and one memory |
| `GET` | `/api/person/:nconst` | filmography, plus that person's nominations |
| `GET` | `/api/collection/:id`, `/api/collections` | franchise membership |
| `GET` | `/api/awards/:award` | one award's timeline and its provenance. `oscars`, `palme-dor`, `emmy-drama-series` |
| `GET` | `/api/awards/:award/:edition` | one edition, categories in their canonical order. The edition is the ceremony number where the source numbers them and the year where it does not |
| `GET` | `/api/requests` | the request log; who asked is admin-only and stripped server-side. An admin's rows also carry `requestedByName`, and a non-admin's carry neither that nor the id it resolves -- the absence is the permission, which is what `/log` reads to decide whether it has a Who column. Also carries `unseen`, your own count of arrivals you have not been shown |
| `GET` | `/api/requests?mine=1` | the same shape, narrowed to the caller. A server-side filter, because `requested_by` is stripped before a non-admin ever sees it |
| `POST` | `/api/requests` `{tconst, seasons?, profileId?, rootFolder?}` | returns `202`, queued in the background. The two overrides are admin-only |
| `POST` | `/api/requests/episode` `{tconst, season, episode}` | one episode of a series Sonarr already holds |
| `POST` | `/api/requests/season` `{tconst, season}` | every aired episode of that season we hold no file for, including any Sonarr is already searching for. The server picks them off the mirror; the client never sends a list |
| `POST` | `/api/requests/seen` | clears your unread arrivals. Takes no body: the caller is the session and the set is everything of theirs |
| `POST` | `/api/requests/:tconst/retry` | |
| `DELETE` | `/api/requests/:tconst` | withdraw. The requester or an admin; anybody else gets the same `404 unknown request` a title nobody asked for gets, so the route cannot be used to find out who asked. Drops the row, refunds the day's quota and unmonitors in the arr -- only when the arr row was one WE added. Never deletes a movie, a series or a file, and refuses a request that has already arrived |
| `GET` | `/api/admin/requests/:tconst/media` | what removing this would delete: file count, bytes, the arr's quality name, and whether Plex still holds it. Read live from the arr, because a cached size describes whatever was on disk an hour ago |
| `DELETE` | `/api/admin/requests/:tconst/media?deleteFiles=` | remove the media. `deleteFiles` is required and has no default. Takes the title out of Radarr or Sonarr, moves the request row to `removed` rather than deleting it, and writes an audit row naming the admin who did it. Refuses anything that has not arrived -- that is what withdrawing is for |
| `GET` | `/api/watchlist` | your saved titles as decorated cards, newest save first. One endpoint rather than two: the page draws these and every save button reads the ids out of the same answer. A save whose title has left the index is dropped from the response and kept in the table |
| `POST` | `/api/watchlist` `{tconst}` | save one title. Writes one row and calls no arr, spends no quota and starts no search. Saving twice is `{"saved":false}` rather than a conflict; an unknown tconst is `404` |
| `DELETE` | `/api/watchlist/:tconst` | un-save. Removing something that was never on your list is `{"removed":false}`, because the state you asked for is already true |
| `POST` | `/api/webhook/arr` | public, and the only public route that CHANGES state. Radarr's and Sonarr's Webhook payloads; basic auth, and closed until a password is set. See [Letting the arrs tell you](#letting-the-arrs-tell-you) |
| `GET` | `/api/push/key` | whether push is on, and the VAPID public key to subscribe with |
| `POST` | `/api/push/subscribe` | the browser's own `PushSubscription.toJSON()`, verbatim |
| `POST` | `/api/push/unsubscribe` `{endpoint}` | scoped to the caller: an endpoint is not a secret, so it alone must not be anybody's off switch |
| `GET` | `/api/arr/options` | admin. The quality profiles and root folders each arr offers |
| `POST` | `/api/library/sync` | admin. Walk Radarr, Sonarr and Plex now |
| `GET` | `/api/admin/invites`, `/users`, `/requests` | admin. Mint, list, revoke, reset |
| `GET` | `/img/t/:tconst` | poster by IMDb id, disk-cached, never hotlinked |
| `GET` | `/img/f/:key` | a headshot, season poster or still, by content-addressed key |

The browser is never handed a provider's image URL. Every image is proxied through
finderr, because the arrs and the metadata providers sit on your LAN and the person
looking at the page might not. Links out are derived from ids rather than stored, with two
exceptions that have no id to derive from: TMDB's per-country watch page and a rating
source's own page.

### Agent keys

Anybody with an account can create **one** agent key from their account page, and gets back a
block to hand to a script or an AI agent:

```
You have access to finderr, a media request tool. Run this to learn what you can do:

curl -H "Authorization: Bearer <key>" https://finderr.example/api/agent/manifest
```

That one call returns markdown describing the operations, copy-paste `curl` examples, both
rate-limit buckets with what is left of each, and the daily quota. It is **generated from the
live route table on every view**, so it describes the server you are actually talking to
rather than one somebody documented once.

Four things are true of every key and worth knowing before you hand one over:

- **The token is in a header, never a URL.** No route accepts it as a query parameter or a
  path segment. A token in a URL ends up in an access log, a proxy and a `Referer`.
- **It carries your access minus administration.** `/api/admin/*` answers `404` to it even
  when the owner is an admin, and `/api/auth/*` is closed too — a key cannot rotate or revoke
  a credential, its own least of all. Replacing it from the account page is one click, and the
  old token stops working in the same instant.
- **Read-only is a choice at creation**, and means `GET` and `HEAD`. A read-only key cannot
  request anything, and its manifest does not mention writing.
- **`GET /api/title/:tconst` waits for an agent** rather than making it poll: one call, one
  answer, up to a bounded deadline. A partial answer names what is still outstanding, so
  "nobody has answered yet" can never be read as "there is nothing".

The plaintext is shown exactly once, at creation. Only its `sha256` is stored, so a lost key
is replaced rather than recovered.

## Known gaps and non-goals

Every line here is a real limitation. It is not a roadmap.

### Not built yet

- No approval workflow. Requests are attributed to whoever made them and admins can see who
  asked for what, but nothing holds a request for review: every one goes straight to the
  arr. There is a daily quota -- set for everybody on `/admin`, overridden per person on
  `/admin/users/:id` -- and it is off by default, so out of the box nothing limits how much
  anybody asks for.
- Notifications go to the person who asked, and nowhere else. Web push tells them on their
  own devices when their own request arrives; there is no Discord, ntfy, Telegram or
  outbound webhook, and no way to announce an arrival to a room. (The webhook finderr does
  have points the other way: the arrs calling in. See
  [Letting the arrs tell you](#letting-the-arrs-tell-you).) The lifecycle hooks an addon would
  need for that are designed and not built; [ADDONS.md](ADDONS.md) lists them and says
  plainly that they do not exist yet.
- Withdrawing a request never removes the media, and a request that has already arrived
  cannot be withdrawn at all. Withdraw stops the search and forgets the ask; removing what
  arrived is Remove, which is a different button on the same two pages and belongs to an
  administrator. There is no way for an ordinary member to ask for something to be taken
  back out -- that is the approval-workflow shape, and approval is not built.
- Topping up a series you already have is invisible to the request log. Asking for a show
  the library mirror already knows still answers `409 already in your library`, so the two
  whole-title grains are no use there; the episode and season grains are what fill the gap,
  and neither writes a `request` row. The record that you asked is the episode mirror
  itself, reporting `monitored` and then `hasFile` from Sonarr, which means neither shows
  up on `/requests` or `/log` and neither spends anybody's daily quota.
- A request that finds nothing goes `no_release` on its own after a day and nine
  reconcile passes, rather than showing "Processing" forever. You can retry it.
- Configuring an addon needs a restart. **Administration → Addons** lists everything
  installed and generates a form from what each one declared, so a key no longer needs a
  shell on the host -- but an addon reads its settings once at load, so a change reaches it
  when finderr next starts. A secret still never comes back out: the page reports whether one
  is set and where the value came from, never the value.
- The rate limiter is in memory, per process, and resets on restart. See
  [Putting it on the internet](#putting-it-on-the-internet).
- A series gets its trailer, its "more like this" and its official-site link **only with a
  TMDB key**. Films get all three from Radarr's lookup for free; neither Sonarr's lookup nor
  skyhook carries any of them, so the `tmdb` addon serves them — and without
  `FINDERR_TMDB_API_KEY` those three panes are absent on every show. They ride the detail
  document that addon already fetches, so they cost no extra call.
- A person's face in search is only there once somebody has opened one of their titles. No
  IMDb dump carries a headshot, so the only ones finderr holds arrive on some title's cast
  facet, one title at a time, and a face is filed against the person as that happens.
  Coverage grows with use and is never complete. Initials are the ordinary fallback.
- Regional release titles are not indexed. `originalTitle` is the production-language
  title; a foreign film's Swedish or German release title needs `title.akas` filtered to a
  region, and that is not wired in yet.
- English only. The UI has no translation layer and synopses arrive in English from
  upstream. The facet vocabulary carries `language` and `country`, so a translated-synopsis
  addon is possible today; the app's own chrome is not translatable yet.
- The front page is arrangeable but never personal in the recommendation sense. `/account`
  reorders the shelves, hides the ones you never scroll to, and puts it all back with one
  control -- but that is order and visibility over the shelves that already exist. A
  preference can never ADD a shelf, which is exactly what keeps a personal front page a row
  lookup rather than a per-reader assembly. Shelves come from the index and the library,
  with no watch history and no "because you watched".
- Installed, it still needs the server to be reachable. The service worker keeps posters
  and bundles on the device and restores the front page you left, but HTML is deliberately
  never cached -- which shell this origin serves depends on your session cookie -- so
  offline you get an offline page rather than a browsable app.

### Limits of the sources

- `Episode.runtime` is always null. Skyhook carries a show-level typical runtime only,
  and the provider refuses to copy a guess onto every episode.
- Most "Where to watch" tiles print a name, not a logo. Kometa ships 26 streaming marks
  against the ~300 services TMDB knows (`STREAMING_MARKS` in `src/lib/watch-services.ts` is
  the table, and owns that count), so outside the big ones you get text. Every tile
  links to TMDB's watch page for your country, which is the one URL TMDB provides; there is
  no per-offer link in the payload.
- A studio badge appears only once the title's poster has been resolved. Both come from
  the same arr lookup, which runs lazily, so an unowned title seen for the first time has
  no badge until its poster has been fetched. Owned titles are seeded by the library sync
  and have badges immediately.
- Posters depend on the arrs being reachable. The bulk crosswalk carries an id, not an
  image: the poster itself still comes from Radarr and Sonarr's lookup endpoints, and a
  title neither can resolve gets a typographic tile.
- Plex must have matched the item with the modern agent. finderr finds a title in Plex by
  the `imdb://` guid the new agent writes. A library scanned by a legacy agent
  (`com.plexapp.agents.*`) matches nothing, and `/api/health` shows `plex.items: 0` beside
  a configured URL.

### Cost you should know about

- The index rebuild is heavy on low-power hardware, and it has got heavier on purpose. The
  cast stage scans a 100M-row dump to keep about 1% of it, and the episode stage adds a
  fifth dump on top. Both were taken knowingly: see [Speed](#speed) for the trade, and
  `src/lib/index-builder.ts` for the measured cost on real hardware. It runs unattended at
  09:00 UTC, the cast stage runs weekly rather than daily, and it only hurts if you kick one
  off by hand and stand there watching.
- The index is big. Around 2 GB, plus the previous generation kept beside it. That is the
  same trade from the other side, and if you want it smaller the dials are
  `FINDERR_INDEX_EPISODE_SERIES_MIN_VOTES`, `FINDERR_INDEX_CAST_MIN_VOTES` and
  `FINDERR_INDEX_TITLE_TYPES`. Every one of them buys space by making finderr unable to
  answer about something.
- The cast index is floored at 1,000 votes. Person pages and linked names exist for
  titles above that; below it a name is plain text. Lowering the floor is a config change
  and a much longer build.
- Four IMDb title types are indexed by default: `movie`, `tvSeries`, `tvMiniSeries`,
  `tvMovie`. No shorts, specials, video games or adult titles unless you widen
  `FINDERR_INDEX_TITLE_TYPES` and rebuild.

### Non-goals, decided rather than pending

- Not a Seerr replacement for a Jellyfin or Emby household. Plex is the only media server
  finderr talks to, for sign-in and for the Play button. Radarr and Sonarr are the only
  arrs.
- No 4K or second-instance requests. One Radarr and one Sonarr, each configured with one
  default quality profile and one root folder. An admin can override those two for a single
  request; nothing else about the destination is selectable, and there is no second instance
  to send anything to.
- Nothing is embedded from a third party. The trailer is a link out, never an iframe.
  finderr is meant to face the internet, and a third party's player and its tracking do
  not go on the page.
- No addon marketplace, ever. An addon runs with the server's privileges, and the server
  holds the arr keys. Installing one means reading its code first. There is no catalogue
  to click through.
- Nothing on the render path may block on the network. A handler that can wait on a
  provider while somebody is looking at the screen is treated as a bug, so a feature that
  cannot be answered from local SQLite either fills in behind the page or does not ship. The
  assistant is the one deliberate exception and it says so: a live model call is the whole
  of what it is, for every caller. See
  [The money, and who is allowed to spend it](#the-money-and-who-is-allowed-to-spend-it) for
  who may make one.

## finderr and Seerr, fairly

[Seerr](https://github.com/seerr-team/seerr/) (formerly Overseerr and Jellyseerr) is the
mature one, and it does plenty finderr does not:

| | Seerr | finderr |
|---|---|---|
| Search | live TMDB round trip per keystroke | local index, milliseconds, typo-tolerant |
| Browse and lists | live TMDB | local, and precomputed: 0.06 to 1 ms for a page, totals counted at build |
| Needs a TMDB key | yes | no (optional, for streaming availability) |
| Media servers | Plex, Jellyfin, Emby | Plex |
| Users | any server user, imported | invite-only, passkey or Plex |
| Request approval | yes | no |
| Request quotas | yes | per-user daily cap, off by default |
| Notifications | Discord, Telegram, email, Pushover, webhooks, ... | web push to the asker's own devices, and an in-app unread count |
| 4K / second instance | yes | no |
| Issue reporting | yes | no |
| Cast, crew, person pages | via TMDB, live | local, from the IMDb dumps |
| Per-episode data | air dates | air dates and IMDb's score on all 7.8M episodes, as a grid, a list and a timeline |
| Ranked lists, awards | TMDB's popular / trending | a weighted rank computed at build time, plus every Oscar nomination and two winner lists from Wikidata |
| Ask it a question | no | an assistant with eleven tools over the index, in beta, for every signed-in account |
| Extensibility | none | addons: facets and panes |
| On a phone | works | built for it: installs to the home screen, no zoom on focus, one-handed search, safe-area aware, works through a flaky connection |
| Process footprint | Node + SQLite/Postgres, TMDB on every render | one Bun process, one SQLite index, ~150 MB image |
| Disk footprint | small | ~4 GB of index and dumps, and that is the trade, not an accident |

Seerr is the more powerful of the two and that table is not close in its favour anywhere
that matters for a big installation. finderr is the less annoying one, and mostly on a
phone -- which is where every request in my house actually gets made, usually one-handed,
usually from the sofa. Searching does not wait on a network round trip per keystroke,
focusing the search box does not zoom the page into a viewport you have to pinch back out
of, and moving between screens is animated rather than a hard cut. None of that is a
feature Seerr lacks so much as a set of small irritations it never set out to remove.

So: if you run a big shared library with users you do not fully trust and you need
approval and quotas, Seerr is still the right tool today. If it is a handful of people you
invited yourself, and what bugs you about Seerr is the waiting and the fiddling on a small
screen, run this instead. The two run side by side fine, against the same arrs.

### If Seerr fixes this, finderr is done

Nothing finderr does better is out of Seerr's reach. The index could be local. The search
could stop waiting on TMDB for every keystroke. The phone irritations are a week's work for
somebody who is annoyed by them. If that happens, this project has no reason to exist, and I
will say so here and point you at Seerr rather than keep it alive out of pride.

Until then it is maintained, because I use it every day and so does my household. Issues get
answered, pull requests get read, and the index rebuilds itself every morning whether anybody
is watching or not.

## Join the crew

Bug reports, typos, an addon for a source nobody has wired up, a translated synopsis
facet, a better "more like this" -- all welcome. Open an issue or a pull request. Not sure
it fits? Open the issue anyway and we will figure it out ;-)

It is a one-person project by accident rather than by design, and I would rather it were
not. Small PRs need no permission: fix the typo, send it. If you want to take on something
bigger, open an issue first so two people do not write the same thing twice -- that is the
whole of the coordination there is. A PR I cannot take gets a reason, never silence.

```bash
bun run test && bun run test:web && bun run typecheck && bun run lint
```

That is the gate CI runs and the one a PR has to pass. The first two are disjoint runs in
different environments -- the browser tests get a DOM and the server tests must not have one
-- so neither stands in for the other. Adding a browser test? `web/src/test/interact.ts`
owns the rule for which of the two idioms it should use. Two rules while you are in here;

1. The render path touches nothing but local SQLite and local disk. A handler that can
   block on the network while a person waits is a bug.
2. Be polite on other people's servers. Every outbound call goes through the paced,
   hard-cached fetch. There is no second route to a third party.

The reasoning behind most decisions sits in doc comments next to the code it describes.
`src/server/live-index.ts`, `src/lib/facet-resolver.ts` and `web/src/lib/facet-panes.ts`
are the three to read before changing anything structural.

## Licence and attribution

finderr is MIT licensed; see [LICENSE](LICENSE). Some of what it uses belongs to other
people and is not covered by that licence:

- The [IMDb datasets](https://developer.imdb.com/non-commercial-datasets/) are published
  for personal and non-commercial use. A private request UI for one household is inside
  that. A public or commercial deployment is not.
- TMDB's image CDN serves the posters and, with a key, its API serves streaming
  availability and series keywords. *This product uses the TMDB API but is not endorsed or
  certified by TMDB.* The availability catalogue is JustWatch's, credited on the pane
  beside the data.
- The Servarr metadata proxies (`api.radarr.video`, `skyhook.sonarr.tv`) are run by the
  Servarr team for Radarr and Sonarr clients. finderr is a third party on them and behaves
  like one.
- Rotten Tomatoes' public search index supplies the audience score.
- The Academy Award nominations come from
  [oscar_data](https://github.com/DLu/oscar_data) by DLu, BSD-2-Clause. finderr records the
  commit it parsed and says so on the awards page.
- The id crosswalk is [Wikidata](https://www.wikidata.org/) (CC0), queried through
  [QLever](https://qlever.cs.uni-freiburg.de/) at the University of Freiburg (Apache-2.0).
- The Palme d'Or and Primetime Emmy winners come from Wikidata too, through its own
  [query service](https://query.wikidata.org/). There is no commit to pin on a database
  that changes continuously, so finderr records the QUERY and the moment it ran, and the
  awards page prints both.
- The logo set is fetched at build time from [Kometa](https://github.com/Kometa-Team/Kometa/)
  (MIT). The marks themselves remain their trademark holders' property and are used for
  identification only.
- `vendor/sqlite-spellfix/spellfix.c` is SQLite's own `spellfix1` extension, placed in the
  public domain by its authors and vendored because no packaged build ships it.
- The Plex deep-link templates are reproduced from
  [Jellyseerr](https://github.com/Fallenbagel/jellyseerr/)'s `Media.ts`, because Plex
  documents neither of them.

finderr is not affiliated with IMDb, TMDB, JustWatch, Rotten Tomatoes, Plex, Wikidata, the
Academy of Motion Picture Arts and Sciences, the Servarr team or Kometa. I wrote it from scratch, loosely around the shape of Seerr, with the search
moved off the network.

--\
[aannarr](https://github.com/aannarr/)
