import { describe, expect, test } from "bun:test";

/**
 * THE PUSH PAYLOAD IS DECLARED TWICE, AND NOTHING ELSE MAKES THE TWO AGREE.
 *
 * `src/server/push.ts` builds a `PushMessage`; `web/src/sw.ts` reads one. They cannot share
 * a type: importing the server's would pull a server module into a service worker bundle,
 * and importing the worker's would pull `webworker` globals into the server's project.
 *
 * So they are checked against each other. The failure this prevents is the worst shape a
 * defect can take here -- the server sends a field the worker does not read, every push
 * still returns 201, and the only symptom is a notification on somebody's phone with a word
 * missing or the wrong destination behind the tap. Nothing in a build, a type check or a
 * running server would ever say so.
 */

const SW = await Bun.file(new URL("./sw.ts", import.meta.url)).text();
const SERVER = await Bun.file(new URL("../../src/server/push.ts", import.meta.url)).text();

/** The field names inside `interface PushMessage { ... }`, in declaration order. */
function fieldsOf(source: string): string[] {
  const start = source.indexOf("interface PushMessage {");
  if (start === -1) return [];
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1] as string);
}

describe("the push payload", () => {
  test("both ends declare the same fields", () => {
    const worker = fieldsOf(SW);
    expect(worker.length).toBeGreaterThan(0);
    expect(worker).toEqual(fieldsOf(SERVER));
  });

  /**
   * A payload arrives from a server that may be a RELEASE AHEAD of the worker holding it --
   * a browser keeps the worker it has until the next load. So every field is checked at
   * runtime rather than trusted, because one missing string renders as the literal word
   * "undefined" on a lock screen.
   */
  test("the worker falls back per field rather than trusting the payload", () => {
    for (const field of fieldsOf(SERVER)) {
      expect(SW).toContain(`typeof parsed.${field} === "string" ? parsed.${field} : fallback.${field}`);
    }
  });

  /**
   * Every engine that implements push does so under `userVisibleOnly`, and a handler that
   * receives a message without showing something is penalised -- Chrome substitutes its own
   * "This site has been updated in the background" notice, and a repeat offender loses the
   * permission. So the unreadable-payload path still has to produce a notification.
   */
  test("a push that cannot be read still shows one", () => {
    expect(SW).toContain("showNotification");
    expect(SW).toContain("const fallback: PushMessage");
  });
});
