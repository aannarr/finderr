import { describe, expect, test } from "bun:test";
import { LIMITS } from "../lib/input-guards";
import { withPayloadGuard } from "./payload-guard";

const longUrl = `http://x/api/search?q=${"a".repeat(LIMITS.url)}`;
const okUrl = "http://x/api/search?q=alien";

/** Every SHAPE a Bun route table entry can take. The wrapper must handle all three. */
function table(hits: string[]) {
  return {
    "/api/bare": (req: Request) => {
      hits.push(`bare ${req.url}`);
      return new Response("bare");
    },
    "/api/methods": {
      GET: (req: Request) => {
        hits.push(`get ${req.url}`);
        return new Response("get");
      },
      POST: (req: Request) => {
        hits.push(`post ${req.url}`);
        return new Response("post");
      },
    },
    /*
      A STATIC RESPONSE, which is neither a function nor a table of them.

      `route-wrap.ts` has a caution about this exact shape: two wrappers that predate it
      both CLAIMED to pass a static Response through and neither did -- it fell into the
      method branch, `Object.entries(new Response())` is empty, and the route was silently
      replaced by `{}`. Nothing in the tree registers one yet, which is exactly why a new
      wrapper has to be tested against it rather than assumed to inherit the fix.
    */
    "/static": new Response("static"),
  };
}

const call = (entry: unknown, url: string, method = "GET") => {
  const handler = typeof entry === "function" ? entry : (entry as Record<string, unknown>)[method];
  return (handler as (req: Request) => Response)(new Request(url));
};

describe("withPayloadGuard", () => {
  test("passes an ordinary URL through to a bare handler", async () => {
    const hits: string[] = [];
    const wrapped = withPayloadGuard(table(hits));
    const res = await call(wrapped["/api/bare"], okUrl);
    expect(await res.text()).toBe("bare");
    expect(hits).toHaveLength(1);
  });

  test("refuses an over-long URL with 414 and NEVER runs the handler", async () => {
    // The handler not running is the whole point: the guard is in front of the index gate,
    // the auth guard and every parser, so an absurd URL costs one string length check.
    const hits: string[] = [];
    const wrapped = withPayloadGuard(table(hits));
    const res = await call(wrapped["/api/bare"], longUrl);
    expect(res.status).toBe(414);
    expect(hits).toEqual([]);
  });

  test("guards EVERY method of a method table, not just the first", async () => {
    const hits: string[] = [];
    const wrapped = withPayloadGuard(table(hits));
    for (const method of ["GET", "POST"]) {
      expect((await call(wrapped["/api/methods"], longUrl, method)).status).toBe(414);
    }
    expect(hits).toEqual([]);
    // ...and the same two still work normally.
    expect(await (await call(wrapped["/api/methods"], okUrl, "GET")).text()).toBe("get");
    expect(await (await call(wrapped["/api/methods"], okUrl, "POST")).text()).toBe("post");
  });

  test("passes a static Response through intact rather than replacing it with {}", async () => {
    const wrapped = withPayloadGuard(table([]));
    const entry = wrapped["/static"];
    expect(entry).toBeInstanceOf(Response);
    expect(await (entry as Response).text()).toBe("static");
  });

  test("the refusal names the limit and never the URL", async () => {
    const res = await call(withPayloadGuard(table([]))["/api/bare"], longUrl);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(String(LIMITS.url));
    // Reflecting the offending URL back is how a hostile string reaches a log or a
    // screenshot of an error toast. The caller already knows what they sent.
    expect(body.error).not.toContain("aaaa");
  });

  test("keeps the same route keys, so no route is dropped by being wrapped", () => {
    const before = Object.keys(table([]));
    expect(Object.keys(withPayloadGuard(table([])))).toEqual(before);
  });
});
