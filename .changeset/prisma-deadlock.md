---
'@sqlane/core': patch
---

Retry the deadlocks and write conflicts that Prisma reports (`P2034`, or `P2010` with the database code in its driver
adapter error), as those of the drivers: `drain()` failed on one with the Prisma adapter.
