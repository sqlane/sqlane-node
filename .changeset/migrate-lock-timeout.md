---
'@sqlane/core': patch
---

PostgreSQL: `migrate({ lockTimeout })` sets the timeout of its lock with one SQL text and a parameter
(`set_config('lock_timeout', $1, true)`), no longer with the value in the SQL. Each distinct timeout made a new named
prepared statement on the connection.
