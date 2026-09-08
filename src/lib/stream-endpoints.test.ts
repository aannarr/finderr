/**
 * The advertised candidate list: what an operator can type, what a scan may add, and the
 * order the two arrive in.
 *
 * The property worth the most here is the ORDER, because it is what the client races in. A
 * list that put a WAN name ahead of a LAN address would send every local viewer out through
 * the internet and back, and nothing downstream could tell that had happened -- playback
 * would simply be worse.
 */

import { describe, expect, test } from "bun:test";
import {
  familyOfOrigin,
  type HostAddress,
  interfaceEndpoints,
  mergeEndpoints,
  parseStaticEndpoints,
  primaryLanAddress,
  type StreamEndpoint,
  StreamEndpointDirectory,
} from "./stream-endpoints";

const PORT = 7979;
const bases = (list: StreamEndpoint[]) => list.map((e) => e.base);

describe("what an operator can type", () => {
  /** THE SIMPLE CASE IS A BARE LIST. Everything not stated is filled in from what is known. */
  test("a bare IPv4 becomes an http origin on this server's own port", () => {
    expect(parseStaticEndpoints("192.168.1.20", PORT)).toEqual([
      { base: "http://192.168.1.20:7979", family: "v4", kind: "lan", source: "static" },
    ]);
  });

  /**
   * A bare IPv6 literal has colons of its own, so `host:port` is ambiguous until it is
   * bracketed -- appending a port to `2001:db8::20` names something else entirely.
   */
  test("a bare IPv6 literal is bracketed before the port is added", () => {
    expect(parseStaticEndpoints("2001:db8::20", PORT)).toEqual([
      { base: "http://[2001:db8::20]:7979", family: "v6", kind: "wan", source: "static" },
    ]);
  });

  test("a unique-local IPv6 address is LAN, a global one is not", () => {
    const [ula] = parseStaticEndpoints("fd00::12", PORT);
    const [gua] = parseStaticEndpoints("2001:db8::20", PORT);
    expect(ula?.kind).toBe("lan");
    expect(gua?.kind).toBe("wan");
  });

  test.each([
    ["10.1.2.3", "lan"],
    ["172.16.0.1", "lan"],
    ["172.32.0.1", "wan"],
    ["192.168.0.1", "lan"],
    ["100.64.0.1", "lan"],
    ["8.8.8.8", "wan"],
  ])("%s is derived as %s", (address, kind) => {
    expect(parseStaticEndpoints(address, PORT)[0]?.kind).toBe(kind as "lan" | "wan");
  });

  /**
   * DNS does not say whether a name is inside or outside, so the prefix is the only way to
   * state it -- and a name with no prefix defaults to `wan`, which costs at worst one place
   * in the race order.
   */
  test("a name defaults to wan and lan= overrides it", () => {
    expect(parseStaticEndpoints("finderr.example.com", PORT)[0]).toMatchObject({
      base: "http://finderr.example.com:7979",
      family: null,
      kind: "wan",
    });
    expect(parseStaticEndpoints("lan=finderr.lan", PORT)[0]?.kind).toBe("lan");
  });

  test("a stated scheme and port are left alone, and the default port is elided", () => {
    expect(bases(parseStaticEndpoints("https://finderr.example.com,http://nas:8080", PORT))).toEqual([
      "https://finderr.example.com",
      "http://nas:8080",
    ]);
  });

  /** One typo must not stop the server booting; the remaining candidates still work. */
  test.each([
    ["", "empty"],
    ["local=10.0.0.5", "a prefix that is neither lan nor wan"],
    ["ftp://10.0.0.5", "a scheme no browser fetches media over"],
    ["http://", "no host at all"],
    // Both of these once produced a WRONG candidate rather than none: the first parsed as the
    // host `ftp`, and the second put the port inside the path and silently meant port 80.
    ["10.0.0.5/segments", "a path, so it is not an origin"],
    ["user@10.0.0.5", "credentials, which an origin does not carry"],
  ])("drops %p -- %s", (entry) => {
    expect(parseStaticEndpoints(`${entry},10.0.0.9`, PORT).map((e) => e.base)).toEqual([
      "http://10.0.0.9:7979",
    ]);
  });

  test("no spec at all is no candidates, which is the default deployment", () => {
    expect(parseStaticEndpoints("", PORT)).toEqual([]);
    expect(parseStaticEndpoints(undefined, PORT)).toEqual([]);
  });
});

describe("the family comes from the literal or from nowhere", () => {
  test.each([
    ["http://10.0.0.5:7979", "v4"],
    ["http://[fd00::1]:7979", "v6"],
    ["https://finderr.example.com", null],
    // Six characters of a dotted quad that is not one: an octet cannot exceed 255, so this is
    // a hostname as far as any resolver is concerned.
    ["http://999.1.1.1:7979", null],
  ])("%s is %p", (base, family) => {
    expect(familyOfOrigin(base)).toBe(family as "v4" | "v6" | null);
  });
});

describe("the container's own addresses", () => {
  const addresses: HostAddress[] = [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "172.20.7.133", family: "IPv4", internal: false },
    { address: "fe80::1%en0", family: "IPv6", internal: false },
    { address: "169.254.4.4", family: "IPv4", internal: false },
    { address: "2001:db8::7", family: "IPv6", internal: false },
  ];

  /**
   * Three exclusions, each one an address a client would fail on: loopback is a different
   * machine's idea of itself, and a link-local address needs a zone index no URL can carry.
   */
  test("loopback and link-local are left out, and v6 is bracketed", () => {
    expect(bases(interfaceEndpoints(PORT, addresses))).toEqual([
      "http://172.20.7.133:7979",
      "http://[2001:db8::7]:7979",
    ]);
  });

  test("a private address is LAN and a global v6 one is WAN", () => {
    const found = interfaceEndpoints(PORT, addresses);
    expect(found.map((e) => e.kind)).toEqual(["lan", "wan"]);
  });

  test("a machine with nothing but loopback advertises nothing", () => {
    expect(interfaceEndpoints(PORT, [{ address: "127.0.0.1", family: "IPv4", internal: true }])).toEqual([]);
  });

  /** IGD version 1 has no IPv6 mapping at all, so the address to forward to must be v4. */
  test("the address offered to a gateway is the first private IPv4", () => {
    expect(primaryLanAddress(addresses)).toBe("172.20.7.133");
    expect(primaryLanAddress([{ address: "2001:db8::7", family: "IPv6", internal: false }])).toBeNull();
  });
});

describe("the order the client races in", () => {
  const at = (base: string, rest: Partial<StreamEndpoint> = {}): StreamEndpoint => ({
    base,
    family: null,
    kind: "wan",
    source: "static",
    ...rest,
  });

  /**
   * LOCALITY DOMINATES, and this is the assertion that stops a well-meaning edit ranking a
   * trusted static WAN name above a discovered LAN address -- which would hairpin every local
   * viewer out to the internet and back.
   */
  test("a discovered LAN address outranks a configured WAN name", () => {
    const ordered = mergeEndpoints(
      [at("https://finderr.example.com", { kind: "wan", source: "static" })],
      [at("http://10.0.0.5:7979", { kind: "lan", family: "v4", source: "interface" })],
    );
    expect(bases(ordered)).toEqual(["http://10.0.0.5:7979", "https://finderr.example.com"]);
  });

  test("within a kind, v6 comes first and a name sits between the two literals", () => {
    const ordered = mergeEndpoints([
      at("http://10.0.0.5:7979", { kind: "lan", family: "v4" }),
      at("http://nas.lan:7979", { kind: "lan", family: null }),
      at("http://[fd00::5]:7979", { kind: "lan", family: "v6" }),
    ]);
    expect(bases(ordered)).toEqual(["http://[fd00::5]:7979", "http://nas.lan:7979", "http://10.0.0.5:7979"]);
  });

  test("the same origin from two sources appears once, keeping the more trusted one", () => {
    const ordered = mergeEndpoints(
      [at("http://10.0.0.5:7979", { kind: "lan", source: "static" })],
      [at("http://10.0.0.5:7979", { kind: "wan", source: "interface" })],
    );
    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.source).toBe("static");
  });

  /** Two boots with the same inputs must advertise the same list, or a pinned choice is noise. */
  test("the order is total, so it does not depend on input order", () => {
    const a = at("http://10.0.0.5:7979", { kind: "lan", family: "v4", source: "interface" });
    const b = at("http://10.0.0.6:7979", { kind: "lan", family: "v4", source: "interface" });
    expect(bases(mergeEndpoints([a, b]))).toEqual(bases(mergeEndpoints([b, a])));
  });
});

describe("the directory holds the set as it grows", () => {
  const addresses = (): HostAddress[] => [{ address: "10.0.0.5", family: "IPv4", internal: false }];

  test("static and discovered addresses are both advertised", () => {
    const directory = new StreamEndpointDirectory({
      staticSpec: "wan=https://finderr.example.com",
      port: PORT,
      addresses,
    });
    expect(bases(directory.list())).toEqual(["http://10.0.0.5:7979", "https://finderr.example.com"]);
  });

  /**
   * UPnP answers seconds after boot IF it answers, so the directory must have a before and an
   * after -- and the after must be replaceable, since a refresh can learn a new address.
   */
  test("an external address appears when learned, replaces itself, and can be forgotten", () => {
    const directory = new StreamEndpointDirectory({ staticSpec: "", port: PORT });
    expect(directory.list()).toEqual([]);

    directory.learnExternal("203.0.113.7", 7979);
    expect(directory.list()).toEqual([
      { base: "http://203.0.113.7:7979", family: "v4", kind: "wan", source: "upnp" },
    ]);

    directory.learnExternal("203.0.113.8", 7979);
    expect(bases(directory.list())).toEqual(["http://203.0.113.8:7979"]);

    directory.forgetExternal();
    expect(directory.list()).toEqual([]);
  });

  /** A UPnP-learned address ranks below everything stated, being the one a router may drop. */
  test("the learned address ranks last among WAN candidates", () => {
    const directory = new StreamEndpointDirectory({
      staticSpec: "wan=https://finderr.example.com",
      port: PORT,
    });
    directory.learnExternal("203.0.113.7", 7979);
    expect(bases(directory.list())).toEqual(["https://finderr.example.com", "http://203.0.113.7:7979"]);
  });
});
