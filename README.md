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

Seerr is slow because it is a thin proxy. A search, a poster, a "do I have this already?"
are all live round trips to TMDB, Radarr and Sonarr while you sit there. On a NAS that
round trip is the whole experience, and I got sick of it.

finderr keeps the whole searchable universe local: 1.27 million titles from the IMDb
datasets in one SQLite file, plus a mirror of both arr libraries that refreshes every
minute. Every page comes off disk. finderr only hits the network for things that actually
change, in the background, after the page has painted.

One rule runs the whole codebase: the render path touches nothing but local SQLite and
local disk. A handler that can block on a network call while somebody is waiting is a bug,
and I treat it as one. Metadata comes in from cached addons a moment later and fills in
behind the page.

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

Every Academy Award nomination since 1929 is in the index too, from
[oscar_data](https://github.com/DLu/oscar_data). `/awards/oscars` is a timeline of every
ceremony, each year is its own page, and a title or a person that was ever nominated
carries its wins and nominations on its page. It is a local table like everything else:
imported on a daily timer, read off disk, and it costs no API call at render.

The title page paints at once and fills in behind itself: synopsis, ratings from IMDb,
TMDB, Metacritic, Trakt and Rotten Tomatoes (critics and audience), a trailer link, cast
with headshots, crew, named seasons with air dates per episode, collection, more like
this, certification, release dates, keywords, Oscar wins and nominations, and a "Where to
watch" row for your own country. Nothing on it waits for a provider.

Person and collection pages come from the local index too. Cast and crew names are links,
a filmography is one click, and the reverse index is built from IMDb's `title.principals`
dump, so it costs no API call at all.

Requests return immediately. The POST answers `202`, a background worker adds the title
to Radarr or Sonarr, and a toast tells you how it went. For a series you pick the seasons
before anything is queued. Retry is a button. There are three grains: a whole title, a
season selection, and -- for a series Sonarr already holds -- a single episode, which is
the case the other two refuse. An admin can also override the quality profile and root
folder for one request without touching the defaults.

With a Plex token, a title you already own gets a Play button that deep-links into the
Plex app or web player, instead of a line of text saying you have it.

`/requests` is where your own asks live, newest arrivals first, each with the same honest
sentence about why it is slow that the title page gives. Anything that arrived and you have
not seen yet is counted in the header, and the count survives closing the app -- one per
request, so a season pack finishing is one piece of news rather than twenty.

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
table. The first boot prints an invite link for the first admin; admins mint invites,
manage users and roles, and can reset anyone's access. Everybody gets an account page to
name their passkeys, add another one, and connect or disconnect their Plex login. An
anonymous visitor gets a bare login page and nothing else.

Metadata comes from addons, not from core. Three ship in the box: the Servarr metadata
proxies (keyless), Rotten Tomatoes' public index (the audience score, keyless), and TMDB
(needs a key; buys streaming availability and series keywords). Writing your own is one
file with two exports. See [ADDONS.md](ADDONS.md).

It is small: one process, one SQLite index, one app database, a ~150 MB image. No
Postgres and no Redis, and it runs without a TMDB key.

## Install

### What you need

- Docker, amd64 or arm64. The image is built for both and needs no AVX, so an old
  Celeron NAS is fine.
- A running Radarr and Sonarr and their API keys (Settings -> General in each).
- RAM: the shipped compose caps the container at 1.5 GB and the index build runs inside
  that. Serving idles far lower.
- Disk: about 4 GB. The index is ~550 MB, the previous generation is kept, the dumps are
  downloaded, and the poster cache ceiling is 2 GB by default. Put the data directory
  somewhere with room. One heads up: if that volume has a filesystem quota, check it
  first. A full quota on a shared NAS volume takes down whatever else lives there.
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
docker compose logs finderr | grep invite                     # your first admin link
```

That is the whole install. There is no separate first-build step: with no index at
`/data/titles.db`, finderr comes up anyway, serves a page telling you what it is doing, and
builds one in the background. Open `http://<host>:7979` and watch it — the page reloads
itself when the index lands. Every route that needs an index answers `503` until then, and
`/api/health` stays green throughout, so the container does not fail its own healthcheck
while doing what you asked.

The build downloads the IMDb dumps (a few hundred MB), builds the index, runs a canary
suite of real queries against it, and only then swaps it live. Count on about 100 s on a
desktop-class CPU and about six minutes on a low-power NAS (more under
[Known gaps](#known-gaps-and-non-goals)). After that it refreshes itself daily and swaps
in place. No restart.

> [!NOTE]
> Set `FINDERR_INDEX_REFRESH_ON_BOOT=false` if you would rather build the index yourself.
> finderr then exits when there is no index, and you build one with
> `docker compose run --rm finderr bun src/jobs/build-index.ts`. It has to be `run --rm`
> and not `exec`: with `restart` set, a container that exits for want of an index is
> restarting, and `exec` fails with *"Container is restarting"* forever — the thing that
> would stop the restarting is the command you are trying to run. Once an index exists,
> `exec` works for everything else.

Open `http://<host>:7979` and follow the invite link from the log.

#### Creating your first admin

There is no sign-up form. finderr is invite-only, so the very first boot mints an admin
invitation and prints it, once, to the log:

```bash
docker compose logs finderr | grep invite
```

Open that link and create your account. The token is never stored — only a hash of it —
so it cannot be listed again afterwards. If the line has scrolled away or the invite has
expired, mint another with the system API key rather than hunting for it:

```bash
curl -s -X POST http://<host>:7979/api/admin/invites \
  -H "Authorization: Bearer $FINDERR_ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -d '{"role":"admin"}' | jq -r .url
```

That endpoint is how an admin — or a script — does everything a person can do from
`/admin`. It needs `FINDERR_ADMIN_API_KEY` to be set; without it, the admin API answers
only to an admin's own session, which is a legitimate way to run and simply means you
cannot bootstrap from a shell.

`/api/health` tells you where you stand: `auth.users: 0` means nobody has claimed the
bootstrap invite yet and it is still the only way in.

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
bun run awards:import              # every Oscar nomination, 2.2 MB -- optional, see below
bun run build                      # the web UI
bun start                          # http://localhost:7979
```

`logos:import` pulls the studio, network, streaming and rating marks from a pinned
[Kometa](https://github.com/Kometa-Team/Kometa/) commit into `web/public/logos/`. They
belong to their trademark holders and are not tracked here. Skip the step and every badge
prints its name instead. The Docker build runs it for you.

`awards:import` is optional in the same way `index:build` is: the server imports the
nominations itself twelve seconds after a cold boot and re-checks daily, so you only run
it by hand to fill the awards pages before the first check, or with `--file oscars.tsv`
on a machine with no route to GitHub. A failed import is logged and swallowed -- the
awards pages come up empty and nothing else changes.

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
| `FINDERR_TMDB_API_KEY` | | Optional. Only the `tmdb` addon uses it: streaming availability and series keywords |
| `FINDERR_PLEX_URL` | | Optional, e.g. `http://plex:32400`. With a token, owned titles get a Play button |
| `FINDERR_PLEX_TOKEN` | | Sent as `X-Plex-Token`, never in a URL. finderr only reads, but the token itself is full account access |
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
| `FINDERR_REQUEST_QUOTA_PER_DAY` | `0` | Titles one ordinary user may request per UTC day; `0` is unlimited. Counted in **titles**, so a series is one however many seasons are picked, and re-requesting something already queued costs nothing. Admins are exempt, single-episode requests do not count, and a user over the limit gets `429` naming their reset time |
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
| `FINDERR_LIBRARY_REFRESH_SECONDS` | `60` | Arr and Plex mirror interval |
| `FINDERR_KEEP_SHELVES_FRESH` | `false` | Hold the front page in memory instead of computing all fifteen shelves per request, rebuilding each shelf from the timer that owns its data — the arr mirror every 60s, the TMDB mirrors every 6h, the index once a day. `/api/discover` goes from ~100ms to ~33ms for about 200 KiB of heap. It changes *when* rows are computed and never which: what you own is still applied per request, so a title you just downloaded leaves the recommendation shelves immediately. `/api/health` reports `shelves` with a per-tier build time |
| `FINDERR_ARTWORK_CACHE_MAX_BYTES` | `2000000000` | Poster cache ceiling, least-recently-written evicted first |
| `FINDERR_TMDB_CACHE_IMAGES` | `true` | |
| `FINDERR_RESOURCE_LOG_SECONDS` | `300` | One-line RSS/heap/GC summary in the log. `0` disables |
| `FINDERR_PLUGINS_DIR` | | Addon directory. Empty = the built-in `src/plugins` |
| `FINDERR_PLUGIN_MODULES` | | Comma-separated installed packages. Runs their code; read [ADDONS.md](ADDONS.md) first |
| `FINDERR_CONFIG_FILE` | `/config/config.yml` | Optional YAML, same keys in camelCase |

`/api/health` answers `{"ok":true}` to anyone, which is all the container probe needs.
With the admin key (or an admin session) it reports index rows and build time, the last
in-place swap and its canary score, library, Plex and upcoming mirror counts, the award
import (row count and the commit it was parsed from), addon coverage of the front page,
per-provider and per-host timings saying where a cold title's second actually went, user
and session counts, and memory.

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
| `tmdb` | `api.themoviedb.org` | yes | streaming availability per country, keywords for series |

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
| `GET` | `/api/search?q=&genre=&decade=&year=&kind=&limit=` | hits, facets, parsed intent, the tier that answered |
| `GET` | `/api/title/:tconst` | the local row at once, facets as they land, plus `work` saying what is still owed |
| `GET` | `/api/browse?genre=&decade=&year=&kind=&sort=&offset=` | paginated. `sort=rank` is the weighted list order, anything else is votes |
| `GET` | `/api/discover` | the front-page shelves, pure index queries |
| `GET` | `/api/person/:nconst` | filmography, plus that person's nominations |
| `GET` | `/api/collection/:id`, `/api/collections` | franchise membership |
| `GET` | `/api/awards/oscars` | the ceremony timeline and its provenance |
| `GET` | `/api/awards/oscars/:ceremony` | one year, categories in their canonical order |
| `GET` | `/api/requests` | the request log; who asked is admin-only and stripped server-side. Also carries `unseen`, your own count of arrivals you have not been shown |
| `GET` | `/api/requests?mine=1` | the same shape, narrowed to the caller. A server-side filter, because `requested_by` is stripped before a non-admin ever sees it |
| `POST` | `/api/requests` `{tconst, seasons?, profileId?, rootFolder?}` | returns `202`, queued in the background. The two overrides are admin-only |
| `POST` | `/api/requests/episode` `{tconst, season, episode}` | one episode of a series Sonarr already holds |
| `POST` | `/api/requests/seen` | clears your unread arrivals. Takes no body: the caller is the session and the set is everything of theirs |
| `POST` | `/api/requests/:tconst/retry` | |
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

- No request quotas and no approval workflow. Requests are attributed to whoever made
  them and admins can see who asked for what, but nothing limits how much one person may
  ask for and nothing holds a request for review. Every request goes straight to the arr.
- Notifications go to the person who asked, and nowhere else. Web push tells them on their
  own devices when their own request arrives; there is no Discord, ntfy, Telegram or
  webhook, and no way to announce an arrival to a room. The lifecycle hooks an addon would
  need for that are designed and not built; [ADDONS.md](ADDONS.md) lists them and says
  plainly that they do not exist yet.
- No request cancel or delete from the UI. A request that reached the arr is undone in
  the arr.
- A series already in Sonarr cannot be extended by the season. Season picking works when a
  series is first requested; asking again for a show the library mirror already knows
  answers `409 already in your library`, and the worker only ever calls *add*. Adding a
  whole season to a partially-monitored show is done in Sonarr for now. Single episodes are
  the exception and do work: an episode of a series Sonarr already holds is one button, and
  it is tracked by the episode mirror rather than by a request row, so it does not appear in
  the request log.
- A request that finds nothing goes `no_release` on its own after a day and nine
  reconcile passes, rather than showing "Processing" forever. You can retry it.
- No per-addon configuration. An addon needing an API key reads `process.env` itself.
  That is the biggest single gap in the extension surface and it blocks every addon that
  is not keyless.
- The rate limiter is in memory, per process, and resets on restart. See
  [Putting it on the internet](#putting-it-on-the-internet).
- Series get no trailer, no "more like this" and no official-site link. Films get all
  three from Radarr's lookup for free; neither Sonarr's lookup nor skyhook carries any of
  them, so a series resolves those facets as empty. Source gaps, and each is an addon over
  TMDB rather than a core change.
- Search is titles only. You cannot type an actor's name into the search box. People are
  reached by clicking a name on a title page; from there a filmography is one click.
- Regional release titles are not indexed. `originalTitle` is the production-language
  title; a foreign film's Swedish or German release title needs `title.akas` filtered to a
  region, and that is not wired in yet.
- English only. The UI has no translation layer and synopses arrive in English from
  upstream. The facet vocabulary carries `language` and `country`, so a translated-synopsis
  addon is possible today; the app's own chrome is not translatable yet.
- The front page is the same for everyone. Shelves come from the index and the library;
  no watch history, no "because you watched", no personalisation.
- Installed, it still needs the server to be reachable. The service worker keeps posters
  and bundles on the device and restores the front page you left, but HTML is deliberately
  never cached -- which shell this origin serves depends on your session cookie -- so
  offline you get an offline page rather than a browsable app.

### Limits of the sources

- `Episode.runtime` is always null. Skyhook carries a show-level typical runtime only,
  and the provider refuses to copy a guess onto every episode.
- Most "Where to watch" tiles print a name, not a logo. Kometa ships 26 streaming marks
  against the ~300 services TMDB knows, so outside the big ones you get text. Every tile
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

- The index rebuild is heavy on low-power hardware. About 100 s on a desktop-class CPU,
  about six minutes on a Celeron NAS, inside the 1.5 GB the compose file allows. It runs
  unattended at 09:00 UTC by default, and the cast stage (the part that scans a 100M-row
  dump) runs weekly rather than daily. It only hurts if you rebuild by hand and wait.
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
- No 4K or second-instance requests. One Radarr, one Sonarr, one quality profile and one
  root folder each.
- Nothing is embedded from a third party. The trailer is a link out, never an iframe.
  finderr is meant to face the internet, and a third party's player and its tracking do
  not go on the page.
- No addon marketplace, ever. An addon runs with the server's privileges, and the server
  holds the arr keys. Installing one means reading its code first. There is no catalogue
  to click through.
- No feature that needs a live network call while someone is looking at the screen. See
  [Why](#why).

## finderr and Seerr, fairly

[Seerr](https://github.com/seerr-team/seerr/) (formerly Overseerr and Jellyseerr) is the
mature one, and it does plenty finderr does not:

| | Seerr | finderr |
|---|---|---|
| Search | live TMDB round trip per keystroke | local index, milliseconds, typo-tolerant |
| Needs a TMDB key | yes | no (optional, for streaming availability) |
| Media servers | Plex, Jellyfin, Emby | Plex |
| Users | any server user, imported | invite-only, passkey or Plex |
| Request approval, quotas | yes | no |
| Notifications | Discord, Telegram, email, Pushover, webhooks, ... | web push to the asker's own devices, and an in-app unread count |
| 4K / second instance | yes | no |
| Issue reporting | yes | no |
| Cast, crew, person pages | via TMDB, live | local, from the IMDb dumps |
| Ranked lists, awards | TMDB's popular / trending | a weighted rank computed at build time, plus every Oscar nomination |
| Extensibility | none | addons: facets and panes |
| On a phone | works | built for it: installs to the home screen, no zoom on focus, one-handed search, safe-area aware, works through a flaky connection |
| Footprint | Node + SQLite/Postgres, TMDB on every render | one Bun process, one SQLite index, ~150 MB image |

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

## Join the crew

Bug reports, typos, an addon for a source nobody has wired up, a translated synopsis
facet, a better "more like this" -- all welcome. Open an issue or a pull request. Not sure
it fits? Open the issue anyway and we will figure it out ;-)

```bash
bun run test && bun run test:web && bun run typecheck && bun run lint
```

That is the gate CI runs and the one a PR has to pass. Two rules while you are in here;

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
