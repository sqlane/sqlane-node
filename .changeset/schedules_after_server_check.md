---
'@sqlane/core': patch
---

When the database is down at `start()`, the schedules now wait for the server check, as the claims, the stall recovery
and the cleanup do. Before, the scheduler registered and fired them as soon as the database came back, even when the
server turned out to be the wrong database, an unsupported version or a `sql_mode` that sqlane rejects: it wrote the
schedules table and enqueued slot jobs on that server. Now such a server gets no schedule writes. A start with the
database up is unchanged.
