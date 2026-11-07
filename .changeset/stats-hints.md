---
'@sqlane/core': patch
---

`getStats()` gives the pending, due, running, stuck and failed counts and the oldest due age of each job name. Hints wake
the other processes: a `hint: { publish, subscribe }` over any pub/sub, or `pgAdapter(pool, { notify: true })` for
PostgreSQL LISTEN/NOTIFY (delivered on commit). The README shows the usage.
