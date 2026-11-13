---
'@sqlane/core': patch
---

Claims on MariaDB 11.8 (and any MariaDB with `innodb_snapshot_isolation=ON`) no longer fail with `ER_CHECKREAD`
(errno 1020) while jobs are enqueued concurrently: the claim statement turns snapshot isolation off for itself, and
reads again the payloads that it did not see, as on MariaDB 10.11 and MySQL. A deadlock, serialization failure or
`ER_CHECKREAD` (1020) of a claim is now retried at once, up to 3 times, without an `error` event; only an error that
persists is reported and backed off. A lock wait timeout is still reported and backed off at once.
