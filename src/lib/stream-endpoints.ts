/**
 * Every address this server can be reached at, so a player can pick one and change its mind.
 *
 * Plex advertises a candidate list and picks ONE for the whole session; when that path dies
 * the session dies with it. **HLS segments are independent GETs**, so a client that knows the
 * list can retarget the NEXT segment at a different address -- a dead path then costs one
 * segment retry rather than the playback. This module owns the list; `web/src/lib/
 * stream-endpoints.ts` owns choosing from it.
 *
 * ## Three sources, and only one of them is reliable
 *
 * 1. **Static, from config.** `FINDERR_STREAM_ENDPOINTS`. This is the one that always works
 *    and the one an operator should set; everything below is convenience on top of it.
 * 2. **The container's own interfaces.** Cheap and it is what lets a LAN client take the LAN
 *    path instead of hairpinning out through the WAN and back.
 * 3. **UPnP IGD** (`upnp-igd.ts`), which arrives LATE and asynchronously, learns an external
 *    address and hands it here through `learnExternal`. It must degrade to nothing: plenty of
 *    networks disable IGD, and a failed probe is a log line rather than a failed stream.
 *
 * > [!IMPORTANT] THIS IS ADVERTISEMENT, NOT ROUTING. Nothing here proves an address works.
 * > A container cannot know which of its addresses a particular browser can reach -- the
 * > browser is on the other side of a NAT, a VPN or a firewall we cannot see. So the list is
 * > ORDERED by how likely each candidate is to be the cheap path, and the client settles the
 * > question the only way it can be settled: by trying them. An address that nothing can
 * > reach costs one failed probe, which is why an optimistic list is safe.
 *
 * ## Multi-ADDRESS, not multi-HOST, and the difference matters
 *
 * Every candidate here is another way to reach THIS process. ffmpeg writes into one box's
 * session directory, so a second box has nothing to serve; spreading a session across hosts
 * needs shared session state and is a different, much larger problem. Adding a peer's address
 * to this list would produce 404s, not resilience.
 */

import { LIMITS } from "./input-guards";

/** Which address family a candidate is pinned to, or null when a name decides at resolve time. */
export type AddressFamily = "v4" | "v6";

/** Whether a candidate is expected to be cheap-and-local or to leave the building. */
export type EndpointKind = "lan" | "wan";

/** Which of the three sources produced a candidate. Reported, and used to break rank ties. */
export type EndpointSource = "static" | "interface" | "upnp";

export interface StreamEndpoint {
  /**
   * An absolute origin with no path and no trailing slash: `https://finderr.frst.dev`,
   * `http://172.20.7.12:7979`, `http://[fd00::12]:7979`.
   *
   * An ORIGIN rather than a host/port pair because that is what a client concatenates a path
   * onto, and splitting it would mean re-assembling it -- including the bracket rule for IPv6
   * literals -- at every reader.
   */
  base: string;
  /**
   * Null when `base` names a HOST rather than a literal address.
   *
   * A dual-stack name has both families and the browser's own resolver picks, so claiming one
   * would be a guess about somebody else's DNS. Null means "whatever the resolver decides",
   * and the rank treats it as neither preferred nor penalised.
   */
  family: AddressFamily | null;
  kind: EndpointKind;
  source: EndpointSource;
}

/**
 * Parse `FINDERR_STREAM_ENDPOINTS` into candidates.
 *
 * Comma separated, one address each, and **the simple case is a bare list**:
 *
 * ```
 * FINDERR_STREAM_ENDPOINTS=192.168.1.20,2001:db8::20,finderr.example.com
 * ```
 *
 * Everything an entry does not state is filled in from something already known rather than
 * asked for again, which is what keeps that line typeable:
 *
 * | left out | filled in with | why it is safe to derive |
 * |---|---|---|
 * | scheme | `http` | the LAN case, and an operator writing `https` writes the scheme |
 * | port | this server's own | one process, one listening port, stated once in the config |
 * | family | the literal, when there is one | `[..]` is v6, a dotted quad is v4, a NAME is neither |
 * | `lan`/`wan` | private literal is `lan`, anything else `wan` | the same RFC 1918/4193 rule the interface scan uses |
 *
 * The one thing that cannot be derived is the locality of a NAME -- `finderr.example.com` may
 * be the outside name or a LAN short name, and DNS does not say which. It defaults to `wan`,
 * which costs at worst one place in the race order, and `lan=` in front of an entry overrides
 * it:
 *
 * ```
 * FINDERR_STREAM_ENDPOINTS=lan=finderr.lan,wan=https://finderr.example.com
 * ```
 *
 * A malformed entry is DROPPED rather than throwing, exactly as `parseVolumes` drops one: a
 * typo in one candidate must not stop the server booting, and a candidate that is silently
 * absent degrades to the remaining ones.
 *
 * @param defaultPort The port this process listens on, used for any entry that omits one.
 */
export function parseStaticEndpoints(spec: string | undefined | null, defaultPort: number): StreamEndpoint[] {
  if (!spec) return [];
  const out: StreamEndpoint[] = [];
  for (const entry of spec.split(",")) {
    const { kind, address } = splitKind(entry);
    if (kind === "bad") continue;
    const base = tidyOrigin(completeOrigin(address, defaultPort));
    if (!base) continue;
    const family = familyOfOrigin(base);
    out.push({ base, family, kind: kind ?? derivedKind(base, family), source: "static" });
  }
  return out;
}

/**
 * Split an optional `lan=`/`wan=` prefix off an entry.
 *
 * `bad` for a prefix that is neither, rather than treating it as part of the address: an
 * operator who typed `local=` meant to say something about locality, and silently streaming
 * from a host called `local` would be a stranger failure than dropping the entry.
 */
function splitKind(entry: string): { kind: EndpointKind | null | "bad"; address: string } {
  const eq = entry.indexOf("=");
  if (eq <= 0) return { kind: null, address: entry };
  const prefix = entry.slice(0, eq).trim().toLowerCase();
  if (prefix !== "lan" && prefix !== "wan") return { kind: "bad", address: entry };
  return { kind: prefix, address: entry.slice(eq + 1) };
}

/**
 * Fill in the scheme and port an entry left out, so `192.168.1.20` is a usable origin.
 *
 * The bracket rule is the fiddly part and it is why this is a function rather than string
 * concatenation at the call site: a bare IPv6 literal has colons of its own, so `host:port`
 * is ambiguous until the host is bracketed, and `2001:db8::20` with a port appended parses as
 * a completely different thing.
 */
function completeOrigin(raw: string, defaultPort: number): string {
  const s = raw.trim();
  if (s === "") return "";
  if (/^https?:\/\//i.test(s)) return s;
  // A bare IPv6 literal: three or more colons and no bracket. Two colons could be `host:port`.
  const bare6 = !s.includes("[") && (s.match(/:/g)?.length ?? 0) >= 2;
  const host = bare6 ? `[${s}]` : s;
  const hasPort = /:\d+$/.test(host);
  return `http://${host}${hasPort ? "" : `:${defaultPort}`}`;
}

/**
 * Locality from the address alone: a private literal is on the LAN, everything else is not.
 *
 * The SAME rule `interfaceEndpoints` applies to a discovered address, deliberately -- an
 * operator writing `10.0.0.5` and a scan finding `10.0.0.5` must classify it the same way, or
 * the rank of a candidate would depend on which source happened to produce it. A NAME has no
 * literal to test, so it falls to `wan`; see `parseStaticEndpoints` for why that is the safe
 * default and how to override it.
 */
function derivedKind(base: string, family: AddressFamily | null): EndpointKind {
  if (family === null) return "wan";
  const host = new URL(base).hostname;
  const address = family === "v6" ? host.replace(/^\[|\]$/g, "") : host;
  return isPrivate(address, family) ? "lan" : "wan";
}

/**
 * An origin string, or "" for anything that is not one.
 *
 * `URL` does the parsing rather than a regular expression, because it is the same parser the
 * browser will use on the other end -- a candidate this accepts and a browser rejects would
 * be a candidate that fails only in production. `origin` then hands back the canonical form
 * with the default port elided and an IPv6 literal correctly bracketed.
 */
function tidyOrigin(raw: string): string {
  const s = raw.trim();
  if (s.length === 0 || s.length > LIMITS.url) return "";
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return "";
  }
  // Only the two schemes a browser will fetch media over. `file:`, `data:` and the rest
  // parse perfectly well and would advertise a candidate no player can use.
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.hostname === "") return "";
  return url.origin;
}

/** IPv4 dotted quad, with every octet in range -- `999.1.1.1` is not an address. */
function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * The family a candidate is pinned to, from its host alone.
 *
 * `URL` brackets an IPv6 literal and leaves everything else bare, so the bracket IS the
 * discriminator and there is no second parse to get wrong.
 */
export function familyOfOrigin(base: string): AddressFamily | null {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return null;
  }
  if (host.startsWith("[")) return "v6";
  return isIpv4Literal(host) ? "v4" : null;
}

/** One address as `node:os` reports it. The two fields we read, so a test needs no machine. */
export interface HostAddress {
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

/**
 * The addresses of this container that are worth telling a client about.
 *
 * Three exclusions, each for a reason a client would otherwise hit:
 *
 * - **Loopback**, because the page is already being served from an origin that reaches this
 *   process, so a `127.0.0.1` candidate is either that same origin or a different machine's
 *   idea of itself.
 * - **Link-local** (`169.254.0.0/16`, `fe80::/10`), because an IPv6 link-local address is
 *   meaningless without a zone index a URL cannot carry, and a browser will not dial one.
 * - **Anything that is not an address**, which is what a container with no network at all
 *   reports.
 *
 * The port is OURS rather than the interface's: an interface has no port, and the only port
 * this process listens on is the one it was configured with.
 */
export function interfaceEndpoints(port: number, addresses: readonly HostAddress[]): StreamEndpoint[] {
  const out: StreamEndpoint[] = [];
  for (const a of addresses) {
    if (a.internal) continue;
    const address = stripZone(a.address);
    if (isLinkLocal(address)) continue;
    const family: AddressFamily = a.family === "IPv6" ? "v6" : "v4";
    const host = family === "v6" ? `[${address}]` : address;
    const base = tidyOrigin(`http://${host}:${port}`);
    if (!base) continue;
    out.push({ base, family, kind: isPrivate(address, family) ? "lan" : "wan", source: "interface" });
  }
  return out;
}

/** `fe80::1%en0` -- the zone index is a local name and means nothing to anybody else. */
function stripZone(address: string): string {
  const pct = address.indexOf("%");
  return pct === -1 ? address : address.slice(0, pct);
}

function isLinkLocal(address: string): boolean {
  const a = address.toLowerCase();
  if (a.startsWith("169.254.")) return true;
  // fe80:: through febf:: -- the whole /10, not just the fe80 that is usually written.
  return /^fe[89ab][0-9a-f]:/.test(a);
}

/**
 * Whether an address is one only the local network can reach.
 *
 * This decides `lan` vs `wan`, which decides rank, so it is worth being exact: RFC 1918 for
 * v4, RFC 6598 carrier-grade NAT (a client behind the same CGNAT is not on our LAN, but the
 * address is equally unroutable from the internet, so advertising it as `wan` would be a
 * lie), and RFC 4193 unique-local for v6. A global IPv6 address on a container is genuinely
 * reachable from outside, which is the whole appeal of v6 here.
 */
function isPrivate(address: string, family: AddressFamily): boolean {
  if (family === "v6") return /^f[cd][0-9a-f]{2}:/i.test(address);
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * The private IPv4 address a gateway should be told to forward to, or null.
 *
 * **IPv4 only, and that is the protocol rather than a simplification.** IGD version 1 has no
 * IPv6 port mapping at all -- the v6 equivalent is `WANIPv6FirewallControl`, a different
 * service with different actions -- and a globally routable IPv6 address needs no mapping in
 * the first place. Null means there is nothing to ask for, and the caller skips the probe.
 */
export function primaryLanAddress(addresses: readonly HostAddress[]): string | null {
  for (const a of addresses) {
    if (a.internal || a.family !== "IPv4") continue;
    const address = stripZone(a.address);
    if (!isLinkLocal(address) && isPrivate(address, "v4")) return address;
  }
  return null;
}

/**
 * How likely a candidate is to be the cheap path, lowest first.
 *
 * **Locality dominates**, because the difference between a LAN hop and a round trip through
 * the WAN is orders of magnitude and the difference between v4 and v6 is not. Within a kind
 * v6 comes first -- it is the one with no NAT in the way, which is what makes it likelier to
 * survive -- and a name sits between the two literals: it may resolve to either, so it is
 * neither the preferred case nor the fallback.
 *
 * The source is the last tie-break rather than the first, deliberately: a static entry is
 * more TRUSTWORTHY than a discovered one but it is not automatically CLOSER, and ranking a
 * static WAN address above a discovered LAN one would send every local client out through the
 * internet.
 */
function rankOf(e: StreamEndpoint): number {
  const kind = e.kind === "lan" ? 0 : 1;
  const family = e.family === "v6" ? 0 : e.family === null ? 1 : 2;
  const source = e.source === "static" ? 0 : e.source === "interface" ? 1 : 2;
  return kind * 100 + family * 10 + source;
}

/**
 * Every candidate, deduplicated by origin and ordered best-first.
 *
 * **The FIRST occurrence of an origin wins**, and the caller supplies the lists in trust
 * order, so an operator's `lan=http://nas:7979` is not overwritten by an interface scan that
 * happened to produce the same origin with a worse `kind`. Sorting is stable in every engine
 * that matters and the final tie-break is the origin itself, so the order is total -- two
 * boots with the same inputs advertise the same list, which is what makes a client's pinned
 * choice mean something across a reload.
 */
export function mergeEndpoints(...lists: readonly StreamEndpoint[][]): StreamEndpoint[] {
  const byBase = new Map<string, StreamEndpoint>();
  for (const list of lists) {
    for (const e of list) if (!byBase.has(e.base)) byBase.set(e.base, e);
  }
  return [...byBase.values()].sort((a, b) => rankOf(a) - rankOf(b) || a.base.localeCompare(b.base));
}

/** What a directory needs to know about itself. Injected, so a test needs no real machine. */
export interface DirectoryOpts {
  /** The raw `FINDERR_STREAM_ENDPOINTS` value. */
  staticSpec?: string | null;
  /** The port this process listens on. Interfaces have no port of their own. */
  port: number;
  /** `os.networkInterfaces()`, flattened. Absent means do not scan. */
  addresses?: () => readonly HostAddress[];
}

/**
 * The advertised candidate list, owned in one place and read on every request.
 *
 * A CLASS rather than a function because the set is not constant: UPnP answers seconds after
 * boot, if it answers at all, and something has to hold the "before" and the "after". The
 * two static sources are re-derived on every `list()` rather than cached -- an interface scan
 * is a memory read, and caching it would advertise a stale address after a container's
 * network is reconfigured.
 */
export class StreamEndpointDirectory {
  private readonly fromStatic: StreamEndpoint[];
  private external: StreamEndpoint | null = null;

  constructor(private readonly opts: DirectoryOpts) {
    this.fromStatic = parseStaticEndpoints(opts.staticSpec, opts.port);
  }

  /** Every candidate, best first. Cheap enough to call per request. */
  list(): StreamEndpoint[] {
    const local = this.opts.addresses ? interfaceEndpoints(this.opts.port, this.opts.addresses()) : [];
    return mergeEndpoints(this.fromStatic, local, this.external ? [this.external] : []);
  }

  /**
   * Record the address a gateway says the world sees us at.
   *
   * Always `wan` and always `upnp`-sourced, so it ranks below everything an operator stated
   * and below anything local -- which is right, since it is the one candidate whose existence
   * depends on a router still honouring a mapping it may drop at any time.
   *
   * Idempotent: a refresh that learns the same address changes nothing, and one that learns a
   * new address replaces the old rather than accumulating a list of dead ones.
   */
  learnExternal(ip: string, port: number, scheme: "http" | "https" = "http"): void {
    const family = ip.includes(":") ? "v6" : "v4";
    const host = family === "v6" ? `[${ip}]` : ip;
    const base = tidyOrigin(`${scheme}://${host}:${port}`);
    this.external = base ? { base, family, kind: "wan", source: "upnp" } : null;
  }

  /** Forget the external address, for when a mapping is dropped or a refresh fails. */
  forgetExternal(): void {
    this.external = null;
  }
}
