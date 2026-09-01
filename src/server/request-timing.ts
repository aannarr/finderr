import type { SlowLog } from "../lib/slow-log";
import type { Timings } from "../lib/timings";
import { wrapRoutes } from "./route-wrap";

/**
 * How long every request took, wrapped around the WHOLE route table.
 *
 * > [!IMPORTANT] It wraps the table for the same reason `withAuth` does
 * > A timer per handler is a rule with one owner per handler, and the one that goes
 * > un-timed is the one somebody adds next month -- which, on the day this was written,
 * > would have been the one that was slow. Wrapping the table means a new route is
 * > instrumented by having been added, and there is no second place to remember.
 *
 * **The key is the route PATTERN, never the filled-in path.** `/api/title/:tconst` is one
 * row; `/api/title/tt0111161` is 1.27 million rows that never repeat, and a distribution
 * over keys that occur once is not a distribution. The arguments that distinguish one call
 * from another are kept on the SLOW entries instead, where there are at most a few dozen of
 * them -- see `SlowLog`, which exists precisely because those two questions have different
 * answers.
 *
 * **It records on EVERY exit, including a throw.** A handler that dies after two seconds
 * spent those two seconds, and dropping it would make the p95 of a broken route look
 * healthy. The error is re-thrown untouched.
 *
 * > [!CAUTION] `detail` reaches an admin's browser, so it carries the query string and
 * > never a body, a header or a cookie
 * > This is the same rule `safeUrl` enforces on the outbound side, applied in the other
 * > direction. A query string on OUR OWN api is our own vocabulary -- `?genre=Comedy`,
 * > `?q=matrix` -- and it is the whole reason the entry is worth keeping; a request body is
 * > where a WebAuthn attestation and an invite token live. So the URL's search string is
 * > copied and nothing else is, and `/api/health` serves the result only to an
 * > authenticated admin.
 */
export interface TimingOptions {
  /** Per-route distribution. Keyed `METHOD /route/pattern`. */
  timings: Timings;
  /** Where a breach is kept, with its arguments. */
  slow: SlowLog;
  /** Anything at or over this many milliseconds is a breach. */
  thresholdMs: number;
  /** One line per breach. Injected so a test asserts on it rather than on stdout. */
  log?: (line: string) => void;
  /** Wall clock for the `at` stamp. */
  now?: () => number;
  /**
   * Monotonic clock for the DURATION, and it is a different clock on purpose: `Date.now()`
   * steps backwards when NTP corrects, which would otherwise mint negative durations.
   */
  elapsed?: () => number;
}

export function withTiming<T extends Record<string, unknown>>(routes: T, opts: TimingOptions): T {
  const now = opts.now ?? (() => Date.now());
  const elapsed = opts.elapsed ?? (() => performance.now());

  const finish = (label: string, detail: string, startedAt: number, outcome: string): void => {
    const ms = Math.max(0, elapsed() - startedAt);
    opts.timings.add(label, ms);
    if (ms < opts.thresholdMs) return;
    opts.slow.record({ at: now(), label, ms, detail });
    opts.log?.(`slow: ${label}${detail} took ${Math.round(ms)}ms${outcome}`);
  };

  const wrap =
    (path: string, handler: (...args: never[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const req = args[0] as Request;
      const label = `${req.method} ${path}`;
      // The search string only. `new URL` rather than a substring so a malformed URL throws
      // here, where it is one un-timed request, instead of inside the tally.
      let detail = "";
      try {
        detail = new URL(req.url).search;
      } catch {
        detail = "";
      }
      const startedAt = elapsed();

      let out: unknown;
      try {
        out = (handler as (...a: unknown[]) => unknown)(...args);
      } catch (err) {
        finish(label, detail, startedAt, " (threw)");
        throw err;
      }

      // A handler is sync or async and the table holds both. Awaiting a sync Response would
      // turn every route into a microtask for no reason, so the promise case is detected
      // rather than assumed -- and the timer is attached to the promise instead of the call.
      if (out instanceof Promise) {
        return out.then(
          (value) => {
            finish(label, detail, startedAt, statusOf(value));
            return value;
          },
          (err) => {
            finish(label, detail, startedAt, " (rejected)");
            throw err;
          },
        );
      }
      finish(label, detail, startedAt, statusOf(out));
      return out;
    };

  return wrapRoutes(routes, wrap);
}

/** A non-200 that was slow is a different problem from a 200 that was slow. */
function statusOf(value: unknown): string {
  return value instanceof Response && value.status !== 200 ? ` (${value.status})` : "";
}
