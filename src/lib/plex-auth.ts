/**
 * Signing in with Plex, via the PIN flow.
 *
 * No client secret and no app registration: ask plex.tv for a PIN, send the user to
 * `app.plex.tv/auth` with its code, and poll until the PIN carries an `authToken`. Verified
 * live on 2026-08-30 against the real endpoints.
 *
 * > [!IMPORTANT] AUTHORIZATION IS NOT AUTHENTICATION, and this file is where that bites
 * > A Plex account proves somebody has a Plex account. Anyone can make one in a minute. So
 * > a successful PIN exchange is the START of the decision, never the end of it:
 * >
 * > 1. The account must be linked to an existing finderr user, OR the flow must be
 * >    carrying a valid invite. aannarr, 2026-08-31: **you must be invited.** There is no
 * >    "any Plex account may sign in" mode, because that is an open door wearing a login
 * >    screen.
 * > 2. When `plex.machineIdentifier` is configured, the account must additionally have
 * >    access to OUR server -- checked against `/api/v2/resources`. That is a SECOND gate,
 * >    never a substitute for the first.
 *
 * Everything here takes `fetchImpl` so the tests never touch plex.tv, the same shape the
 * plugins use.
 */

export interface PlexPin {
  id: string;
  code: string;
  /** Seconds. Plex sends 1800; the caller turns it into an absolute expiry. */
  expiresIn: number;
}

export interface PlexAccount {
  id: string;
  username: string | null;
  email: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PLEX_API = "https://plex.tv/api/v2";

/**
 * The headers every plex.tv call needs.
 *
 * `X-Plex-Client-Identifier` must be STABLE for a given browser across the whole ceremony:
 * plex.tv ties the PIN to it, and a fresh id between the create and the poll returns a PIN
 * that never carries a token. It is generated per sign-in attempt and stored with the pin
 * row rather than being derived from anything about the visitor.
 */
function headers(clientId: string, product: string): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Product": product,
    "X-Plex-Client-Identifier": clientId,
  };
}

export async function createPin(
  fetchImpl: FetchLike,
  opts: { clientId: string; product: string },
): Promise<PlexPin> {
  const res = await fetchImpl(`${PLEX_API}/pins?strong=true`, {
    method: "POST",
    headers: headers(opts.clientId, opts.product),
  });
  if (!res.ok) throw new Error(`plex pin create failed: ${res.status}`);
  const body = (await res.json()) as { id: number | string; code: string; expiresIn?: number };
  return { id: String(body.id), code: body.code, expiresIn: body.expiresIn ?? 1800 };
}

/** Where the browser is sent. The user comes back to `forwardUrl` once they approve. */
export function plexAuthUrl(opts: {
  clientId: string;
  code: string;
  product: string;
  forwardUrl: string;
}): string {
  const params = new URLSearchParams({
    clientID: opts.clientId,
    code: opts.code,
    "context[device][product]": opts.product,
    forwardUrl: opts.forwardUrl,
  });
  // The `#?` is Plex's own shape -- the parameters live in the fragment, not the query.
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

/** null means "not approved yet", which is the ordinary answer while the user is typing. */
export async function pollPin(
  fetchImpl: FetchLike,
  opts: { id: string; clientId: string; product: string },
): Promise<string | null> {
  const res = await fetchImpl(`${PLEX_API}/pins/${encodeURIComponent(opts.id)}`, {
    headers: headers(opts.clientId, opts.product),
  });
  if (!res.ok) throw new Error(`plex pin poll failed: ${res.status}`);
  const body = (await res.json()) as { authToken: string | null };
  return body.authToken ?? null;
}

/** Who the token belongs to. The id is what we link on -- a username can be changed. */
export async function plexAccount(
  fetchImpl: FetchLike,
  token: string,
  product: string,
): Promise<PlexAccount> {
  const res = await fetchImpl(`${PLEX_API}/user`, {
    headers: { ...headers("finderr-auth", product), "X-Plex-Token": token },
  });
  if (!res.ok) throw new Error(`plex account lookup failed: ${res.status}`);
  const body = (await res.json()) as { id: number | string; username?: string; email?: string };
  return { id: String(body.id), username: body.username ?? null, email: body.email ?? null };
}

/**
 * Does this account have access to OUR Plex server?
 *
 * The second gate, and only meaningful when a machine identifier is configured. It is
 * checked against the resource list the account can actually see, so it answers "is this
 * person in our household" rather than "does this person exist".
 */
export async function hasServerAccess(
  fetchImpl: FetchLike,
  opts: { token: string; product: string; machineIdentifier: string },
): Promise<boolean> {
  const res = await fetchImpl(`${PLEX_API}/resources?includeHttps=1`, {
    headers: { ...headers("finderr-auth", opts.product), "X-Plex-Token": opts.token },
  });
  if (!res.ok) throw new Error(`plex resources failed: ${res.status}`);
  const body = (await res.json()) as { clientIdentifier?: string; provides?: string }[];
  return body.some((r) => r.clientIdentifier === opts.machineIdentifier);
}
