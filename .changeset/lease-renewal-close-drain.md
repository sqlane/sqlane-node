---
'@sqlane/core': patch
---

The leases of running jobs are now also renewed while `close()` waits for the handlers and during `drain()`. Before, a
handler that ran longer than a lease (4 minutes) during a long `close()` deadline or a `drain()` could lose its job to
another process without being aborted.
