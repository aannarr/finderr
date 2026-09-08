# Multi-homed playback: streaming over more than one route

Most servers can be reached at more than one address -- a LAN IP, a `.local` name, an IPv6
address, a public hostname through a proxy -- and a player normally has to pick one and live
with it. Plex works this way: it advertises a connection list, chooses one, and if that route
dies the session dies with it.

finderr does not have to. **HLS segments are independent GETs**, so the player can send the
*next* segment somewhere else. That buys three things:

- **Failover.** A route that stops answering costs one segment retry, not the playback.
- **Locality.** A viewer on the LAN streams over the LAN instead of hairpinning out to your
  public hostname and back in through your own uplink.
- **IPv6 first, with v4 underneath**, without having to know in advance which the viewer has.

This guide is how to set it up. It is entirely optional: with nothing configured, playback
streams from whatever origin the page was loaded at, exactly as it did before.

---

## The short version

```yaml
environment:
  FINDERR_STREAM_ENDPOINTS: "192.168.1.20,2001:db8:1::20,https://finderr.example.com"
```

A comma-separated list of addresses. Restart, open a title, press **Play here**, and the
player probes all of them and streams from whichever answers first.

Everything below is detail you only need when that is not enough.

---

## What can go in the list

Each entry is one address. **Anything you leave out is filled in from something finderr
already knows**, so the common case is a bare list:

| You write | finderr reads it as |
|---|---|
| `192.168.1.20` | `http://192.168.1.20:7979` -- LAN |
| `2001:db8:1::20` | `http://[2001:db8:1::20]:7979` -- WAN (a global IPv6 address is routable) |
| `fd00::20` | `http://[fd00::20]:7979` -- LAN (unique-local) |
| `192.168.1.20:8080` | `http://192.168.1.20:8080` -- LAN |
| `finderr.example.com` | `http://finderr.example.com:7979` -- WAN |
| `https://finderr.example.com` | `https://finderr.example.com` -- WAN |

The rules, in one place:

- **Scheme** defaults to `http`. Write `https://` when you mean it.
- **Port** defaults to `FINDERR_PORT`. An IPv6 literal is bracketed for you.
- **Address family** comes from the literal. A *name* is neither -- your resolver decides,
  which is the correct answer for a dual-stack name.
- **LAN or WAN** is derived from the literal: RFC 1918 (`10/8`, `172.16/12`, `192.168/16`),
  carrier-grade NAT (`100.64/10`) and IPv6 unique-local (`fc00::/7`) are LAN, everything else
  is WAN.

### When you have to say `lan=` or `wan=`

DNS does not say whether a name is inside or outside your network, so a bare name is assumed
to be **outside**. If you have a LAN-only short name, say so:

```
FINDERR_STREAM_ENDPOINTS=lan=finderr.lan,wan=https://finderr.example.com
```

Getting this wrong is not fatal -- it costs a LAN viewer at most one place in the probe order,
about a quarter of a second -- but it is worth two characters.

A malformed entry is dropped and the rest of the list still works. `http://` prefixed onto
something that is not a bare host is *refused* rather than repaired, so `ftp://10.0.0.5` and
`10.0.0.5/some/path` are both dropped rather than silently becoming a wrong address.

---

## The three sources

The list the player receives is built from three places, merged and deduplicated. You can see
exactly what your deployment is advertising:

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:7979/api/play/endpoints | jq
```

```json
{"endpoints": [
  {"base":"http://192.168.1.20:7979","family":"v4","kind":"lan","source":"static"},
  {"base":"http://[2001:db8:1::20]:7979","family":"v6","kind":"wan","source":"interface"},
  {"base":"https://finderr.example.com","family":null,"kind":"wan","source":"static"}
]}
```

**1. Static, from `FINDERR_STREAM_ENDPOINTS`.** The reliable half. Set this one.

**2. The container's own interfaces.** Free, automatic, no configuration. Loopback and
link-local addresses are skipped because no other machine can use them. This is what makes a
LAN address appear without you typing it -- **but only if the container can see a real LAN
address**, which under Docker's default bridge network it cannot: it sees `172.17.x.x`, an
address that means nothing outside that host. See [Docker networking](#docker-networking).

**3. UPnP IGD**, off by default. See [UPnP](#upnp-asking-the-router-yourself).

### The order they come back in

Locality dominates: **every LAN candidate ranks above every WAN one**, because the difference
between a local hop and a round trip through your uplink is large and the difference between
v4 and v6 is not. Within a kind, IPv6 comes first (no NAT in the way), a name sits in the
middle, and IPv4 last.

The order is advice, not routing. finderr cannot know which of its addresses *your browser*
can reach -- you may be on the LAN, on a VPN, or on a phone on mobile data. The player settles
it by trying, which is the next section.

---

## How the player chooses

When you press **Play here**, before the first byte of video:

1. The player fetches the session's master playlist from the best candidate.
2. If that has not answered in **250 ms**, it asks the next one too, and so on -- up to three
   in flight at a time. First one to answer wins and is pinned for the session.
3. Everything after that -- both rendition playlists, every init segment, every video, audio
   and subtitle segment -- goes to the pinned address.

That staggered race is the reason it is safe to advertise a LAN address to a viewer who turns
out to be on the far side of the internet. **An unroutable address does not fail, it hangs**,
until a TCP connect timeout ten or more seconds later; a strictly ordered walk would stall the
player for all of it. On a viewer who *is* on the LAN, the first candidate answers in single
milliseconds and nothing else is ever asked.

Segments are **not** raced. Firing every segment at three addresses would triple the traffic
of a video stream for its whole length to buy something a retry already buys. The probe is a
few hundred bytes and is spent once.

### Failover, mid-stream

If the pinned address stops answering -- a timeout, a refused connection, a 5xx -- the player
moves it to the back of the list and hls.js's own retry fetches that segment from the next
one. A dead route costs one segment.

A **404 does not** trigger failover, deliberately: finderr answers 404 for a segment ffmpeg
has not produced yet, which is ordinary back-pressure on a perfectly healthy connection.

A demoted address goes to the back rather than being struck off, so a route that was down when
the film started is tried again later. Routes come back.

---

## The session key

This is the part that is easy to get wrong, so finderr does it for you -- but it is worth
knowing what is happening, because it is the reason cross-origin playback works at all.

Your finderr session cookie is `SameSite=Lax`. **A browser will not send it to an origin the
page was not loaded from.** So the moment a segment is fetched from a different address than
the page, the cookie is absent and every request would be a 401.

Relaxing the cookie is the wrong fix: that is the credential guarding the whole application,
and weakening it to serve a video is a bad trade. Instead:

- Starting a session **mints a stream token**, in the reply, over whatever origin the app
  itself is served from -- HTTPS wherever you have a public name.
- The token is appended to every playlist and segment URL, so it travels with the request to
  whichever address won the race, including a plain-http LAN one.
- It grants **one session's segments and nothing else**. Not your account, not another
  playback, not the API.
- It is **separate from the session id**, so the id stays safe to print in a log or an admin
  page.
- It **expires in 30 minutes** and the player renews it mid-film. Renewal requires the session
  cookie, so a captured token cannot refresh itself -- which is what makes the short window
  real rather than decorative.
- It dies with the session, which is reaped a minute after the last segment request.

**Practical consequence: mint over HTTPS.** If the app itself is reachable over plain http
from outside your LAN, the token is minted in the clear. Serve finderr over HTTPS -- the
[Caddy](#caddy) section below is the whole of it -- and the token is only ever exposed on the
hop you chose to make plain, which is a LAN address on your own wire.

### CORS

Segments may now come from an origin the page did not load from, so finderr sends
`Access-Control-Allow-Origin` -- but only for origins that are **either an advertised endpoint
or one of `FINDERR_AUTH_ORIGINS`**. Nothing else gets the header.

You do not have to configure this. If an address is in `FINDERR_STREAM_ENDPOINTS` it is
allowed to serve segments to a page loaded at any other one.

### TLS has to cover every name

A browser refuses a segment from an HTTPS address whose certificate does not match, and the
failure looks exactly like a broken player rather than a certificate problem. If you advertise
two HTTPS names, both need a valid certificate. Mixing one HTTPS name and one plain-http LAN
address is fine and is the normal setup -- but see [Mixed content](#mixed-content) for the one
browser rule that bites.

### Mixed content

**A page served over HTTPS cannot fetch a plain-http subresource.** Browsers block it
outright, with no way to opt in. So this combination does not work:

- Page loaded at `https://finderr.example.com`
- Segment fetched from `http://192.168.1.20:7979`

The probe simply fails, the LAN candidate loses the race, and playback continues over HTTPS.
Nothing breaks -- you just do not get the LAN path.

**To get the LAN path for a viewer on your network, put HTTPS on your LAN address too.** With
a wildcard certificate and a split-horizon DNS record this is easy, and the
[UniFi](#unifi-split-horizon-dns) and [Caddy](#caddy) sections below are exactly that recipe.

---

## Worked setups

### Docker networking

Under Docker's default bridge, the container sees `172.17.0.x` -- an address only that host can
reach. Interface discovery will dutifully advertise it and every probe will fail. Two ways out:

**Name the real addresses.** Simplest, works everywhere:

```yaml
services:
  finderr:
    image: ghcr.io/aannarr/finderr:latest
    ports: ["7979:7979"]
    environment:
      FINDERR_STREAM_ENDPOINTS: "192.168.1.20,https://finderr.example.com"
```

**Or use host networking**, so the container's own interfaces *are* the host's:

```yaml
services:
  finderr:
    image: ghcr.io/aannarr/finderr:latest
    network_mode: host
    environment:
      FINDERR_STREAM_ENDPOINTS: "wan=https://finderr.example.com"
```

Host networking is also the only mode in which [UPnP](#upnp-asking-the-router-yourself) can
work, because SSDP is a UDP multicast that a bridge network does not carry.

**IPv6 needs enabling on the daemon.** Docker does not give a bridged container an IPv6
address unless you have configured it (`"ipv6": true` and a `fixed-cidr-v6` in
`/etc/docker/daemon.json`, or an IPv6-enabled network in compose). Without that, name your v6
address statically or use host networking.

### Caddy

The usual setup: one Caddy in front of everything, terminating TLS for a public name and a LAN
name from the same certificate.

```caddy
finderr.example.com, finderr.lan {
    reverse_proxy finderr:7979
}
```

Then tell finderr both names are it, and which one is local:

```yaml
environment:
  FINDERR_STREAM_ENDPOINTS: "lan=https://finderr.lan,wan=https://finderr.example.com"
  FINDERR_AUTH_ORIGINS: "https://finderr.example.com,https://finderr.lan"
  FINDERR_AUTH_TRUST_PROXY: "true"
```

Two things that are easy to miss:

- **`FINDERR_AUTH_TRUST_PROXY` must match reality.** Behind a proxy with it off, every request
  looks like it came from the proxy and the whole internet shares one rate-limit bucket. With
  it on and *no* proxy in front, a caller can forge `X-Forwarded-For`.
- **Both names need to be in `FINDERR_AUTH_ORIGINS`**, or signing in at one of them fails.

If you use caddy-docker-proxy labels instead of a Caddyfile:

```yaml
labels:
  caddy_0: finderr.example.com
  caddy_0.reverse_proxy: "{{upstreams 7979}}"
  caddy_1: finderr.lan
  caddy_1.reverse_proxy: "{{upstreams 7979}}"
```

### UniFi: split-horizon DNS

To make `finderr.lan` (or `finderr.example.com` itself) resolve to your local Caddy from
inside the network, rather than going out to the internet and back:

1. **Settings → Networks → your LAN → DHCP → DNS Server** -- make sure clients use the
   gateway for DNS rather than a hardcoded public resolver.
2. **Settings → Profiles → DNS** (on older firmware, **Settings → Networks → Domain Name**)
   -- add a static entry mapping the name to your **reverse proxy's** address, not the
   finderr container's:

   | Record | Type | Value |
   |---|---|---|
   | `finderr.example.com` | `A` | `192.168.1.10` (Caddy) |
   | `finderr.example.com` | `AAAA` | `2001:db8:1::10` (Caddy) |

   Pointing this at the finderr container's own port bypasses the proxy, which means no TLS,
   which means [mixed content](#mixed-content) and no LAN path.
3. If your UniFi gateway has **IPv6 enabled with a delegated prefix**, your server already has
   a globally routable v6 address and no port forwarding is needed for it at all -- open the
   port in **Settings → Security → Firewall Rules** for the IPv6 zone and add it to
   `FINDERR_STREAM_ENDPOINTS`. This is the single biggest win available here: a real
   end-to-end route with no NAT in it.

Verify from a client on the LAN:

```bash
dig +short finderr.example.com          # should be your LAN proxy address
curl -sI https://finderr.example.com/api/health | head -1
```

### Cloudflare

If your public name is proxied through Cloudflare (the orange cloud), understand what that
means for playback: **every segment goes through Cloudflare**. That is fine for correctness
and it is a lot of transit for video.

> [!CAUTION]
> Serving video through Cloudflare's proxy may breach section 2.8 of their Terms of Service,
> which restricts the CDN to primarily web content. This is your call to make, not finderr's.
> The recommendation below avoids the question entirely.

**The recommended shape: proxy the app, but let media go direct.** Point one hostname at
Cloudflare for the app, and advertise a second, DNS-only hostname for streaming:

| Record | Type | Value | Proxy |
|---|---|---|---|
| `finderr` | `A` | `203.0.113.10` | Proxied (orange) |
| `stream.finderr` | `A` | `203.0.113.10` | **DNS only (grey)** |
| `stream.finderr` | `AAAA` | `2001:db8:1::10` | **DNS only (grey)** |

```yaml
environment:
  FINDERR_STREAM_ENDPOINTS: "lan=https://finderr.lan,wan=https://stream.finderr.example.com"
  FINDERR_AUTH_ORIGINS: "https://finderr.example.com"
```

The page loads at the proxied name; segments are fetched from the grey-clouded one. The stream
token is what makes this work across the two origins, and CORS is already allowed because the
stream name is an advertised endpoint.

A grey-clouded record exposes your origin IP. If that matters to you, keep everything proxied
and accept the transit, or drop the public path entirely in favour of a VPN.

**If you do proxy media**, two settings are not optional:

- **Cache Rules**: `Bypass cache` for `/api/play/*`. Segments are per-session and a cached one
  served to another viewer is somebody else's film.
- **Configuration Rules**: disable **Rocket Loader** and any HTML/JS minification on
  `/api/play/*`, which have no business touching an `.m3u8`.

**Cloudflare Access in front of finderr will break playback**, because the player's requests
carry a stream token rather than an Access cookie for a cross-origin fetch. If you use Access,
put it on the app hostname only and leave the stream hostname to finderr's own token.

### Tailscale or WireGuard

The quietest answer, and worth considering before any of the public-hostname work above: put
the whole thing on an overlay network and advertise the overlay address.

```yaml
environment:
  FINDERR_STREAM_ENDPOINTS: "lan=192.168.1.20,lan=100.100.20.30"
```

Tailscale's `100.64/10` addresses are recognised as LAN, so they rank alongside your real
local addresses. A viewer on the tailnet gets the overlay path, a viewer physically on the LAN
gets the direct one, and neither needs a port open to the internet.

---

## UPnP: asking the router yourself

Off by default. Turning it on makes finderr ask your gateway, over UPnP IGD, to forward its
port -- and then advertise the external address the gateway reports.

```yaml
environment:
  FINDERR_UPNP: "true"
```

> [!CAUTION]
> **This opens a port on your router.** That is a thing worth deciding rather than inheriting,
> which is why it is off. If a reverse proxy already terminates a public name for you, this
> buys nothing and you should leave it alone.

Requirements and behaviour:

- The container must be able to reach the gateway by **UDP multicast**, which in practice
  means `network_mode: host`. A bridge network does not carry SSDP.
- It needs a private IPv4 address to forward to. IGD v1 has no IPv6 mapping at all, and a
  global IPv6 address needs no forwarding anyway.
- The mapping is requested with a **one-hour lease and refreshed every thirty minutes**, so a
  finderr that dies leaves a mapping the router forgets within the hour rather than a
  permanent hole. Routers that only support permanent mappings get one.
- **Every failure is a log line and nothing else.** No gateway, IGD disabled, a refused
  mapping, a conflicting one -- all of them leave your other endpoints working exactly as
  before. Grep the log for `upnp:`.

---

## Troubleshooting

**Playback works but always over the WAN.** Either the LAN candidate is not being advertised
(check `/api/play/endpoints`) or it is losing the race. The most common cause by far is
[mixed content](#mixed-content): an HTTPS page cannot fetch a plain-http segment, so the LAN
probe fails silently. Put TLS on the LAN name.

**Nothing plays at all after adding endpoints.** The race falls back to the page's own origin
when nothing answers, so this should not happen -- if it does, the browser console will name
the failing request. A CORS error means the origin the page is loaded at is not in
`FINDERR_AUTH_ORIGINS` and not an advertised endpoint.

**A container-internal address is being advertised.** That is bridged Docker networking; see
[Docker networking](#docker-networking). Static entries are merged ahead of discovered ones,
so naming the real address is the fix, not a workaround.

**`/api/play/endpoints` is empty.** Nothing is configured and no non-loopback interface was
found. Playback still works from the page's origin.

**Only the app is on IPv6, or only the segments.** They are separate: the app's address comes
from DNS and your proxy, the segment address from this list. Advertising a v6 endpoint is what
makes segments take v6.
