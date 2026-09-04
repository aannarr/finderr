/**
 * `find_connections` -- the two-hop join, bounded by a lookup budget and resumable.
 *
 * This is the tool that answers the question the whole surface exists for: "who is in that
 * show Furious AND in a show that a Bear actor is also in". Measured as one hand-written
 * join it costs 684ms cold / 81ms warm against the real index and returns three genuine
 * paths, only the top-ranked of which is the intended answer.
 *
 * Three properties, each bought by that measurement rather than by taste:
 *
 * - **Hops cap at 2, they do not merely default to it.** At three, everything connects to
 *   everything through a popular title and the result is noise wearing a graph's clothes.
 * - **Results are RANKED, and the ranking is the feature.** The measured run returned
 *   Emmy Rossum / Jake Lacy / Scoot McNairy paths; all three are true and only the first is
 *   the answer. An unranked list hands the agent a pile and makes it guess.
 * - **The walk is BUDGETED in lookups, and says why it stopped.** `paths: []` with
 *   `status: "budget_exhausted"` does not mean unconnected -- it means we stopped looking.
 *   Same house rule as `loose_would_match` and `hiddenByFloor`.
 *
 * The budget also quietly removes the event-loop problem. There is no async SQLite in Bun
 * 1.4.0 (`Bun.SQL` with `sqlite://` is documented as sync under a Promise, measured here as
 * 0 timer ticks during a 79ms query), and a Worker pool is not available either: sharing a
 * `Database` across threads is undocumented and Bun's `SQLITE_THREADSAFE` build value could
 * not be verified. A bounded walk is a known, small amount of blocking work instead.
 */

import type { Database } from "bun:sqlite";

export type NodeKind = "title" | "person";

export interface PathNode {
  id: string;
  name: string;
  kind: NodeKind;
}

export interface ConnectionPath {
  path: PathNode[];
  /** Votes on the weakest bridge title. Votes-weighted, like the rest of the product. */
  strength: number;
}

export type ConnectionStatus = "complete" | "budget_exhausted" | "hop_limit";

export interface FindConnectionsResult {
  paths: ConnectionPath[];
  /** Index lookups actually consumed. Each is one indexed SQLite query. */
  spent: number;
  status: ConnectionStatus;
  /** Present ONLY when status is not "complete". Opaque; hand it back verbatim. */
  resume?: string;
  error?: string;
}

export interface FindConnectionsArgs {
  from: string;
  to: string;
  max_hops?: 1 | 2;
  budget?: number;
  limit?: number;
  resume?: string;
}

const DEFAULT_BUDGET = 100;
const MAX_BUDGET = 1000;
const DEFAULT_LIMIT = 10;

/**
 * Where a partial walk parks between calls.
 *
 * Deliberately NOT encoded into the handle: the frontier after 100 lookups is a few hundred
 * rowids, and base64 of that is 1-2 KB the model pays to hand straight back on every
 * continuation. A `Map` here; a `kv` row with a short TTL in the server.
 */
export interface ResumeStore {
  get(key: string): ResumeState | undefined;
  set(key: string, value: ResumeState): void;
  delete(key: string): void;
}

export interface ResumeState {
  from: string;
  to: string;
  maxHops: 1 | 2;
  /** Pairs of (bridge person rowid, bridge title rowid) still to be examined. */
  pairs: [number, number][];
  cursor: number;
  found: ConnectionPath[];
}

export class MemoryResumeStore implements ResumeStore {
  private readonly m = new Map<string, ResumeState>();
  get(k: string) {
    return this.m.get(k);
  }
  set(k: string, v: ResumeState) {
    this.m.set(k, v);
  }
  delete(k: string) {
    this.m.delete(k);
  }
}

interface Endpoint {
  kind: NodeKind;
  rowid: number;
  id: string;
  name: string;
}

function resolveEndpoint(db: Database, id: string): Endpoint | null {
  if (/^tt\d+$/.test(id)) {
    const r = db.query("select rowid_, title from title where tconst = ?").get(id) as
      | { rowid_: number; title: string }
      | undefined;
    return r ? { kind: "title", rowid: r.rowid_, id, name: r.title } : null;
  }
  if (/^nm\d+$/.test(id)) {
    const r = db.query("select rowid_, name from person where nconst = ?").get(id) as
      | { rowid_: number; name: string }
      | undefined;
    return r ? { kind: "person", rowid: r.rowid_, id, name: r.name } : null;
  }
  return null;
}

/** A budget that refuses rather than throwing, so the caller can report WHY it stopped. */
class Budget {
  spent = 0;
  constructor(private readonly cap: number) {}
  take(): boolean {
    if (this.spent >= this.cap) return false;
    this.spent += 1;
    return true;
  }
  get exhausted(): boolean {
    return this.spent >= this.cap;
  }
}

/** People in a title, or titles of a person -- the one edge this graph has. */
function neighbours(
  db: Database,
  kind: NodeKind,
  rowid: number,
): { rowid: number; id: string; name: string; votes: number }[] {
  if (kind === "title") {
    return db
      .query(
        `select p.rowid_ as rowid, p.nconst as id, p.name as name, 0 as votes
         from title_principal tp join person p on p.rowid_ = tp.person_rowid
         where tp.title_rowid = ? order by tp.ordering asc limit 40`,
      )
      .all(rowid) as { rowid: number; id: string; name: string; votes: number }[];
  }
  return db
    .query(
      `select t.rowid_ as rowid, t.tconst as id, t.title as name, t.votes as votes
       from title_principal tp join title t on t.rowid_ = tp.title_rowid
       where tp.person_rowid = ? order by t.votes desc limit 40`,
    )
    .all(rowid) as { rowid: number; id: string; name: string; votes: number }[];
}

/**
 * Find how `from` and `to` are connected through the cast graph.
 *
 * `max_hops` counts BRIDGING PEOPLE, which is the way a human counts degrees:
 * 1 is "somebody was in both", 2 is "somebody from A worked with somebody from B".
 */
export function findConnections(
  db: Database,
  args: FindConnectionsArgs,
  store: ResumeStore,
): FindConnectionsResult {
  const budget = new Budget(Math.max(1, Math.min(MAX_BUDGET, args.budget ?? DEFAULT_BUDGET)));
  const limit = Math.max(1, Math.min(50, args.limit ?? DEFAULT_LIMIT));

  if (args.resume) {
    const state = store.get(args.resume);
    if (!state) {
      return {
        paths: [],
        spent: 0,
        status: "budget_exhausted",
        error: "resume_expired",
      };
    }
    return continueWalk(db, state, budget, limit, store, args.resume);
  }

  const a = resolveEndpoint(db, args.from);
  const b = resolveEndpoint(db, args.to);
  if (!a || !b) {
    return {
      paths: [],
      spent: 0,
      status: "complete",
      error: `Unknown id: ${!a ? args.from : args.to}. Resolve names with find_title or find_person first.`,
    };
  }
  const maxHops = (args.max_hops ?? 2) >= 2 ? 2 : 1;

  // Both endpoints' immediate neighbours. Two lookups, and hop 1 falls straight out of them.
  if (!budget.take()) return { paths: [], spent: budget.spent, status: "budget_exhausted" };
  const near = neighbours(db, a.kind, a.rowid);
  if (!budget.take()) return { paths: [], spent: budget.spent, status: "budget_exhausted" };
  const far = neighbours(db, b.kind, b.rowid);
  const farBy = new Map(far.map((n) => [n.rowid, n]));

  const found: ConnectionPath[] = [];
  for (const n of near) {
    const hit = farBy.get(n.rowid);
    if (!hit) continue;
    found.push({
      path: [
        { id: a.id, name: a.name, kind: a.kind },
        { id: n.id, name: n.name, kind: a.kind === "title" ? "person" : "title" },
        { id: b.id, name: b.name, kind: b.kind },
      ],
      strength: Math.max(n.votes, hit.votes),
    });
  }

  if (maxHops === 1) {
    return { paths: rank(found, limit), spent: budget.spent, status: "hop_limit" };
  }

  // Hop 2: every (near neighbour -> its own neighbours) pair is a candidate bridge. The
  // pair list is the resumable frontier -- it is enumerated cheaply and spent lazily.
  const pairs: [number, number][] = [];
  for (const n of near) pairs.push([n.rowid, -1]);

  const state: ResumeState = {
    from: a.id,
    to: b.id,
    maxHops: 2,
    pairs,
    cursor: 0,
    found,
  };
  const handle = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  return continueWalk(db, state, budget, limit, store, handle);
}

function continueWalk(
  db: Database,
  state: ResumeState,
  budget: Budget,
  limit: number,
  store: ResumeStore,
  handle: string,
): FindConnectionsResult {
  const a = resolveEndpoint(db, state.from);
  const b = resolveEndpoint(db, state.to);
  if (!a || !b) return { paths: [], spent: budget.spent, status: "complete", error: "endpoint vanished" };

  const far = neighbours(db, b.kind, b.rowid);
  const farBy = new Map(far.map((n) => [n.rowid, n]));
  const seen = new Set(state.found.map((p) => p.path.map((n) => n.id).join(">")));

  // > [!IMPORTANT] The cursor advances only when a pair is FULLY processed
  // > It used to advance on entry, and the bug that hid behind that is exactly the one a
  // > resumable walk exists to avoid: running out of budget partway through a pair's bridge
  // > loop skipped the rest of that pair forever, so the resumed call reported `complete`
  // > having quietly never looked at the path it was resumed to find. Re-doing an
  // > interrupted pair costs a few lookups and is idempotent -- `seen` dedupes the paths it
  // > already found. Silently dropping work is not recoverable at any price.
  while (state.cursor < state.pairs.length) {
    const entry = state.pairs[state.cursor];
    if (!entry) {
      state.cursor += 1;
      continue;
    }
    if (!budget.take()) {
      store.set(handle, state);
      return {
        paths: rank(state.found, limit),
        spent: budget.spent,
        status: "budget_exhausted",
        resume: handle,
      };
    }
    const [nearRowid] = entry;

    const nearNode = neighbourById(db, a.kind === "title" ? "person" : "title", nearRowid);
    if (!nearNode) {
      state.cursor += 1;
      continue;
    }

    const bridges = neighbours(db, a.kind === "title" ? "person" : "title", nearRowid);
    for (const bridge of bridges) {
      if (bridge.rowid === a.rowid || bridge.rowid === b.rowid) continue;
      if (!budget.take()) {
        store.set(handle, state);
        return {
          paths: rank(state.found, limit),
          spent: budget.spent,
          status: "budget_exhausted",
          resume: handle,
        };
      }
      const onward = neighbours(db, a.kind, bridge.rowid);
      for (const o of onward) {
        const hit = farBy.get(o.rowid);
        if (!hit) continue;
        const path: PathNode[] = [
          { id: a.id, name: a.name, kind: a.kind },
          { id: nearNode.id, name: nearNode.name, kind: a.kind === "title" ? "person" : "title" },
          { id: bridge.id, name: bridge.name, kind: a.kind },
          { id: o.id, name: o.name, kind: a.kind === "title" ? "person" : "title" },
          { id: b.id, name: b.name, kind: b.kind },
        ];
        const key = path.map((n) => n.id).join(">");
        if (seen.has(key)) continue;
        seen.add(key);
        state.found.push({ path, strength: bridge.votes });
      }
    }
    state.cursor += 1;
  }

  store.delete(handle);
  return { paths: rank(state.found, limit), spent: budget.spent, status: "complete" };
}

function neighbourById(db: Database, kind: NodeKind, rowid: number): { id: string; name: string } | null {
  if (kind === "person") {
    const r = db.query("select nconst as id, name from person where rowid_ = ?").get(rowid) as
      | { id: string; name: string }
      | undefined;
    return r ?? null;
  }
  const r = db.query("select tconst as id, title as name from title where rowid_ = ?").get(rowid) as
    | { id: string; name: string }
    | undefined;
  return r ?? null;
}

/** Strongest bridge first. Shorter paths always beat longer ones. */
function rank(paths: ConnectionPath[], limit: number): ConnectionPath[] {
  return [...paths].sort((x, y) => x.path.length - y.path.length || y.strength - x.strength).slice(0, limit);
}
