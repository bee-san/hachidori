# Memory

Hachidori can keep dictionary hash indexes in memory or read them on demand. On direct OPFS storage (normal
Chrome installations), it reads entries and images from disk when needed by
default. This avoids copying every installed definition into the WebAssembly
heap while retaining all lookup results. Settings → Advanced → Memory →
**Dictionary entries** can instead keep entries in memory for the fastest
lookups. **Dictionary hash indexes** selects hash residency. **Use less ram by default**
is off by default: Automatic keeps all hashes in memory. Turning the switch on
keeps small hashes within one shared 65 MiB resident budget and pages the rest
on direct OPFS. **Low memory mode** uses a 32 MiB budget.
Low memory mode also reduces import peak memory and returns unused engine
memory after changes. This page explains the storage policies,
the readout, their costs, and what happens when dictionaries do not fit.

## Why the engine is large

The dictionary engine ([hoshidicts](https://github.com/bee-san/hoshidicts),
compiled to WebAssembly) opens each installed dictionary's resident files with
`mmap`: `bloom.filter` and, when present, `media.idx`, `scan.idx` and the trained
`dict.zstd`, plus `hash.table` when its hash policy keeps it resident and
`blobs.bin` when its entry policy keeps entries resident. Natively
that costs nothing until a page is touched. WebAssembly has no demand paging, so
Emscripten emulates `mmap` by allocating the whole file inside the module's
linear memory and copying the bytes in. Five things follow:

- **Every loaded dictionary's small index files are resident.** Its hash table
  is resident unless the hash policy reads it from disk, and its entries only
  with **Keep in memory**, or the automatic policy on IDBFS hosts. Paged hashes
  and entries share one 32 MiB cache instead. A dictionary's files are held once however
  many kinds it loads as (term, frequency, pitch, kanji): the kinds share one copy.
- **Images and other media are not.** `media.bin` is never copied in; the
  engine reads a file from OPFS (or IDBFS) when a popup or an Anki export asks
  for it, and the popup caches what it shows.
- **Linear memory never shrinks.** Importing a dictionary unzips it, builds its
  indexes and, on the threaded engine, runs an eight-thread worker group. On
  direct OPFS that work happens in a separate import worker that is terminated
  afterwards, so its peak is returned to the browser and the engine's heap grows
  only by the new dictionary's resident files and shared page cache; on IDBFS
  (Electron) the import runs inside the engine and the memory that peak needs is kept for the
  life of the engine worker. Disabling or removing a dictionary frees its
  files inside the heap, but the heap itself stays at its high-water mark.
- **IDBFS hosts mirror small files only.** Electron (GameSentenceMiner) and
  Chrome without OPFS sync access handles keep the dictionary files in
  IndexedDB and mirror them into the WebAssembly filesystem. Files of 1 MiB or
  more are stored as Blobs, and the mirror keeps the Blob rather than a copy
  of its bytes: a read, a page of paged entries or a media file reads only its
  range, and `mmap` copies the mapped range straight into the heap. See
  [IDBFS files](#idbfs-files).
- **The heap is capped at 4 GiB** (`-sMAXIMUM_MEMORY=4GB` in
  `wasm/CMakeLists.txt`). A library whose resident files exceed that cannot
  load completely; see [When dictionaries do not fit](#when-dictionaries-do-not-fit).

With the five recommended dictionaries (75 MB of archives) the engine heap is
about 320 MB with resident entries, and about 100 MB with paged entries in
Low memory mode in the original benchmark (Chrome 152,
direct OPFS; `benchmark/low-memory-mode.mjs`).

## Reading the numbers

Settings → Advanced → **Memory** shows *Engine memory: X GB across N
dictionaries*: the size of the engine's linear memory and the number of loaded
packages.

Below it, *Extension total: Z GB (W MB outside the engine heap)* is what the
browser measures for the offscreen document that runs the engine and every
worker it started: the engine heap plus the JavaScript of the document, the
engine worker and its threads, a running import worker and, on IDBFS hosts,
the in-memory mirror of the dictionary files. The part in brackets is what the
engine line cannot show, so it is the number to watch if Hachidori's memory
grows while *Engine memory* stays put. The figure comes from
[`performance.measureUserAgentSpecificMemory()`](https://developer.mozilla.org/docs/Web/API/Performance/measureUserAgentSpecificMemory),
which can take a few seconds and fills in on its own; where the browser does
not offer it (Firefox, or a host without cross-origin isolation) the line shows
an em dash. Chrome counts the engine heap, a `SharedArrayBuffer`, once in every
engine thread that holds a view of it, so its raw total overstates the heap
several times over; Hachidori counts the heap once.

The extension total does not include the service worker, other open Hachidori
pages (Settings itself, the toolbar), the popup on the page you are reading
(it runs in that page's process), or the browser's own per-process overhead
and shared code. Chrome's Task Manager (Shift+Esc) shows the whole process,
including those, so its *Extension: Hachidori* row is normally larger than the
extension total; the operating system's figures are larger still because they
count the browser's shared libraries in every process.

![Settings → Advanced → Memory, including independent entry and hash storage, on the light palette](assets/index-residency-memory-light.png)

![The same Memory controls on the dark palette](assets/index-residency-memory-dark.png)

Each row in Dictionaries shows *In memory: ≈ Y MB* under **Details**: that
package's resident files as described above. A package whose entries are read
from disk (the OPFS default, every package in Low memory mode, or one that did not fit) counts
only its resident files and says which of its entries and hash index are
read from disk. The hash readout separately shows the requested policy,
resident hash bytes, budget and paged package count.

![A Dictionaries row's Details with its In memory line](assets/memory-library-details.png)

The engine lines come from the engine's `hd_memory` read and the extension
total from `hd_memory_total` (see [architecture.md](architecture.md), "Runtime
messages"), asked for when you open Advanced (and again there when the engine
publishes a new generation after an import, reload or recycle); a row's
*In memory* line is asked for when you open its Details. Nothing polls.
While the engine is busy or unreachable the readout shows an em dash rather than
an error.

The total is usually larger than the sum of the rows: the difference is the
import high-water mark, the engine's own allocations and, with paged entries,
the cache of recently read entry and hash pages (`hd_memory.pageCacheBytes`, at most
32 MiB once a lookup returns). A text-only dictionary with tens of thousands of
entries is a few tens of megabytes; the largest name dictionaries are several
hundred.

## Dictionary entry storage

Settings → Advanced → Memory → **Dictionary entries** selects one policy:

- **Automatic** (default): page entries on direct OPFS; retain resident entries
  on IDBFS, where a paged read is a synchronous Blob read whose lookup cost has
  not been measured. **Read from disk** pages there too.
- **Read from disk**: page entries on either threaded backend.
- **Keep in memory**: copy entries into the engine heap. A package that cannot
  fit still falls back to paged entries as before.

Paging reads `blobs.bin` through a shared cache: 4 KiB pages, 32 MiB for all
packages together, least recently used first out. The hash policy is independent
of entry storage. A lookup that finds nothing reads no entry pages, and one that
finds entries reads only their pages. Results are identical with paged and
resident entries. A lookup keeps its pages until it returns, so the cache can
exceed its budget while one runs.

Measured with Jitendex (2026 release, 38.8 MB archive) and Pixiv Full
(2026-10-05, 387 MB archive) on Chrome 152, direct OPFS, macOS arm64
(`benchmark/low-memory-mode.mjs`, three alternating fresh profiles per
policy, 4,550 lookups looked up twice after a full Chrome restart): the two
packages' `blobs.bin` files total 569 MB and their index files 44 MB. With
**Keep in memory** the heap is 698 MB; with **Automatic** it is 68 MB after
loading and 98 MB once the cache has filled. The 4,550 lookups return identical
results either way. Their median round trip goes from 2.2 ms to 2.6 ms, p95
from 7.4 ms to 8.7 ms and p99 from 10.3 ms to 13.3 ms (medians of the three
samples' first pass); the second pass costs about the same (2.0 to 2.5 ms
median), because those lookups touch more than the 32 MiB cache holds. Imports take the same time
(about 10 s for both archives) with either policy, against 26 s in Low memory
mode.

The policy does not change import threading, pthread pool size or automatic
recycling after mutations. Changing it restarts the engine after two idle
seconds, so the old heap is returned to the browser. Lookups during startup wait
for the reloaded dictionaries. Existing installations without this option adopt
Automatic on their next engine start; installed dictionaries need no reimport.
The choice is preserved while Low memory mode forces paging, and applies again
when that mode is turned off. The selector is unavailable with the single-thread
compatibility engine.

## Dictionary hash storage

On the threaded direct OPFS backend, **Dictionary hash indexes** selects:

- **Automatic** (default): with **Use less ram by default** on, keep hashes within
  one aggregate 65 MiB resident budget in normal mode. Turning that switch off
  retains every hash in normal mode. Low memory mode uses its existing 32 MiB
  budget either way. Budgeted hashes are sorted by file size then stable package
  ID, with the rest read from disk. Each enabled package counts once, regardless
  of how many dictionary kinds it supplies.
- **Read from disk**: page every hash table through the existing entry cache.
- **Keep in memory**: retain every hash table, including in Low memory mode.

The resident hash budget is separate from the shared 32 MiB page-cache budget.
Neither excludes packages or limits results. Filters, scan metadata, media offsets
and trained compression dictionaries stay resident. The installed format stays
the same; changing the policy uses the existing idle worker restart and needs no
reimport. Import threading continues to follow Low memory mode.

**Use less ram by default** is off for new and existing installations whose
stored options do not yet include it. Explicitly saved choices are preserved.
It changes only Automatic hash storage:
explicit **Read from disk** and **Keep in memory** choices still apply. Its switch
is disabled while those choices or Low memory mode apply, preserving the saved
preference. Changing it uses the same idle worker restart, without changing entry
storage, import threading or recycling after dictionary mutations. The 65 MiB
budget is a hash residency target, not a cap on the extension's total RAM.

The selector is hidden on IDBFS and single-thread hosts, which keep resident
hashes until their read cost is measured. Stored preferences remain intact.
The [Chrome benchmark](benchmarks/index-residency.md) compares main's resident
hashes with 16, 32 and 64 MiB budgets and fully paged hashes on the same
installed files. For a 58-package library shaped like a reported one, the 32 MiB
budget shrank the engine heap from 342 MiB to 100 MiB after loading (120 MiB once
the shared cache had filled) and made lookups about 0.4 ms (22%) slower with the
OS file cache warm, or about 9 ms slower for the first lookups after the files
had left it. A library whose hashes fit the budget is unchanged.

The [normal-mode 65 MiB comparison](benchmarks/default-ram.md) measures the enabled
65 MiB policy with the full import pool, including lookup latency, rendered hovers,
startup, reimport and memory. It retains all dictionaries and complete results.

For diagnostics, `hd_memory` separates `hashBytes`, `residentHashBytes`,
`otherResidentBytes` and `residentEntryBytes` for each package. `pageCacheBytes`
remains the combined cache payload and `pageCacheBudgetBytes` its budget;
`entries` and `indexes` split its bytes,
hits, page reads and actual bytes read. `liveAllocatedBytes` and
`allocatorFreeBytes` come from the native allocator. They distinguish live heap
allocations and reusable allocator space from `heapBytes`, the WASM capacity;
none is a physical process-memory measurement. Status keeps `dictionaryCount`
as registered kinds for compatibility, and adds `registeredKindCount` and
`packageCount` explicitly.

## Low memory mode

Settings → Advanced → Memory → **Low memory mode** (off by default) does three
things:

1. **Forces entries to be read from disk**, including when **Keep in memory**
   was selected. On direct OPFS this matches the new automatic default. With
   **Automatic** hash indexes on direct OPFS it also keeps only the smallest
   hash tables in memory, within a 32 MiB budget, and reads the rest from disk
   (see [Dictionary hash storage](#dictionary-hash-storage)).
2. **Recycles the engine worker after changes.** Once an import, reimport,
   update, removal, enable/disable, custom-dictionary save or backup
   restore has settled and the engine has been idle for two seconds, the
   offscreen document terminates the engine worker and starts a new one, which
   reloads the installed dictionaries from OPFS (or IDBFS). The new worker's
   heap holds the selected resident files and cache: on IDBFS that gives the import high-water
   mark back to the browser, and on OPFS (where the import worker already
   returned it) whatever the swaps of replaced generations left in the heap.
   A pure reorder uses the already loaded native set and
   allocates no import high-water mark, so it does not request a recycle. It
   still restarts the idle window of a pending import or mode-change recycle.
3. **Imports on one thread with a minimal thread pool.** The recycled worker
   starts with a two-thread pool (one importer thread plus the WasmFS OPFS
   proxy) instead of up to nine, and `hdw_import` runs in its low-RAM mode.

The original resident-versus-Low-memory benchmark measured the five recommended
dictionaries on Chrome 152 (direct OPFS,
`benchmark/low-memory-mode.mjs`, 1,000 hovers over example sentences looked up
two to five times over, round trips from the settings page, ten fresh profiles
each way): the heap went from about 320 MB to about 70 MB right after loading
(41 MB of index files) and about 100 MB once the cache has filled, and the
median hover round trip from 3.5 ms to 3.9 ms (p95 10.7 ms to 11.7 ms). The first
pass over the hovers, with the cache still empty, costs the same. On a shared
machine single samples vary by several tenths of a millisecond either way. The
engine itself does about 7% more work per lookup when it reads entries through
the cache (Node, same hovers).

The other costs are that imports take longer (Jitendex in about 3.9 s
single-threaded instead of 1.6 s in the eight-thread group), and that
dictionaries reload briefly after a change: hover lookups during that reload
wait for the engine, and Settings shows *Starting the engine and loading
dictionaries…* for the reload's duration (about 1 ms per MB of index files).
Turning the mode on or off also recycles the worker once, so the pool size
and the import threading always match the option; entry paging is otherwise
controlled independently by the storage policy.

On OPFS the engine keeps each paged `blobs.bin` and `hash.table`, and each
`media.bin`, open through a sync access handle, which locks the file for as long as its package
is loaded. A worker that opens a file another context still holds reads it
through a slower `Blob` instead of failing.

The mode needs the dedicated engine worker. It is not offered when the offscreen
document has fallen back to the single-thread engine (`hd_status` reports
`threaded: false`); the readout stays available there.

Implementation: hoshidicts `DictionaryStorage::Paged` (`src/blob_file.cpp`,
`src/memory/page_cache.cpp`) reads the pages;
`extension/engine-recycler.js` is the pure scheduler,
`extension/offscreen.js` owns the idle predicate (no pending request, and no
engine-side state a later request still needs, such as a prepared backup, an
exported archive URL or an open dictionary download) and the restart,
`extension/engine-worker-runtime.js` reads the worker's name to size the
pthread pool before the module starts and asks `engine-service.js` to apply the
entry storage policy (`hd_status.dictionaryEntryStorage`,
`hd_status.pagedDictionaries`), and the service worker answers
`hd_engine_config` for the offscreen document (`background-requests.js`) and
pushes the option when it changes (`background.js`).

## Disabled dictionaries

A disabled dictionary is not loaded for lookups, but the engine still opens it
once before a state that contains it is committed, at startup and whenever a
new generation of it appears, so a broken package is reported rather than
discovered when you enable it. That check loads the package with its entries
read from disk whatever the entry setting, and drops it again. When the hash
policy pages files, validation also reads only the hash header through the
shared cache. Its `blobs.bin` is never copied into the
heap, so a large disabled dictionary no longer raises the worker's high-water
mark by the size of its entries. Enabling it later loads it the way every other
enabled dictionary is loaded.

## When dictionaries do not fit

There are two failure regimes.

**More than 4 GiB of resident files.** `memory.grow` is refused and the
engine's `mmap` fails with `ENOMEM` (*not enough memory to load … dictionary*).
The engine then loads that package again with its entries read from disk, as
Low memory mode would, so only its index has to fit; its Dictionaries row says
*(entries read from disk)* and its lookups cost what they cost in Low memory
mode. A package whose index does not fit either is reported in
`hd_status.failedDictionaries`. Nothing crashes: the other dictionaries keep
working, Settings names the package that failed, and the fix is to turn on Low
memory mode or to disable or remove the largest dictionaries until the rest
fits. With paged entries only the indexes and active cache count towards the
limit, so on OPFS a library can hold several times 4 GiB of dictionary files.

**Less than 4 GiB, but more than the operating system can keep resident.**
Nothing in the engine can see this. The browser swaps, which shows up as
hovers taking seconds, or the operating system kills the extension process;
the service worker then recreates the offscreen document, which reloads every
dictionary and hits the same wall. If Hachidori's memory is close to what your
machine has free, choose Read from disk, turn on Low memory mode, or remove or
disable the largest dictionaries.

## IDBFS files

The IDBFS engines keep each generated file as an IndexedDB record. Files of
1 MiB or more are written as Blobs. On restart, and once the sync that wrote a
freshly imported file has completed, the file's MEMFS node holds that Blob
instead of a JavaScript array, and every access reads only what it needs
with `FileReaderSync`: lookups through the page cache read 4 KiB pages,
media reads their range, a mapped file is read into the heap in 8 MiB steps,
and a backup adds the Blob to its archive as it is. A file is read into an
array only if something writes to it or truncates it, which generated
dictionary files never are. Unloading a package writes nothing back.

Measured with Jitendex and Pixiv Full on Chrome 152 with the threaded IDBFS
engine forced (`benchmark/idbfs-restore.mjs`, macOS arm64): after a restart
the extension measures 4 MB outside the engine heap instead of 592 MB, the
engine heap is unchanged (690 MB with resident entries), and 4,550 lookups
return identical results. Restart, lookup and backup timings varied more with
the machine's load than between the two versions.

What remains:

- **Records written by earlier versions as arrays stay arrays.** Files under
  1 MiB, and large files written before Blob storage, load as before. A large
  legacy file becomes a Blob only when it is written again, which for a
  dictionary means a reimport or update.
- **A freshly imported file stays an array until its sync completes**, so an
  import's peak still holds it in JavaScript memory, and a failed sync keeps
  the array for the retry.
- **`FileReaderSync` exists only in workers.** Every engine runs in a worker
  where the browser has workers, including the single-thread engine for
  hosts without cross-origin isolation; only a host without workers runs the
  engine in the offscreen document, with whole-file arrays.
- Each read is a synchronous Blob read on the engine's thread, which costs
  more than reading an array.

## Deferred

Which pages stay resident is decided by the cache alone; keeping common words or
the first-ranked dictionaries warm is investigated in
[#344](https://github.com/bee-san/hachidori/issues/344). Further out, the
WebAssembly [memory-control proposal](https://github.com/WebAssembly/memory-control)
(`memory.discard` in phase 1, mappable memory later) would let an engine give
pages back or map files without copying them, at which point the emulation
described above stops being the constraint.
