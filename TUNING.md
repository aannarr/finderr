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
| **1 GB** | full speed once warm. On a spinning disk the first minute after a restart is slower -- working through a few dozen distinct pages costs seconds in total rather than milliseconds. On an SSD you will not notice. |
| **512 MB** | the floor, and it is a real step down rather than a small one: on a spinning disk the first pass over the app costs **5x** what it does at 768 MB. Fine on an SSD, grudging on spinning rust. |
| **below ~384 MB** | do not. Steady-state query time degrades several-fold and keeps going. |

The single most useful thing to know: **finderr's queries touch about 500 MB of the index**, not
all of it. That is why a 1 GB container works at all, and why the trouble starts near 500 MB rather
than near 1.9 GB. Two different things break at two different sizes, and it is worth knowing which
is which:

- Around **1 GB**, the boot-time prefault stops being worth its own read. You lose a fast first
  minute. The steady state is untouched.
- Around **512 MB**, the *working set itself* stops fitting. That one is not about boot.

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

Reproduce a cell against your own hardware and your own index. The runtime image ships the job, so
this needs nothing built -- point `--source` at a **copy** of your index, never at the live one
(the harness refuses a path inside a `data/` directory, and clones before it opens anything):

```bash
docker run --rm -m 1024m --memory-swap 1024m -v /your/bench:/bench \
  --entrypoint bun ghcr.io/OWNER/finderr:latest \
  /app/src/jobs/bench-memory.ts --source /bench/titles.db --scratch /bench/mem/x \
  --label x --prefault --json /bench/results/x.json
```

Drop `--prefault` for the other half of the pair, and read the two together --
`bun /app/src/jobs/bench-ladder-report.ts /bench/results/*.json` prints the table. Available from
the release that carries this page; an older image has no `bench-memory.ts`.

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

## Finding 2 -- the second cliff is the working set, and it is at about 500 MB

The queries touch roughly **500 MB** of the 1,868 MB index -- every rung that skipped the prefault
read 479-484 MB off the disk to answer the whole suite once, and the laptop's cells settled at
518 MB resident. So the number that decides whether finderr is comfortable is not the size of the
index; it is that 500 MB.

Working through the whole app once, on the spinning array, with no prefault:

| memory budget | first pass over 29 distinct queries | read from disk |
|---|---|---|
| 3072 MB | 7,195 ms | 479 MB |
| 1500 MB | 7,858 ms | 479 MB |
| 1024 MB | 7,573 ms | 479 MB |
| 768 MB | 8,272 ms | 482 MB |
| **512 MB** | **40,396 ms** | **1,587 MB** |

Nothing much happens between 3 GB and 768 MB. Between 768 MB and 512 MB the working set stops
fitting, so pages get evicted before they are reused and the same work reads three times the data.
On the laptop the equivalent break lands lower, at 384 MB, where steady-state query time triples
and at 256 MB roughly triples again.

> **A caveat on "warm" numbers, including the ones people usually quote.** Repeated-query timing
> was flat within noise from 8 GB all the way down to 512 MB -- 127-135 ms on the array at every
> rung. That is true and it is misleading: running one query twenty times in a row keeps its own
> pages hot under any cap. The first-pass column above is the honest proxy for a real mixed
> workload, and it is the one that shows the cliff.

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

**finderr maps the whole index regardless of the memory limit, and that is correct rather than
reckless.** `mmap_size` is address space, not memory: the kernel charges a page when something
faults it in, not when it is mapped, and it charges the same either way. Mapping 1.9 GB inside a
512 MB container just means at most 512 MB of it is resident at a time -- which was true anyway.

Shrinking it to "fit" the memory limit is the harmful option, and it is harmful by a lot. Measured
at a 1 GB budget on the spinning array, moving nothing but this setting:

| `mmap_size` | first pass over the app | read from disk |
|---|---|---|
| 1 GB (matched to the memory limit) | **29,458 ms** | 555 MB |
| 1.9 GB (the whole index) | **12,198 ms** | 746 MB |

The matched-to-the-limit version reads **26% less and is 2.4x slower**, because past the limit
SQLite fetches the minimum at random instead of letting the mapping pull bulk windows off a disk
that is far better at bulk than at random. If you want to give finderr less memory, shrink
`FINDERR_SQLITE_CACHE_MB` -- that one is real memory. Leave the map alone.

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

Steady-state performance is unaffected -- the ~500 MB working set fits comfortably. What you lose
is the fast first minute after a restart or after the nightly index rebuild, because too little of
the index would stay resident for the prefault to be worth its own read. finderr detects this and
**skips the prefault**, which saves a pointless 1.9 GB read rather than making anything faster.

Concretely, on the spinning array: working through the whole app once costs about **7.6 s** here
against **0.5 s** at 1.5 GB, and then it is warm and the difference is gone. On an SSD the gap is
tens of milliseconds and you will not see it.

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

This is the rung where the working set stops fitting, and on a spinning disk that is a **5x** step
rather than a gentle slope: the first pass over the app measured 40 s against 8 s at 768 MB, reading
1.6 GB instead of 0.5 GB, because pages get evicted before they are used again. On an SSD the same
eviction happens and costs far less, so 512 MB is genuinely fine there and grudging on spinning
rust.

**If you have 768 MB rather than 512 MB, use it.** That single step is worth more than any setting
on this page.

At this size, two things help:

```yaml
    environment:
      FINDERR_SQLITE_CACHE_MB: "16"     # every MB of pager cache is a MB not holding index pages
```

and **giving finderr its own container rather than sharing the budget with anything else**. The
poster cache, the application database and the JS heap are all competing for the same few hundred
megabytes here, and they were not in the measurements above.

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
