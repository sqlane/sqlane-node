---
'@sqlane/core': patch
---

`drain()` retries a round after a deadlock or a lock wait timeout instead of rejecting, and `drain({ includeDelayed })`
updates the due times in a `READ COMMITTED` transaction (no gap locks on MySQL).
