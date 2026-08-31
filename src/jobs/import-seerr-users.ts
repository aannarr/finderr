#!/usr/bin/env bun
/**
 * Import Seerr's users so they can sign in with "Continue with Plex".
 *
 * A ONE-SHOT job, run by hand, safe to run twice. It creates a finderr user row carrying
 * the Plex id Seerr already recorded; nothing else about the account is copied and no
 * invite is minted. See `src/lib/seerr-import.ts` for why that is enough and for the rule
 * that identity is the Plex ID and never the username.
 *
 *   bun src/jobs/import-seerr-users.ts --from /data/seerr.sqlite3
 *   bun src/jobs/import-seerr-users.ts --from /data/seerr.sqlite3 --exclude 1847206
 *   bun src/jobs/import-seerr-users.ts --from /data/seerr.sqlite3 --exclude 1847206 --commit
 *
 * > [!IMPORTANT] DRY RUN IS THE DEFAULT. `--commit` is the only thing that writes
 * > Creating accounts is not undone by running the job again, so the safe mode is the one
 * > you get by forgetting a flag. `--dry-run` is accepted and is a no-op, for the operator
 * > who would rather say it than trust a default.
 *
 * > [!CAUTION] Point `--from` at a COPY of Seerr's database, not at the live file
 * > Seerr keeps its SQLite open in WAL mode. This job opens read-only and cannot corrupt
 * > anything, but a copy also means the numbers in the dry run are the numbers the commit
 * > will act on, with no writer moving underneath. For example:
 * >
 * >   cp /path/to/seerr/config/db/db.sqlite3 /path/to/finderr/data/seerr.sqlite3
 * >   docker compose exec finderr bun src/jobs/import-seerr-users.ts --from /data/seerr.sqlite3
 *
 * The Seerr database is never written to and is opened `readonly` to guarantee it.
 */

import { Database } from "bun:sqlite";
import { AuthStore } from "../lib/auth-store";
import { loadConfig } from "../lib/config";
import {
  applySeerrImport,
  type ImportPlan,
  normalisePlexId,
  planSeerrImport,
  readSeerrUsers,
  type SeerrUser,
} from "../lib/seerr-import";
import { Store } from "../lib/store";

interface Args {
  from: string | null;
  exclude: string[];
  commit: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { from: null, exclude: [], commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i] ?? null;
    else if (a === "--exclude") {
      // Comma or repeated flag, both. An operator naming three ids should not have to
      // remember which one this job wanted.
      for (const part of (argv[++i] ?? "").split(",")) {
        const id = normalisePlexId(part);
        if (id) args.exclude.push(id);
      }
    } else if (a === "--commit") args.commit = true;
    else if (a === "--dry-run") args.commit = false;
    else if (a === "--help" || a === "-h") args.from = null;
  }
  return args;
}

function report(plan: ImportPlan, users: SeerrUser[], exclude: string[], commit: boolean): void {
  const mode = commit ? "COMMIT" : "DRY RUN -- nothing will be written";
  console.log(`\nseerr import: ${mode}`);
  console.log(`source rows: ${users.length}   excluded ids: ${exclude.join(", ") || "(none)"}\n`);

  if (plan.creates.length) {
    console.log(`WOULD CREATE (${plan.creates.length}), all as role "user":`);
    for (const c of plan.creates) {
      const flag = c.seerrAdmin ? "  <-- ADMIN IN SEERR, importing as a plain user" : "";
      console.log(`  + plexId ${c.plexId.padEnd(12)} ${c.displayName}${flag}`);
    }
  } else {
    console.log("WOULD CREATE: nothing. Every Plex account here already has a finderr row.");
  }

  if (plan.skips.length) {
    console.log(`\nSKIPPED (${plan.skips.length}):`);
    for (const s of plan.skips) {
      const who = s.plexUsername ?? `seerr#${s.seerrId}`;
      console.log(`  - ${String(s.plexId ?? "-").padEnd(12)} ${who.padEnd(20)} ${s.reason}`);
    }
  }

  // The one thing a silent run could get catastrophically wrong: importing the operator's
  // own Plex account as a second, non-admin row beside their real one.
  const unexcludedAdmins = plan.creates.filter((c) => c.seerrAdmin);
  if (unexcludedAdmins.length) {
    console.log(
      `\n!! ${unexcludedAdmins.length} Seerr ADMIN account(s) are in the create list.` +
        "\n!! If one of them is you, --exclude that plexId: signing in with Plex would" +
        "\n!! drop you into the new plain-user row, not your existing admin account.",
    );
  }
}

/**
 * Open Seerr's database read-only, so a mistake in this file cannot reach its data.
 *
 * > [!CAUTION] A plain `cp` of a WAL database does not produce a readable snapshot
 * > Seerr runs in WAL mode, and SQLite opening a WAL database READ-ONLY needs the `-wal`
 * > sidecar (it cannot create the `-shm` it would otherwise need). Copying only the
 * > `.sqlite3` therefore fails with a bare `SQLITE_CANTOPEN: unable to open database
 * > file`, which names neither WAL nor the missing file and reads like a permissions
 * > problem. Measured here, not reasoned about.
 * >
 * > The fix is to snapshot it properly rather than to copy harder -- `.backup`
 * > checkpoints the WAL into one self-contained file, with no downtime for Seerr:
 * >
 * >   sqlite3 /path/to/db.sqlite3 ".backup /path/to/seerr-import.sqlite3"
 * >
 * > `immutable=1` would also open it, and is deliberately NOT used: on a file that is
 * > still being written it returns stale or torn rows with no error at all, which is
 * > exactly the failure this job must never have.
 */
function openSeerr(path: string): Database {
  try {
    return new Database(path, { readonly: true });
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(
      `could not open ${path} read-only: ${msg}\n` +
        "  If Seerr's database is in WAL mode, a plain `cp` of the .sqlite3 alone is not\n" +
        "  readable. Take a real snapshot instead (no downtime needed):\n" +
        '    sqlite3 <seerr>/db.sqlite3 ".backup <finderr-data>/seerr-import.sqlite3"',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (!args.from) {
    console.error(
      "usage: bun src/jobs/import-seerr-users.ts --from <seerr.sqlite3> [--exclude <plexId,...>] [--commit]",
    );
    process.exit(2);
  }

  const seerr = openSeerr(args.from);
  const users = readSeerrUsers(seerr);

  const cfg = loadConfig();
  const store = new Store(cfg);
  const auth = new AuthStore(store.db);

  const existingPlexIds = auth
    .listUsers()
    .map((u) => u.plexId)
    .filter((id): id is string => id !== null);

  const plan = planSeerrImport({ users, existingPlexIds, exclude: args.exclude });
  report(plan, users, args.exclude, args.commit);

  if (!args.commit) {
    console.log("\nNothing written. Re-run with --commit to apply.\n");
    seerr.close();
    return;
  }

  const created = applySeerrImport(auth, plan);
  console.log(`\nCreated ${created.length} finderr user(s).`);
  for (const c of created) console.log(`  ${c.plexId} -> ${c.userId}`);
  console.log("\nThey can now use “Continue with Plex”. No invite is needed and none was minted.\n");
  seerr.close();
}

if (import.meta.main) await main();
