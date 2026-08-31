# spellfix1 — SQLite's fuzzy-match extension, vendored

`spellfix.c` is SQLite's own `ext/misc/spellfix.c`, unmodified. Public domain, same as
SQLite itself. Upstream: <https://sqlite.org/spellfix1.html>.

## Why it is here

finderr needs typo-tolerant search: `brigerton` has to find *Bridgerton*. SQLite's FTS5
index in `titles.db` uses the `unicode61` tokenizer, which matches whole words and so
cannot survive a typo. Before this, the gap was filled by a hand-rolled trigram index
built in RAM at every boot — and that turned out to be the single most expensive thing
in the product:

| | in-memory pool | spellfix1 |
|---|---|---|
| RSS | **1,514 MB** | 78 MB |
| GC-traceable objects | 9,066,929 | ~0 (off-heap, in SQLite) |
| Built | every boot, 4.2–10.8 s | once, 1.7 s, persisted in the index |
| Disk | 0 | 18.7 MB |
| Query latency | — | ~12 ms |

Measured 2026-08-30 against the real 205,187-row pool under `--memory=1500m`.

**The reason this mattered was CPU, not memory.** A 1.5 GB JS heap made of ~9 million
small objects keeps JavaScriptCore's collector permanently busy: two `HeapHelper` threads
burned 14.5% of a core while the application thread used 2.9%, on a container serving no
traffic at all. Object *count* is what costs, not bytes — so the fix is not a smaller heap
but no heap, which is what moving the data into SQLite achieves.

## Why it is vendored rather than fetched at build time

The Docker build must work offline and reproducibly. This file is 100 KB and changes
approximately never.

## Building it

Compiled by a Dockerfile stage against Alpine's `sqlite-dev`, for whichever platform is
being built. It needs no configure and no flags beyond the defaults:

```sh
gcc -O2 -fPIC -shared spellfix.c -o spellfix1.so
```

> [!IMPORTANT] The NAS has no AVX, so the build must stay baseline
> The Synology's Celeron J4125 reports only `popcnt sse4_1 sse4_2 ssse3` — no `avx`,
> no `avx2`. A default `-march=x86-64` build is baseline and verified clean: the amd64
> binary disassembles to **zero** AVX/AVX2 instructions and loads on that CPU. Do not
> add `-march=native` or `-mavx2` to this build; it would produce a binary that dies
> with an illegal instruction on the deployment target. This is the same trap the
> Dockerfile already records for Bun (`--target=bun-linux-x64-baseline`).

## Loading it

`Database.loadExtension()` in `bun:sqlite`. Two platform notes:

- **Linux/Alpine (container):** works directly, musl is fine.
- **macOS (dev):** Apple's system SQLite has extension loading **disabled**, so
  `Database.setCustomSQLite()` must point at a Homebrew libsqlite3 first. If that is
  missing, finderr logs loudly and serves FTS-only rather than refusing to boot.
