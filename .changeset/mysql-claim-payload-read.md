---
'@sqlane/core': patch
---

On MySQL and MariaDB, a job enqueued while a worker was claiming could be claimed without its payload: the worker
released it for 1 s and claimed it again (an extra `claimed` event), or, with the worker's clock more than 60 s ahead of
the database's, failed it with `MissingPayloadError`. The claim now reads such payloads again in the same transaction.
On MariaDB 11.8 and later (`innodb_snapshot_isolation`), the same race could fail the claim with "Record has changed
since last read" (errno 1020); that error is now transient: `drain()` retries its round instead of rejecting.
