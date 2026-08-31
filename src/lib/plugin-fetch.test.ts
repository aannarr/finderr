import { describe, expect, test } from "bun:test";
import { type BulkheadPolicy, bulkhead, isBulkheadRejectedError } from "cockatiel";
import {
  createPluginFetch,
  HostPacer,
  OutboundHostError,
  PLUGIN_USER_AGENT,
  type PluginFetch,
} from "./plugin-fetch";

/** Records what it was asked for and answers instantly -- no socket is ever opened. */
function recordingFetch() {
  const calls: { url: string; headers: Headers }[] = [];
  const impl: PluginFetch = async (input, init) => {
    calls.push({
      url: input instanceof URL ? input.href : String(input),
      headers: new Headers(init?.headers),
    });
    return new Response("{}");
  };
  return { calls, impl };
}

function fetchFor(hosts: string[], impl: PluginFetch, pacer = new HostPacer(0)) {
  return createPluginFetch({ pluginId: "test-plugin", hosts, pacer, fetchImpl: impl });
}

describe("declared hosts", () => {
  test("a declared host goes through", async () => {
    const { calls, impl } = recordingFetch();
    await fetchFor(["api.radarr.video"], impl)("https://api.radarr.video/v1/movie/imdb/tt1375666");
    expect(calls).toHaveLength(1);
  });

  /**
   * The acceptance this whole wrapper exists for: a plugin cannot reach anywhere it did
   * not write down in its own meta.
   */
  test("an undeclared host is refused before any request is made", async () => {
    const { calls, impl } = recordingFetch();
    const f = fetchFor(["api.radarr.video"], impl);
    await expect(f("https://evil.example/steal")).rejects.toBeInstanceOf(OutboundHostError);
    expect(calls).toHaveLength(0);
  });

  test("a declared host does not authorise a lookalike", async () => {
    const { impl } = recordingFetch();
    const f = fetchFor(["radarr.video"], impl);
    await expect(f("https://api.radarr.video/x")).rejects.toBeInstanceOf(OutboundHostError);
    await expect(f("https://radarr.video.evil.example/x")).rejects.toBeInstanceOf(OutboundHostError);
  });

  test("hostnames match case-insensitively, as DNS does", async () => {
    const { calls, impl } = recordingFetch();
    await fetchFor(["API.Radarr.Video"], impl)("https://api.radarr.video/x");
    expect(calls).toHaveLength(1);
  });

  test("plain http is refused even on a declared host", async () => {
    const { impl } = recordingFetch();
    await expect(fetchFor(["api.radarr.video"], impl)("http://api.radarr.video/x")).rejects.toThrow(
      /https only/,
    );
  });

  test("a relative or malformed URL is refused rather than resolved against something", async () => {
    const { impl } = recordingFetch();
    await expect(fetchFor(["api.radarr.video"], impl)("/v1/movie")).rejects.toThrow(/valid absolute URL/);
  });

  test("a plugin declaring no hosts can reach nothing", async () => {
    const { impl } = recordingFetch();
    await expect(fetchFor([], impl)("https://api.radarr.video/x")).rejects.toBeInstanceOf(OutboundHostError);
  });

  test("a URL object is checked the same as a string", async () => {
    const { impl } = recordingFetch();
    await expect(fetchFor(["a.example"], impl)(new URL("https://b.example/x"))).rejects.toBeInstanceOf(
      OutboundHostError,
    );
  });
});

describe("etiquette", () => {
  test("every call identifies finderr honestly", async () => {
    const { calls, impl } = recordingFetch();
    await fetchFor(["a.example"], impl)("https://a.example/x");
    expect(calls[0]?.headers.get("User-Agent")).toBe(PLUGIN_USER_AGENT);
  });

  /** A plugin does not get to claim it is a browser, or Radarr. */
  test("a plugin cannot override the User-Agent", async () => {
    const { calls, impl } = recordingFetch();
    await fetchFor(["a.example"], impl)("https://a.example/x", {
      headers: { "User-Agent": "Radarr/5.0", "X-Api-Key": "kept" },
    });
    expect(calls[0]?.headers.get("User-Agent")).toBe(PLUGIN_USER_AGENT);
    expect(calls[0]?.headers.get("X-Api-Key")).toBe("kept");
  });

  test("a timeout signal is attached when the plugin supplies none", async () => {
    let sawSignal = false;
    const impl: PluginFetch = async (_input, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response("{}");
    };
    await fetchFor(["a.example"], impl)("https://a.example/x");
    expect(sawSignal).toBe(true);
  });
});

describe("HostPacer", () => {
  /** Clock and sleep are injected, so this asserts the pacing without spending the time. */
  function fakeClock() {
    let now = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      now += ms;
    };
    return { slept, pacer: new HostPacer(250, () => now, sleep) };
  }

  test("the first call to a host waits for nothing", async () => {
    const { slept, pacer } = fakeClock();
    await pacer.take("a.example");
    expect(slept).toEqual([]);
  });

  test("back-to-back calls to one host are spaced out", async () => {
    const { slept, pacer } = fakeClock();
    await pacer.take("a.example");
    await pacer.take("a.example");
    await pacer.take("a.example");
    expect(slept).toEqual([250, 250]);
  });

  /** Courtesy is owed per third party, so one slow host must not stall a different one. */
  test("different hosts do not queue behind each other", async () => {
    const { slept, pacer } = fakeClock();
    await pacer.take("a.example");
    await pacer.take("b.example");
    expect(slept).toEqual([]);
  });

  /**
   * The pacer is shared across plugins, so two providers hitting the same third party
   * queue rather than each keeping a private clock.
   */
  test("two plugins sharing a pacer share the host's queue", async () => {
    const { slept, pacer } = fakeClock();
    const { impl } = recordingFetch();
    const one = fetchFor(["a.example"], impl, pacer);
    const two = fetchFor(["a.example"], impl, pacer);
    await one("https://a.example/x");
    await two("https://a.example/y");
    expect(slept).toEqual([250]);
  });
});

describe("the outbound gate", () => {
  /** A fetch that blocks until released, so concurrency is observable rather than timed. */
  function blockingFetch() {
    let started = 0;
    const held: (() => void)[] = [];
    const impl = async () => {
      started++;
      await new Promise<void>((r) => held.push(r));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const release = () => {
      for (const r of held.splice(0)) r();
    };
    return { impl, started: () => started, release };
  }

  function gatedFetch(gate: BulkheadPolicy, impl: PluginFetch) {
    return createPluginFetch({
      pluginId: "p",
      hosts: ["example.com"],
      pacer: new HostPacer(0),
      fetchImpl: impl,
      gate,
    });
  }

  test("no more than `concurrency` calls leave the process at once", async () => {
    const f = blockingFetch();
    const fetchOne = gatedFetch(bulkhead(2, 10), f.impl);

    void fetchOne("https://example.com/a");
    void fetchOne("https://example.com/b");
    void fetchOne("https://example.com/c");
    await Bun.sleep(10);

    expect(f.started()).toBe(2);
    f.release();
    await Bun.sleep(10);
    expect(f.started()).toBe(3);
    f.release();
  });

  /**
   * The refusal is the whole point of the bound. Without it an overloaded process only
   * moves the failure: facets arrive four minutes late instead of the host saying "not now".
   */
  test("past the queue limit it REFUSES rather than growing the queue", async () => {
    const f = blockingFetch();
    const fetchOne = gatedFetch(bulkhead(1, 1), f.impl);

    void fetchOne("https://example.com/a").catch(() => {});
    void fetchOne("https://example.com/b").catch(() => {});
    await Bun.sleep(5);

    // Third has nowhere to go: one running, one queued, both full.
    const refused = fetchOne("https://example.com/c");
    await expect(refused).rejects.toThrow();
    await refused.catch((e) => expect(isBulkheadRejectedError(e)).toBe(true));
    f.release();
  });

  /**
   * A refusal must stay distinguishable from a failure all the way up, because the
   * resolver caches one and deliberately does not cache the other.
   */
  test("a refusal is a typed BulkheadRejectedError, not a generic throw", async () => {
    const f = blockingFetch();
    const fetchOne = gatedFetch(bulkhead(1, 0), f.impl);

    void fetchOne("https://example.com/a").catch(() => {});
    await Bun.sleep(5);

    let caught: unknown;
    await fetchOne("https://example.com/b").catch((e) => {
      caught = e;
    });
    expect(isBulkheadRejectedError(caught)).toBe(true);
    expect(caught instanceof OutboundHostError).toBe(false);
    f.release();
  });

  /** A host refusal is cheap and must not consume a slot it never needed. */
  test("an undeclared host is refused without taking a gate slot", async () => {
    const f = blockingFetch();
    const gate = bulkhead(1, 0);
    const fetchOne = gatedFetch(gate, f.impl);

    await expect(fetchOne("https://evil.example/x")).rejects.toThrow(OutboundHostError);
    // The slot is still free, so a legitimate call goes straight through.
    void fetchOne("https://example.com/a");
    await Bun.sleep(10);
    expect(f.started()).toBe(1);
    f.release();
  });
});

describe("both deadlines apply, not whichever the caller passed", () => {
  /**
   * This was `init?.signal ?? AbortSignal.timeout(...)`, which DROPPED the outbound timeout
   * for any caller supplying its own signal. `FacetProvider` now hands providers a
   * cancellation signal to pass here, so that shape would have turned an encouraged
   * practice into "this plugin no longer has a fetch timeout".
   */
  test("a caller's signal is combined with the outbound timeout, never substituted for it", async () => {
    let seen: AbortSignal | undefined;
    const fetchOne = createPluginFetch({
      pluginId: "p",
      hosts: ["example.com"],
      pacer: new HostPacer(0),
      policy: { timeoutMs: 20 },
      fetchImpl: async (_i, init) => {
        seen = init?.signal ?? undefined;
        await Bun.sleep(60);
        return new Response("{}");
      },
    });

    const caller = new AbortController();
    await fetchOne("https://example.com/a", { signal: caller.signal }).catch(() => {});

    // The policy timeout still fired even though the caller supplied a signal.
    expect(seen?.aborted).toBe(true);
  });

  test("the caller's own abort still works through the combined signal", async () => {
    let seen: AbortSignal | undefined;
    const fetchOne = createPluginFetch({
      pluginId: "p",
      hosts: ["example.com"],
      pacer: new HostPacer(0),
      policy: { timeoutMs: 5_000 },
      fetchImpl: async (_i, init) => {
        seen = init?.signal ?? undefined;
        await Bun.sleep(80);
        return new Response("{}");
      },
    });

    const caller = new AbortController();
    const p = fetchOne("https://example.com/a", { signal: caller.signal });
    setTimeout(() => caller.abort(), 10);
    await p.catch(() => {});
    await Bun.sleep(20);

    expect(seen?.aborted).toBe(true);
  });
});
