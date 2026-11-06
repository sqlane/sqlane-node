---
'@sqlane/core': patch
---

Jobs run: `handle()`, `start()`, `drain()`, `close()` and `wake()` work. Handlers get `{ payload, job, signal }`; jobs
retry by their backoff, fail into their failure job, respect the lanes, the process `concurrency` and the mutex keys,
and time out with an aborted `signal`. `close()` releases or abandons the unfinished jobs; `drain()` runs the due jobs
for tests. `getStats()` is not implemented yet.
