---
'@sqlane/core': patch
---

Add the schema for MySQL and PostgreSQL: `sqlane.migrate({ lockTimeout })` applies the missing migrations under a DB
lock and resolves to `{ applied }`; `getMigrations({ dialect, tablePrefix })` gives the SQL for your own migration tool.
`createSqlane` checks `tablePrefix`. New error: `MigrationLockTimeoutError`.
