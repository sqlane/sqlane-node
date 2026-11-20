---
'@sqlane/core': patch
---

The `attempts` column of a completed job counts its last attempt too, as it does for a failed job. A job that completed
at its first attempt kept `attempts = 0`, as if it had never run; it now has 1. `attempts` counts the finished attempts:
a completion, a retry and a failure each add one, a stall, a release and a wait on a rate limit none. `JobInfo.attempt`
does not change.

The docs now state that a handler runs in the async context of `start()` or `drain()`, never in the context of the code
that woke the worker, such as an enqueue in a request, the commit of a transaction or a hint. Tests check it for each of
these paths.
