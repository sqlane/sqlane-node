---
'@sqlane/core': major
---

The schema moves to `sqlane.schema`, and each migration is tagged with the version of sqlane that ships it.
`schema.migrate({ targetVersion })` applies the migrations up to a version, so an app's own migration tool can pin one
per file. `schema.rollback({ targetVersion })` reverts the migrations tagged above a version, and `schema.drop()` drops
the tables of sqlane. `schema.getMigrationStatus()` reads the recorded migrations, and `schema.findSchemaProblems()`
compares the tables, columns and indexes with what this version needs: check both before `start()` or in a readiness
probe. 8.0 does not change the schema.

Breaking changes:

- `sqlane.migrate()` is now `sqlane.schema.migrate()`. Its error messages start with `schema.migrate():`.
- `getMigrations()` and the `Migration` type are removed. If your migration tool applied their SQL, call
  `schema.migrate({ targetVersion })` from a migration file instead. A schema built from `getMigrations()` makes
  `schema.migrate()` fail: drop its tables and migrate again, or record the ids in `sqlane_migrations` by hand. See
  [Migrating from 7.x to 8.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/8.md).
