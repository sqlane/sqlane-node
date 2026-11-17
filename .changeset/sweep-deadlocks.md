---
'@sqlane/core': patch
---

The stall recovery no longer reports deadlocks of its sweep of the concurrency slots as `error` events under load. On
MySQL the sweep skips the slots that claims and releases hold instead of waiting for them, and on all databases a
deadlock of the sweep runs it again at once, up to 3 times, as the dispatcher does for its claims.
