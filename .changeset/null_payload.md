---
'@sqlane/core': patch
---

On PostgreSQL, a job with a JSON `null` payload is enqueued: the enqueue, and the job of a schedule, failed with a
NOT NULL violation of the payload. A `null` payload is stored as JSON `null`, as on MySQL and MariaDB, and the handler
gets `null`.
