/**
 * Parsing the three arr settings an admin may attach to a request.
 *
 * Split out of the route for the same reason `parseSeasonsInput` is: it is the only part of
 * `POST /api/requests` with a decision in it, and it is worth testing without a live arr,
 * a live index or a session.
 *
 * > [!IMPORTANT] This validates SHAPE, never AUTHORISATION
 * > "May this caller choose a quality profile?" is the route's question and it is answered
 * > by `auth.requireAdmin` before this is ever called. Mixing the two here would put an
 * > authorisation rule in a pure function with no principal to check, which is how a second
 * > owner of a security rule gets written.
 *
 * It also does NOT check that the profile exists. Radarr and Sonarr are the authority on
 * their own ids, they are the ones that will refuse, and asking them here would put a
 * network call inside a request the browser is waiting on -- which is the one thing this
 * whole product is built not to do. An id that does not exist comes back as a `failed`
 * request carrying the arr's own message, which is a better error than any guess we could
 * make from a list that may be seconds out of date.
 */

import type { RequestOverrides } from "./store";

/** Absent, present-and-valid, or a reason to refuse. */
export type ParsedOverrides = { overrides: RequestOverrides } | { error: string };

/**
 * Read `{ qualityProfileId, rootFolderPath, searchOnAdd }` off a request body.
 *
 * `null` is accepted everywhere `undefined` is and means the same thing -- "use the service
 * default". A client clearing a selection sends `null` rather than omitting the key, and
 * having to distinguish those two at every layer buys nothing.
 */
export function parseRequestOverrides(body: unknown): ParsedOverrides {
  if (body === null || typeof body !== "object") return { overrides: {} };
  const b = body as Record<string, unknown>;
  const overrides: RequestOverrides = {};

  if (b.qualityProfileId !== undefined && b.qualityProfileId !== null) {
    const id = b.qualityProfileId;
    // Rejecting a float and a numeric string on purpose: an arr profile id is a row id, and
    // a caller sending "5" has a bug we should surface rather than paper over by coercing.
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return { error: "qualityProfileId must be a positive integer" };
    }
    overrides.qualityProfileId = id;
  }

  if (b.rootFolderPath !== undefined && b.rootFolderPath !== null) {
    const path = b.rootFolderPath;
    if (typeof path !== "string") return { error: "rootFolderPath must be a string" };
    const trimmed = path.trim();
    if (!trimmed) return { error: "rootFolderPath must not be empty" };
    // An arr root folder is always absolute. This is not a traversal guard -- the path is
    // sent to the arr, not opened here, and the arr only accepts folders it already knows
    // -- it is a shape check that catches a client sending a name where a path belongs.
    if (!trimmed.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
      return { error: "rootFolderPath must be an absolute path" };
    }
    overrides.rootFolderPath = trimmed;
  }

  if (b.searchOnAdd !== undefined && b.searchOnAdd !== null) {
    if (typeof b.searchOnAdd !== "boolean") return { error: "searchOnAdd must be a boolean" };
    overrides.searchOnAdd = b.searchOnAdd;
  }

  return { overrides };
}

/** Did the caller ask for anything at all? Used to refuse a non-admin who tried. */
export function hasOverrides(o: RequestOverrides): boolean {
  return o.qualityProfileId !== undefined || o.rootFolderPath !== undefined || o.searchOnAdd !== undefined;
}
