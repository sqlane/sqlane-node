---
'@sqlane/core': patch
---

Deadlocks and serialization failures wrapped by Sequelize (`original`, `parent`), TypeORM (`driverError`) and Prisma
raw queries (`meta.code`) are now recognized as transient: `drain()` retries its round, and the failure-job insert on
MySQL and MariaDB takes its retry path, as with the plain driver errors.
