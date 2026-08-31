# Importing your Seerr users into finderr

Bring the people who already use Overseerr/Jellyseerr across, so they can sign in with
**Continue with Plex** without being invited one at a time.

This does not weaken finderr's invite-only rule and it mints no invites. It works because
of how the Plex sign-in already decides, not because of a hole in it -- see
[Why this is not a bypass](#why-this-is-not-a-bypass) before you run it.

> [!IMPORTANT]
> Dry run is the DEFAULT. `--commit` is the only flag that writes anything.
> Run it twice if you like -- an account finderr already holds is skipped, so a second
> run creates nothing.

---

## What it does, in one sentence

For every Seerr user with a Plex account, create one finderr user row carrying that
**Plex ID**, as role `user`.

Nothing else is copied. Not the email, not the password hash, not the Plex token, not the
request history, not the quotas. The job never opens those columns at all.

---

## Before you start

| You need | Why |
|---|---|
| Shell access to the host running finderr | The job runs inside the finderr container |
| Read access to Seerr's `db.sqlite3` | The source. Opened **read-only**, never written |
| The Plex ID of any account you must NOT import | Usually your own -- see the warning below |

> [!CAUTION]
> Find your OWN Plex ID first, and exclude it.
> If you already have a finderr admin account, importing your own Plex account creates a
> **second** row. Signing in with Plex would then drop you into that new plain-`user` row
> while your admin account sits beside it, untouched and unreachable by that door.
>
> This bites hardest when your finderr admin account has **no Plex link yet** (for example
> you signed up with a passkey). There is no unique-index collision to save you in that
> case -- the import simply succeeds and you end up with two accounts.
>
> The job flags any Seerr **admin** in the dry run for exactly this reason, but the flag is
> a prompt to check, not a filter. Read the list.

### Step 0 -- find the IDs

```bash
sqlite3 -header -column "$SEERR_CONFIG/db/db.sqlite3" \
  "select id, plexId, plexUsername, permissions from user order by id"
```

`permissions` with the `2` bit set is a Seerr admin. Note the `plexId` of anybody you want
to leave out; that number is what `--exclude` takes.

---

## Step 1 -- snapshot Seerr's database

> [!CAUTION]
> A plain `cp` of the `.sqlite3` produces a file the job cannot read, and the error does not say so.
> Seerr runs SQLite in **WAL mode**. Opening a WAL database read-only requires its `-wal`
> sidecar, which a lone `cp` leaves behind, and SQLite then fails with a bare
> `SQLITE_CANTOPEN: unable to open database file` -- which names neither WAL nor the
> missing file, and reads like a permissions problem.
>
> Use `.backup`. It checkpoints the WAL into one self-contained file and needs **no Seerr
> downtime**.

```bash
./guides/snapshot-seerr-db.sh "$SEERR_CONFIG/db/db.sqlite3" "$FINDERR_DATA/seerr-import.sqlite3"
```

Or by hand:

```bash
sqlite3 "$SEERR_CONFIG/db/db.sqlite3" ".backup $FINDERR_DATA/seerr-import.sqlite3"
```

Put the snapshot in finderr's **data directory**, because that is the one path the
container can see. It arrives inside as `/data/seerr-import.sqlite3`.

> [!WARNING]
> The snapshot holds every user's Plex token and password hash. Delete it when you are done
> ([Step 4](#step-4----clean-up)). It is a copy of a credential store, not a spreadsheet.

---

## Step 2 -- dry run

```bash
docker compose exec finderr \
  bun src/jobs/import-seerr-users.ts \
    --from /data/seerr-import.sqlite3 \
    --exclude <your-plex-id>
```

You get the whole plan and no writes:

```
seerr import: DRY RUN -- nothing will be written
source rows: 11   excluded ids: 1234567

WOULD CREATE (10), all as role "user":
  + plexId 7654321      someone
  ...

SKIPPED (1):
  - 1234567      you                  excluded

Nothing written. Re-run with --commit to apply.
```

**Read the create list before you go on.** Every name on it becomes an account that can
sign in.

`--exclude` takes a comma-separated list, or repeat the flag:
`--exclude 1234567,7654321`.

### The reasons a row is skipped

| Reason | Means |
|---|---|
| `excluded` | You named this Plex ID on the command line |
| `already-linked` | finderr already has a row for this Plex ID. **This is what makes the job re-runnable** |
| `no-plex-id` | A Seerr local or Jellyfin user. There is no Plex account to sign in with, so there is nothing to import |
| `duplicate-in-source` | Two Seerr rows carry one Plex ID. The first wins; only one row is ever created |

---

## Step 3 -- commit

Same command, plus `--commit`:

```bash
docker compose exec finderr \
  bun src/jobs/import-seerr-users.ts \
    --from /data/seerr-import.sqlite3 \
    --exclude <your-plex-id> \
    --commit
```

Verify:

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:7979/api/admin/users | jq '.users[] | {displayName, role, plexUsername}'
```

Everybody imported should be `"role": "user"`. If one is not, that is a bug -- the job
hardcodes the role and never reads a Seerr permission bit as authority.

---

## Step 4 -- clean up

```bash
rm -f "$FINDERR_DATA/seerr-import.sqlite3"
```

---

## Why this is not a bypass

`/api/auth/plex/finish` decides in this order:

1. **`getUserByPlexId(account.id)`** -- an existing linked row signs in. The only other
   thing checked on this branch is whether the account is disabled.
2. Otherwise a valid **invite** must be carried, or it is refused.

The import works entirely through branch 1. It pre-creates the row that branch is looking
for, so a migrated user redeems nothing and holds no credential. There is still no
"any Plex account may sign in" mode, no invite is minted, and nothing about the ceremony
changed. A regression test in `src/lib/seerr-import.test.ts` pins that branch, so a
refactor of the sign-in cannot quietly remove the thing this depends on.

**Identity is the Plex ID, never the username.** A Plex username is editable by its owner,
so matching on it would hand an account to whoever renamed themselves into it. Seerr stores
the ID as an integer and finderr as TEXT; the job stringifies at the boundary so `2326453`
and `"2326453"` are one identity and never two.

---

## If a migrated user still cannot sign in

Check `FINDERR_PLEX_MACHINE_ID` first.

That variable is **gate two**: with it set, an account must additionally have access to
*your* Plex server before it may sign in, checked against Plex's own resource list. It is a
filter on top of both branches above, never a substitute for either.

A Seerr user who was un-shared on Plex but left in Seerr will import fine and then be
refused at sign-in. **That is the gate working**, and the fix is on the Plex side -- share
the server with them again. Nothing in finderr needs changing.

To see who currently has access:

```bash
curl -s -H "X-Plex-Token: $PLEX_TOKEN" https://plex.tv/api/users
```

Leaving `FINDERR_PLEX_MACHINE_ID` unset turns gate two off, which is the right default for
a checkout that does not know which Plex server it belongs to. It is not a way to fix this
particular problem -- it just stops asking the question for everyone.

Other things to check, in order:

1. **The account is disabled.** `GET /api/admin/users` shows `disabled`.
2. **They approved a different Plex account.** People have more than one. The ID they
   signed in with must match the imported one.
3. **The row was never created.** Re-run the dry run: `already-linked` means it is there.

---

## Related

- `src/lib/seerr-import.ts` -- the planner and the rules, with the reasoning
- `src/jobs/import-seerr-users.ts` -- the entry point
- `src/lib/plex-auth.ts` -- the sign-in ceremony and both gates
