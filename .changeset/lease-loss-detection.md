---
'@sqlane/core': patch
---

A handler is now aborted with a `LeaseLostError` (and `lease_lost` is emitted) before its lease ends when the lease renewal fails or hangs, for example when the database is unreachable or the pool has no free connection. Before, a renewal that threw or never returned skipped this check, so the handler kept running after another process could take its job.
