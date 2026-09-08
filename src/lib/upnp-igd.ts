/**
 * Asking the household router to let the world in, and to say what the world sees.
 *
 * The third and least reliable source feeding `stream-endpoints.ts`: find an Internet Gateway
 * Device by SSDP, ask it for a port mapping, and learn the external address it hands back.
 *
 * > [!CAUTION] EVERY FAILURE HERE IS SILENT, AND THAT IS THE DESIGN
 * > IGD needs the gateway reachable from inside the container -- host networking, or an
 * > explicit route -- and a great many networks disable it outright as a matter of policy.
 * > So the ONLY contract this module offers is: it answers a mapping or it answers null, and
 * > it never throws into a caller. A failed probe is a log line. A stream that would have
 * > worked over the LAN must not stop working because a router said no.
 *
 * > [!IMPORTANT] THIS OPENS A PORT ON SOMEBODY'S ROUTER, so it is OFF unless asked for
 * > `media.upnp` defaults to false and nothing here runs until an operator sets it. An
 * > automatic hole-punch is the kind of thing a program should be asked to do rather than
 * > decide to do, however convenient -- and finderr already reaches the internet through a
 * > reverse proxy in the deployment it actually ships to.
 *
 * ## Why everything is injected
 *
 * `discover` is a UDP multicast and `fetch` talks SOAP to whatever answered. Both are the
 * network, and a module that reached for them directly could only be tested by having a
 * router in the room. The transport is one interface with two methods, so the whole protocol
 * -- discovery, description parsing, the two SOAP calls, the lease fallback -- is exercised
 * against literals in milliseconds.
 */

/** How long to wait for gateways to answer an M-SEARCH. The spec's own MX is 2 seconds. */
const DISCOVER_TIMEOUT_MS = 2_000;

/** How long a mapping is asked to live. Refreshed while we run, gone within the hour if we die. */
export const LEASE_SEC = 3_600;

/** Everything a mapping request is allowed to spend on one SOAP call. */
const SOAP_TIMEOUT_MS = 5_000;

/**
 * The device SSDP is asked for, and the two services that can actually do the mapping.
 *
 * A gateway exposes `WANIPConnection` for a routed uplink and `WANPPPConnection` for a PPPoE
 * one, and which it has is a property of the ISP rather than of the router. Both take exactly
 * the same actions, so they are tried in order and the first match wins.
 */
const IGD_SEARCH_TARGET = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";
const CONNECTION_SERVICES = [
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

/**
 * `OnlyPermanentLeasesSupported`. A great many consumer routers refuse any non-zero
 * `NewLeaseDuration`, and the refusal is this specific code rather than a generic failure --
 * which is what makes retrying with a permanent mapping a correct response rather than a
 * guess. See `addMapping`.
 */
const ERR_ONLY_PERMANENT_LEASES = "725";

/** The network, in the two shapes this protocol needs. Injected; see the module header. */
export interface IgdTransport {
  /**
   * SSDP M-SEARCH: multicast the search target and collect every responder's `LOCATION`.
   *
   * Resolves to an empty list when nothing answers, which is the ordinary case on a network
   * with IGD switched off. It never rejects.
   */
  discover(target: string, timeoutMs: number): Promise<string[]>;
  /**
   * The two calls this protocol makes: read a description, POST a SOAP envelope.
   *
   * Narrower than `typeof fetch` on purpose -- a fake in a test should have to implement what
   * is USED rather than the whole platform signature, and the global's newer members
   * (`preconnect`) have nothing to do with talking to a router.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** The one address on this machine the gateway should forward to. */
export interface MappingRequest {
  /** The port to open externally and to forward to. The same number on both sides. */
  port: number;
  /** Our own LAN address, as the gateway must be told to reach it. */
  internalIp: string;
  /** What shows up in the router's port-forwarding table. */
  description: string;
}

export interface Mapping {
  /** The address the gateway says the world sees. */
  externalIp: string;
  externalPort: number;
  /** The control URL that granted it, so a refresh or a delete goes back to the same service. */
  controlUrl: string;
  serviceType: string;
  /** Seconds the mapping was granted for. 0 means the gateway would only make it permanent. */
  leaseSec: number;
}

/** One control endpoint: where to POST, and which service to name in the envelope. */
interface ControlPoint {
  controlUrl: string;
  serviceType: string;
}

type Log = (m: string) => void;

/**
 * Find a gateway, open the port, and learn the external address.
 *
 * Null for every failure -- no gateway, an unparseable description, a refused mapping, a
 * gateway that reports a private external address because it is itself behind carrier NAT.
 * The caller logs and carries on with the endpoints it already had.
 */
export async function mapPort(
  req: MappingRequest,
  transport: IgdTransport,
  log: Log = () => {},
): Promise<Mapping | null> {
  const locations = await transport.discover(IGD_SEARCH_TARGET, DISCOVER_TIMEOUT_MS).catch(() => []);
  if (locations.length === 0) {
    log("upnp: no gateway answered the search");
    return null;
  }

  for (const location of locations) {
    const control = await describeGateway(location, transport, log);
    if (!control) continue;
    const mapping = await claim(control, req, transport, log);
    if (mapping) return mapping;
  }
  log("upnp: a gateway answered but none would map the port");
  return null;
}

/**
 * Give a mapping back.
 *
 * Best-effort by construction: if the process is being killed there may be no time, and if
 * the router has already forgotten the mapping there is nothing to delete. Either way the
 * lease expires on its own, which is why the lease exists.
 */
export async function unmapPort(mapping: Mapping, transport: IgdTransport, log: Log = () => {}): Promise<void> {
  const ok = await soap(
    { controlUrl: mapping.controlUrl, serviceType: mapping.serviceType },
    "DeletePortMapping",
    { NewRemoteHost: "", NewExternalPort: String(mapping.externalPort), NewProtocol: "TCP" },
    transport,
  );
  log(ok.ok ? "upnp: mapping released" : `upnp: could not release the mapping (${ok.error})`);
}

/**
 * Fetch a gateway's device description and find the service that maps ports.
 *
 * The description nests `deviceList`/`serviceList` several levels deep and the depth varies
 * by vendor, so the search is a recursive walk for any object carrying both a `serviceType`
 * and a `controlURL` rather than a path spelled out from the root. A path would be a guess
 * about somebody's firmware.
 */
async function describeGateway(
  location: string,
  transport: IgdTransport,
  log: Log,
): Promise<ControlPoint | null> {
  let xml: string;
  try {
    const res = await transport.fetch(location, { signal: AbortSignal.timeout(SOAP_TIMEOUT_MS) });
    if (!res.ok) return null;
    xml = await res.text();
  } catch (err) {
    log(`upnp: could not read the device description: ${(err as Error).message}`);
    return null;
  }

  let services: { serviceType: string; controlURL: string }[];
  try {
    services = findServices(Bun.XML.parse(xml));
  } catch (err) {
    log(`upnp: device description did not parse: ${(err as Error).message}`);
    return null;
  }

  for (const wanted of CONNECTION_SERVICES) {
    const found = services.find((s) => s.serviceType === wanted);
    // The control URL is RELATIVE in most descriptions, and relative to the LOCATION rather
    // than to any base we chose -- resolving it against anything else lands on a 404 that
    // looks like a router refusing us.
    if (found) return { controlUrl: new URL(found.controlURL, location).href, serviceType: wanted };
  }
  return null;
}

/** Every `{serviceType, controlURL}` pair anywhere in a parsed description, at any depth. */
function findServices(node: unknown): { serviceType: string; controlURL: string }[] {
  if (Array.isArray(node)) return node.flatMap(findServices);
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const found: { serviceType: string; controlURL: string }[] = [];
  if (typeof record.serviceType === "string" && typeof record.controlURL === "string") {
    found.push({ serviceType: record.serviceType, controlURL: record.controlURL });
  }
  for (const value of Object.values(record)) found.push(...findServices(value));
  return found;
}

/** Add the mapping, then ask what the world sees. Both must succeed for a mapping to exist. */
async function claim(
  control: ControlPoint,
  req: MappingRequest,
  transport: IgdTransport,
  log: Log,
): Promise<Mapping | null> {
  const leaseSec = await addMapping(control, req, transport, log);
  if (leaseSec === null) return null;

  const external = await soap(control, "GetExternalIPAddress", {}, transport);
  const externalIp = external.ok ? external.values.NewExternalIPAddress : undefined;
  if (!externalIp) {
    log(`upnp: mapped the port but the gateway would not state an external address`);
    return null;
  }
  log(`upnp: mapped port ${req.port} at ${externalIp}, lease ${leaseSec}s`);
  return { externalIp, externalPort: req.port, controlUrl: control.controlUrl, serviceType: control.serviceType, leaseSec };
}

/**
 * `AddPortMapping`, with the one retry that is not a guess.
 *
 * A router answering `725 OnlyPermanentLeasesSupported` is telling us exactly what it wants,
 * so asking again with `NewLeaseDuration=0` is following an instruction rather than hoping.
 * Every other error is final -- retrying a `718 ConflictInMappingEntry` would just take
 * somebody else's mapping.
 *
 * Returns the lease actually granted, or null.
 */
async function addMapping(
  control: ControlPoint,
  req: MappingRequest,
  transport: IgdTransport,
  log: Log,
): Promise<number | null> {
  const args = (leaseSec: number) => ({
    NewRemoteHost: "",
    NewExternalPort: String(req.port),
    NewProtocol: "TCP",
    NewInternalPort: String(req.port),
    NewInternalClient: req.internalIp,
    NewEnabled: "1",
    NewPortMappingDescription: req.description,
    NewLeaseDuration: String(leaseSec),
  });

  const leased = await soap(control, "AddPortMapping", args(LEASE_SEC), transport);
  if (leased.ok) return LEASE_SEC;
  if (leased.error !== ERR_ONLY_PERMANENT_LEASES) {
    log(`upnp: gateway refused the mapping (${leased.error})`);
    return null;
  }

  const permanent = await soap(control, "AddPortMapping", args(0), transport);
  if (permanent.ok) return 0;
  log(`upnp: gateway refused a permanent mapping too (${permanent.error})`);
  return null;
}

type SoapResult = { ok: true; values: Record<string, string> } | { ok: false; error: string };

/**
 * One SOAP action against one control URL.
 *
 * The envelope is BUILT rather than templated from caller text: argument values are escaped
 * here, in the one place that writes XML, so a description containing an ampersand produces a
 * valid envelope instead of a parse error at the router.
 *
 * A UPnP fault arrives as HTTP 500 with the interesting part -- `errorCode` -- inside the
 * body, so a non-ok response is READ rather than discarded. That code is the whole reason the
 * lease fallback above can be a rule instead of a retry loop.
 */
async function soap(
  control: ControlPoint,
  action: string,
  args: Record<string, string>,
  transport: IgdTransport,
): Promise<SoapResult> {
  const body =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${control.serviceType}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join("") +
    `</u:${action}></s:Body></s:Envelope>`;

  let text: string;
  let httpOk: boolean;
  try {
    const res = await transport.fetch(control.controlUrl, {
      method: "POST",
      headers: {
        "content-type": 'text/xml; charset="utf-8"',
        soapaction: `"${control.serviceType}#${action}"`,
      },
      body,
      signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
    });
    httpOk = res.ok;
    text = await res.text();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  let parsed: unknown;
  try {
    parsed = Bun.XML.parse(text);
  } catch {
    return { ok: false, error: httpOk ? "unparseable response" : "unparseable fault" };
  }
  if (!httpOk) return { ok: false, error: findFirst(parsed, "errorCode") ?? "unknown fault" };
  return { ok: true, values: collectStrings(parsed) };
}

/** The first value of `key` anywhere in a parsed document, as a string. */
function findFirst(node: unknown, key: string): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findFirst(child, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  const own = record[key];
  if (typeof own === "string" || typeof own === "number") return String(own);
  for (const value of Object.values(record)) {
    const hit = findFirst(value, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Every scalar leaf in a parsed response, keyed by its own tag name.
 *
 * Flat rather than shaped, because a SOAP response body is a single element of `NewFoo`
 * children and the envelope wrapping it is noise -- walking to the right depth would be one
 * more thing to be wrong about across firmware versions.
 */
function collectStrings(node: unknown, into: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, into);
    return into;
  }
  if (node === null || typeof node !== "object") return into;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") {
      if (!(key in into)) into[key] = String(value);
    } else collectStrings(value, into);
  }
  return into;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Run `fn` every `ms` and hand back a cancel. Injected, so a test needs no wall clock. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const timerSchedule: Schedule = (fn, ms) => {
  // `unref` so a mapping refresh never keeps a process alive that is otherwise finished.
  const handle = setInterval(fn, ms);
  handle.unref?.();
  return () => clearInterval(handle);
};

export interface KeepMappedOpts extends MappingRequest {
  transport?: IgdTransport;
  schedule?: Schedule;
  log?: Log;
  /** Called with the address the world sees, every time it is learned or re-learned. */
  onMapped: (externalIp: string, externalPort: number) => void;
  /** Called when there is no mapping to advertise -- the first attempt failed, or a refresh did. */
  onLost: () => void;
}

/** A live mapping's handle: the one thing a caller can do to it is give it back. */
export interface MappingHandle {
  /** Cancel the refresh and ask the gateway to drop the mapping. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Hold a port mapping open for as long as this process runs, and keep the advertised address
 * in step with it.
 *
 * **Refreshed at HALF the lease**, so a single missed refresh is recoverable rather than an
 * outage: at 3,600 seconds the mapping is renewed every 30 minutes and would have to fail
 * twice in a row to lapse. A gateway that would only grant a permanent mapping gets no
 * refresh at all, because there is nothing to renew.
 *
 * > [!IMPORTANT] SHUTDOWN RELIES ON THE LEASE, NOT ON A HANDLER, and that is deliberate
 * > `unmapPort` is a network round trip, and neither an `exit` handler nor a SIGKILL leaves
 * > time for one -- so a cleanup hook here would be a promise the process cannot keep. The
 * > lease IS the cleanup: a finderr that dies leaves a mapping that the router forgets within
 * > the hour. `stop()` exists for the caller that can afford to wait.
 *
 * Never throws. A total failure calls `onLost` and returns a handle whose `stop` does
 * nothing, so the caller has one code path rather than two.
 */
export function keepPortMapped(opts: KeepMappedOpts): MappingHandle {
  const transport = opts.transport ?? udpTransport;
  const schedule = opts.schedule ?? timerSchedule;
  const log = opts.log ?? (() => {});
  const request: MappingRequest = {
    port: opts.port,
    internalIp: opts.internalIp,
    description: opts.description,
  };

  let current: Mapping | null = null;
  let cancelRefresh: (() => void) | null = null;
  let stopped = false;

  const attempt = async (): Promise<void> => {
    const mapping = await mapPort(request, transport, log).catch(() => null);
    if (stopped) return;
    current = mapping;
    if (mapping) opts.onMapped(mapping.externalIp, mapping.externalPort);
    else opts.onLost();
    return;
  };

  void attempt().then(() => {
    if (stopped || !current || current.leaseSec === 0) return;
    cancelRefresh = schedule(() => void attempt(), (current.leaseSec / 2) * 1000);
  });

  return {
    async stop() {
      stopped = true;
      cancelRefresh?.();
      cancelRefresh = null;
      const held = current;
      current = null;
      if (held) await unmapPort(held, transport, log);
    },
  };
}

/**
 * The real transport: SSDP over UDP multicast, and `fetch`.
 *
 * `Bun.udpSocket` is the builtin, so there is no dependency here. The socket binds an
 * ephemeral port and sends to `239.255.255.250:1900`; every gateway on the segment answers
 * with a unicast datagram carrying a `LOCATION` header. There is no "done" event in SSDP --
 * a search is answered by however many devices feel like answering -- so the collection is
 * bounded by the timeout, which is what `MX` in the request tells devices to spread over.
 */
export const udpTransport: IgdTransport = {
  fetch: (url, init) => fetch(url, init),
  async discover(target, timeoutMs) {
    const locations = new Set<string>();
    const message =
      `M-SEARCH * HTTP/1.1\r\n` +
      `HOST: 239.255.255.250:1900\r\n` +
      `MAN: "ssdp:discover"\r\n` +
      `MX: ${Math.max(1, Math.round(timeoutMs / 1000))}\r\n` +
      `ST: ${target}\r\n\r\n`;

    const socket = await Bun.udpSocket({
      socket: {
        data(_socket, data) {
          const location = ssdpLocation(data.toString());
          if (location) locations.add(location);
        },
      },
    });
    try {
      socket.send(message, 1900, "239.255.255.250");
      await Bun.sleep(timeoutMs);
    } finally {
      socket.close();
    }
    return [...locations];
  },
};

/** The `LOCATION` header of an SSDP response. Header names are case-insensitive in SSDP. */
function ssdpLocation(response: string): string | null {
  for (const line of response.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "location") continue;
    const value = line.slice(colon + 1).trim();
    // A responder controls this string entirely, so it is parsed rather than trusted: an
    // absolute http(s) URL or nothing.
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }
  return null;
}
