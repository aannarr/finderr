/**
 * The IGD conversation, against a fake router rather than a real one.
 *
 * **The property that matters most is that nothing here can break a stream.** A network with
 * IGD disabled, a router that lies, a description that does not parse, a SOAP fault -- every
 * one of them has to end in a null and a log line. The happy path is worth a test too, but it
 * is the failures that are load-bearing, because they are what happens on most networks.
 */

import { describe, expect, test } from "bun:test";
import { type IgdTransport, keepPortMapped, LEASE_SEC, mapPort, unmapPort } from "./upnp-igd";

const REQUEST = { port: 7979, internalIp: "10.0.0.5", description: "finderr" };
const LOCATION = "http://10.0.0.1:5000/rootDesc.xml";
const CONTROL = "http://10.0.0.1:5000/ctl/IPConn";
const SERVICE = "urn:schemas-upnp-org:service:WANIPConnection:1";

/**
 * A description with the connection service buried two device levels down and a decoy above
 * it, which is the shape real firmware produces -- the walk must not depend on a fixed path.
 */
const DESCRIPTION = `<?xml version="1.0"?>
<root>
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
        <controlURL>/ctl/L3F</controlURL>
      </service>
    </serviceList>
    <deviceList><device><deviceList><device>
      <serviceList>
        <service>
          <serviceType>${SERVICE}</serviceType>
          <controlURL>/ctl/IPConn</controlURL>
        </service>
      </serviceList>
    </device></deviceList></device></deviceList>
  </device>
</root>`;

const ok = (body: string) => new Response(body, { status: 200 });
const fault = (code: string) =>
  new Response(
    `<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode>` +
      `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
    { status: 500 },
  );
const external = (ip: string) =>
  ok(
    `<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>${ip}` +
      `</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`,
  );
const mapped = ok("<s:Envelope><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>");

/** One SOAP call as the router saw it: which action, and the arguments it carried. */
interface SeenCall {
  action: string;
  body: string;
}

/**
 * A router that answers whatever the test tells it to, and records what it was asked.
 *
 * `answers` is keyed by ACTION rather than by call order, so a test states what the router
 * does rather than how many times it is spoken to -- which is what lets the lease-fallback
 * test say "refuse a lease, accept a permanent one" in one line.
 */
function fakeRouter(opts: {
  locations?: string[];
  description?: string | null;
  answers?: Partial<Record<string, Response | ((call: number) => Response)>>;
}) {
  const seen: SeenCall[] = [];
  const counts = new Map<string, number>();
  const transport: IgdTransport = {
    discover: async () => opts.locations ?? [LOCATION],
    async fetch(_url, init) {
      if (!init?.method) {
        const body = opts.description === undefined ? DESCRIPTION : opts.description;
        return body === null ? new Response("nope", { status: 404 }) : ok(body);
      }
      const soapAction = (init.headers as Record<string, string>).soapaction ?? "";
      const action = soapAction.split("#")[1]?.replace(/"$/, "") ?? "";
      seen.push({ action, body: String(init.body) });
      const n = (counts.get(action) ?? 0) + 1;
      counts.set(action, n);
      const answer = opts.answers?.[action];
      if (typeof answer === "function") return answer(n);
      if (answer) return answer.clone();
      return new Response("no such action", { status: 500 });
    },
  };
  return { transport, seen };
}

describe("mapping a port", () => {
  test("finds the service at any depth, maps the port and learns the external address", async () => {
    const router = fakeRouter({
      answers: { AddPortMapping: mapped, GetExternalIPAddress: external("203.0.113.7") },
    });
    const mapping = await mapPort(REQUEST, router.transport);

    expect(mapping).toMatchObject({
      externalIp: "203.0.113.7",
      externalPort: 7979,
      controlUrl: CONTROL,
      serviceType: SERVICE,
      leaseSec: LEASE_SEC,
    });
  });

  /** The control URL is relative in most descriptions, and relative to the LOCATION. */
  test("the relative control URL is resolved against the description's own address", async () => {
    const router = fakeRouter({
      answers: { AddPortMapping: mapped, GetExternalIPAddress: external("203.0.113.7") },
    });
    const mapping = await mapPort(REQUEST, router.transport);
    expect(mapping?.controlUrl).toBe(CONTROL);
  });

  test("the mapping request states both ports, the internal client and the lease", async () => {
    const router = fakeRouter({
      answers: { AddPortMapping: mapped, GetExternalIPAddress: external("203.0.113.7") },
    });
    await mapPort(REQUEST, router.transport);

    const body = router.seen.find((c) => c.action === "AddPortMapping")?.body ?? "";
    expect(body).toContain("<NewExternalPort>7979</NewExternalPort>");
    expect(body).toContain("<NewInternalPort>7979</NewInternalPort>");
    expect(body).toContain("<NewInternalClient>10.0.0.5</NewInternalClient>");
    expect(body).toContain(`<NewLeaseDuration>${LEASE_SEC}</NewLeaseDuration>`);
  });

  /**
   * `725 OnlyPermanentLeasesSupported` is the router telling us exactly what it wants, which
   * is why retrying is a rule rather than a hope. Every other fault is final.
   */
  test("a router that refuses a lease is asked again for a permanent mapping", async () => {
    const router = fakeRouter({
      answers: {
        AddPortMapping: (call) => (call === 1 ? fault("725") : mapped.clone()),
        GetExternalIPAddress: external("203.0.113.7"),
      },
    });
    const mapping = await mapPort(REQUEST, router.transport);

    expect(mapping?.leaseSec).toBe(0);
    const attempts = router.seen.filter((c) => c.action === "AddPortMapping");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.body).toContain("<NewLeaseDuration>0</NewLeaseDuration>");
  });

  test("a conflicting mapping is NOT retried -- that would take somebody else's", async () => {
    const router = fakeRouter({ answers: { AddPortMapping: fault("718") } });
    expect(await mapPort(REQUEST, router.transport)).toBeNull();
    expect(router.seen.filter((c) => c.action === "AddPortMapping")).toHaveLength(1);
  });

  /** An `&` in a description would otherwise produce an envelope the router cannot parse. */
  test("argument values are escaped into the envelope", async () => {
    const router = fakeRouter({
      answers: { AddPortMapping: mapped, GetExternalIPAddress: external("203.0.113.7") },
    });
    await mapPort({ ...REQUEST, description: "finderr <a> & b" }, router.transport);
    const body = router.seen[0]?.body ?? "";
    expect(body).toContain("finderr &lt;a&gt; &amp; b");
  });
});

describe("every failure is a null, never a throw", () => {
  test.each([
    ["nothing answers the search", { locations: [] }],
    ["the description cannot be fetched", { description: null }],
    ["the description is not XML", { description: "<<<not xml" }],
    ["there is no connection service", { description: "<root><device/></root>" }],
    ["the mapping is refused", { answers: { AddPortMapping: fault("501") } }],
    [
      "the gateway maps the port but states no address",
      { answers: { AddPortMapping: mapped, GetExternalIPAddress: ok("<s:Envelope/>") } },
    ],
  ])("%s", async (_name, opts) => {
    const logged: string[] = [];
    const router = fakeRouter(opts as Parameters<typeof fakeRouter>[0]);
    expect(await mapPort(REQUEST, router.transport, (m) => logged.push(m))).toBeNull();
    expect(logged.length).toBeGreaterThan(0);
  });

  test("a discover that rejects outright is still just a null", async () => {
    const transport: IgdTransport = {
      discover: () => Promise.reject(new Error("no socket")),
      fetch: () => Promise.reject(new Error("unreachable")),
    };
    expect(await mapPort(REQUEST, transport)).toBeNull();
  });

  /** Several gateways can answer one search; the first that will not map must not end it. */
  test("a second gateway is tried when the first will not map", async () => {
    let described = 0;
    const transport: IgdTransport = {
      discover: async () => ["http://10.0.0.1:5000/d.xml", "http://10.0.0.2:5000/d.xml"],
      async fetch(_url, init) {
        if (!init?.method) {
          described += 1;
          return ok(DESCRIPTION);
        }
        const soapAction = (init.headers as Record<string, string>).soapaction ?? "";
        if (soapAction.includes("GetExternalIPAddress")) return external("203.0.113.9");
        return described === 1 ? fault("501") : mapped.clone();
      },
    };
    expect((await mapPort(REQUEST, transport))?.externalIp).toBe("203.0.113.9");
  });
});

describe("holding the mapping open", () => {
  test("a granted mapping is advertised and refreshed at half its lease", async () => {
    const router = fakeRouter({
      answers: { AddPortMapping: mapped, GetExternalIPAddress: external("203.0.113.7") },
    });
    const learned: string[] = [];
    const refreshes: number[] = [];

    keepPortMapped({
      ...REQUEST,
      transport: router.transport,
      schedule: (_fn, ms) => {
        refreshes.push(ms);
        return () => {};
      },
      onMapped: (ip) => learned.push(ip),
      onLost: () => learned.push("lost"),
    });
    await Bun.sleep(0);

    expect(learned).toEqual(["203.0.113.7"]);
    expect(refreshes).toEqual([(LEASE_SEC / 2) * 1000]);
  });

  /** There is nothing to renew on a permanent mapping, so no timer is armed for one. */
  test("a permanent mapping schedules no refresh", async () => {
    const router = fakeRouter({
      answers: {
        AddPortMapping: (call) => (call === 1 ? fault("725") : mapped.clone()),
        GetExternalIPAddress: external("203.0.113.7"),
      },
    });
    let scheduled = 0;
    keepPortMapped({
      ...REQUEST,
      transport: router.transport,
      schedule: () => {
        scheduled += 1;
        return () => {};
      },
      onMapped: () => {},
      onLost: () => {},
    });
    await Bun.sleep(0);
    expect(scheduled).toBe(0);
  });

  test("a total failure reports the loss and hands back a handle that is safe to stop", async () => {
    const router = fakeRouter({ locations: [] });
    let lost = 0;
    const handle = keepPortMapped({
      ...REQUEST,
      transport: router.transport,
      onMapped: () => {},
      onLost: () => {
        lost += 1;
      },
    });
    await Bun.sleep(0);

    expect(lost).toBe(1);
    await handle.stop();
    await handle.stop();
  });

  test("stopping cancels the refresh and gives the mapping back", async () => {
    const router = fakeRouter({
      answers: {
        AddPortMapping: mapped,
        GetExternalIPAddress: external("203.0.113.7"),
        DeletePortMapping: ok("<s:Envelope/>"),
      },
    });
    let cancelled = false;
    const handle = keepPortMapped({
      ...REQUEST,
      transport: router.transport,
      schedule: () => () => {
        cancelled = true;
      },
      onMapped: () => {},
      onLost: () => {},
    });
    await Bun.sleep(0);
    await handle.stop();

    expect(cancelled).toBe(true);
    expect(router.seen.map((c) => c.action)).toContain("DeletePortMapping");
  });
});

describe("releasing a mapping", () => {
  test("a delete names the external port and the protocol", async () => {
    const router = fakeRouter({ answers: { DeletePortMapping: ok("<s:Envelope/>") } });
    await unmapPort(
      {
        externalIp: "203.0.113.7",
        externalPort: 7979,
        controlUrl: CONTROL,
        serviceType: SERVICE,
        leaseSec: 0,
      },
      router.transport,
    );
    const body = router.seen[0]?.body ?? "";
    expect(body).toContain("<NewExternalPort>7979</NewExternalPort>");
    expect(body).toContain("<NewProtocol>TCP</NewProtocol>");
  });

  /** A router that already forgot the mapping is not a failure worth propagating. */
  test("a refused delete is logged rather than thrown", async () => {
    const router = fakeRouter({ answers: { DeletePortMapping: fault("714") } });
    const logged: string[] = [];
    await unmapPort(
      {
        externalIp: "203.0.113.7",
        externalPort: 7979,
        controlUrl: CONTROL,
        serviceType: SERVICE,
        leaseSec: 0,
      },
      router.transport,
      (m) => logged.push(m),
    );
    expect(logged.join(" ")).toContain("714");
  });
});
