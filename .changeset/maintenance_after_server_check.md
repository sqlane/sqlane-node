---
'@sqlane/core': patch
---

When the database is down at `start()`, the stall recovery and the cleanup of finished jobs now wait for the server
check, as the claims do. Before, they ran on their timers before the check, and kept running when the server turned out
to be the wrong database, an unsupported version or a `sql_mode` that sqlane rejects: they could lock and delete rows on
that server. Now such a server gets no recovery and no cleanup.
