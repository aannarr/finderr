# Running finderr in less memory

finderr serves every page from a local SQLite index. On a well-stocked library that index is
around **1.9 GB**, and how fast finderr feels is mostly a question of **how much of it the
operating system is allowed to keep in the page cache** -- not how fast the disk is, and not how
many CPU cores you give it.

This page is what a memory ladder measured, and what to set at 2 GB, 1 GB and 512 MB.

**You do not have to read it to run finderr.** Everything below is derived automatically at boot
from the container's real memory limit and the real size of the index. The environment variables
exist for the cases the measurement cannot see.

---

## The short version

| If you can give finderr | expect |
|---|---|
| **3 GB or more** | everything below is moot. Full speed, the whole index cached, the first page after a restart is as fast as the thousandth. |
| **2 GB** | full speed. The index does not fit with room to spare, and it does not need to -- see the crossover below. |
| **1 GB** | full speed once warm. The first minute after a restart is slow on a spinning disk (seconds per new query, not milliseconds) and unremarkable on an SSD. |
| **512 MB** | still correct, still usable, noticeably slower. This is the floor. |
| **below ~384 MB** | do not. Query time degrades several-fold and keeps going. |

The single most useful thing to know: **finderr's queries touch about 500 MB of the index**, not
all of it. That is why a 1 GB container works at all, and why 512 MB is the point where things
start to hurt rather than 1.9 GB.

---

## What was measured

The same 1,868 MB index, the same Bun runtime, the same 29-query suite covering every render path
the product has -- run inside containers capped from 8 GB down to 256 MB, on two machines:

- **A 4-core NAS with a 9-disk RAID5 array of spinning disks.** Slow storage, slow CPU.
- **A developer laptop's container VM on NVMe.** Fast storage, fast CPU.

Each cell clones the index, optionally reads it end to end once (the "prefault"), then runs every
query once in order -- a ledger of a container's first seconds -- and then runs them repeatedly for
the steady state. The container's own cgroup is read at four points, because **nothing inside the
process can see the page cache and `docker stats` actively hides it**: `docker stats` subtracts
`inactive_file`, which is exactly the cached index, so a container holding 900 MB of index reports
about 75 MB and looks idle.

Reproduce a cell with:

```bash
docker run --rm -m 1024m --memory-swap 1024m -v /your/bench:/bench \
  --entrypoint bun ghcr.io/OWNER/finderr:latest \
  /app/src/jobs/bench-memory.ts --source /bench/titles.db --scratch /bench/mem/x \
  --label x --prefault --json /bench/results/x.json
```

---

## Finding 1 -- the prefault is worth up to 32x, and it keeps working long past the point it "fits"

finderr reads the whole index sequentially at boot and after every nightly index swap. On a
spinning array this replaces thousands of random 1 MB reads with one streaming read, and it is the
single largest performance feature in the product.

The obvious rule -- *only prefault if the index fits in memory* -- is **wrong, and measurably so.**
Prefaulting an index larger than the budget does not fail. It fills the budget to the brim and
keeps working:

| memory budget | index / budget | of the index, still resident | first-touch suite, prefault ON | prefault OFF |
|---|---|---|---|---|
| 3072 MB | 61% | 99% | **224 ms** | 7,195 ms |
| 1500 MB | 125% | 79% | **480 ms** | 7,858 ms |
| 1024 MB | 182% | 54% | 7,865 ms | 7,573 ms |

*(spinning array; the laptop shows the same crossover at the same ratios, with all the times an
order of magnitude smaller because its storage is not the bottleneck.)*

At a **1500 MB** budget the index is **125% of the budget** -- it plainly does not fit -- and the
prefault is still worth **16x**. It only stops paying somewhere below that, when too little of the
file survives for the queries to land on.

So the derived rule is not "does it fit" but "will enough of it stay", and the threshold is
measured rather than guessed. It is stated once, in `src/lib/memory-budget.ts`.

## Finding 2 -- the steady state does not care about the cap until 512 MB

Warm query time was **flat within noise from 8 GB down to 512 MB** on both machines. It is the
working set that matters, and the working set is about 500 MB:

| memory budget | warm suite (spinning array) | warm suite (NVMe VM) |
|---|---|---|
| 3072 MB | 128 ms | 51 ms |
| 1500 MB | 129 ms | 52 ms |
| 1024 MB | 130 ms | 52 ms |
| 768 MB | 132 ms | 49 ms |
| 512 MB | see the table below | 54 ms |
| 384 MB | -- | **267 ms** |
| 256 MB | -- | **743 ms** |

Between 512 MB and 384 MB the working set stops fitting and query time goes up roughly five-fold,
then keeps going. **384 MB is not a smaller version of 512 MB; it is a different regime.**

## Finding 3 -- CPU cores do nothing; single-core speed does everything

Same budget, same index, only the core count moving:

| cores | warm suite |
|---|---|
| 1 | 52.2 ms |
| 2 | 49.4 ms |
| 3 | 48.7 ms |

**finderr's render path is one thread.** A query is a synchronous SQLite call; extra cores are
available for other concurrent requests but do nothing for any single one. Going from 3 cores to 1
costs about 7%.

Single-core *speed* is a completely different matter. The same warm suite is **128 ms on the NAS's
low-power 4-core CPU and 37 ms on a laptop** -- a 3.5x gap with no storage component in it at all,
because at that point everything is in RAM on both machines. If finderr feels uniformly slow rather
than slow-on-first-load, that is the CPU and no amount of memory will change it.

## Finding 4 -- keep memory-mapping on

Turning `mmap_size` off reads **41x fewer bytes from the disk and is 2.6x slower** on the array, and
is 33% slower warm on NVMe. The read amplification that mmap causes is not waste; it is prefetching,
and a striped array of spinning disks is enormously better at bulk sequential reads than at small
random ones. There is no measured configuration in which disabling it won.

---

## Running at a given budget

Set the container's memory limit and let finderr derive the rest. It reads the cgroup, so a
`docker run -m` or a compose `mem_limit` is all it needs.

### 3 GB and up -- the recommended shape

```yaml
services:
  finderr:
    mem_limit: 3g
    memswap_limit: 3g      # equal to mem_limit forbids swap. Swapping an index is the worst case.
```

Nothing to tune. The whole index stays resident, the prefault completes and holds, and first-load
and steady-state performance are the same thing.

### 2 GB

```yaml
    mem_limit: 2g
    memswap_limit: 2g
```

Also nothing to tune. The index is slightly larger than the budget and the prefault still retains
most of it -- this is squarely in the range where partial residency works. Expect full speed.

### 1 GB

```yaml
    mem_limit: 1g
    memswap_limit: 1g
```

Warm performance is unaffected -- the ~500 MB working set fits comfortably. What you lose is the
first minute after a restart or after the nightly index rebuild, because too little of the index
stays resident for the prefault to be worth its own read. finderr detects this and **skips the
prefault**, which saves a pointless 1.9 GB read rather than making anything faster.

On an SSD this is barely perceptible. On a spinning disk the first few distinct queries after a
restart cost seconds rather than milliseconds, and it settles as the pages that matter get touched.

If you would rather spend the I/O and keep the prefault anyway:

```yaml
    environment:
      FINDERR_INDEX_PREFAULT: "true"
```

### 512 MB -- the floor

```yaml
    mem_limit: 512m
    memswap_limit: 512m
```

This works and it is slower, in the steady state and not just at boot -- the working set no longer
quite fits, so ordinary queries fault pages in. Two things help:

```yaml
    environment:
      FINDERR_SQLITE_CACHE_MB: "16"     # every MB of pager cache is a MB not holding index pages
```

and **giving finderr its own container rather than sharing the budget with anything else**. At this
size the poster cache, the application database and the JS heap are all competing for the same few
hundred megabytes.

Below about 384 MB, don't. It runs, and it is several times slower again.

---

## Environment variables

All four default to *derive it from the measured limit and the real index size*. Setting one is a
claim that you know something the measurement cannot see; each is echoed in the boot log beside
what it replaced.

| Variable | Does |
|---|---|
| `FINDERR_MEMORY_BUDGET_MB` | Use this ceiling instead of reading the cgroup. For a host whose real limit is not a cgroup limit -- a VM sized for several services, or a box where something else is expected to want most of the RAM. |
| `FINDERR_SQLITE_MMAP_MB` | `pragma mmap_size`, in MB. `0` disables memory-mapping. See Finding 4 before you do. |
| `FINDERR_SQLITE_CACHE_MB` | `pragma cache_size`, in MB. Small is correct -- it duplicates pages the mmap already holds. |
| `FINDERR_INDEX_PREFAULT` | `true` / `false` to force the boot-time page-cache read on or off. |

## Checking what it decided

`/api/health` reports the whole decision and what came of it (the detail requires the admin key):

```json
"index": {
  "warm": {
    "prefault": true,
    "last": { "readMb": 1868, "ms": 10520, "residentMb": 1851 },
    "tuning": { "budgetMb": 3072, "budgetSource": "cgroup-v1", "mmapMb": 1868, "cacheMb": 154, "prefault": true }
  }
}
```

Three things are worth reading there:

- **`budgetSource: "host-ram"`** means no cgroup limit was found and finderr is sizing itself
  against the whole machine. Correct on bare metal; on a container it means the limit is not
  visible and you should set `FINDERR_MEMORY_BUDGET_MB`.
- **`last: null`** a few minutes after a restart means the prefault has not completed. Either it is
  still going, or it failed -- the log line says which.
- **`residentMb` far below `readMb`** means it ran and the memory cap took most of it back. That is
  the shape this whole page is about, and the fix is a bigger limit rather than a setting.
