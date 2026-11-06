# @sqlane/core

## 0.0.3

### Patch Changes

- [#9](https://github.com/sqlane/sqlane-node/pull/9) [`555bb6c`](https://github.com/sqlane/sqlane-node/commit/555bb6ce6e2c7cd48c11f589fdb9385d7b84bffa) - `defineJob()` checks its options and throws a `ConfigError` for a bad name, an unknown option, or a bad
  `maxAttempts`, `maxStalls`, `backoff`, `retention`, `timeout`, `mutexKeys` or `failureJob`.

- [#12](https://github.com/sqlane/sqlane-node/pull/12) [`27473e5`](https://github.com/sqlane/sqlane-node/commit/27473e5439a926e5f544d451cb77373c47dc56d1) - `enqueue()` and `enqueueMany()` add jobs with the caller's connection, in its transaction (or a transaction of their own
  with a pool). A `jobId` adds one job while its row exists: a duplicate resolves to `{ created: false }` and changes
  nothing. `createSqlane` checks its options: unknown options, `jobs`, `unknownJobs`, `maxPayloadBytes`, `defaults`.

- [#11](https://github.com/sqlane/sqlane-node/pull/11) [`6dc3637`](https://github.com/sqlane/sqlane-node/commit/6dc3637de28a0ca725d5c0700ab67f7997a0e05c) - Add the schema for MySQL and PostgreSQL: `sqlane.migrate({ lockTimeout })` applies the missing migrations under a DB
  lock and resolves to `{ applied }`; `getMigrations({ dialect, tablePrefix })` gives the SQL for your own migration tool.
  `createSqlane` checks `tablePrefix`. New error: `MigrationLockTimeoutError`.

## 0.0.2

### Patch Changes

- [#7](https://github.com/sqlane/sqlane-node/pull/7) [`46010b7`](https://github.com/sqlane/sqlane-node/commit/46010b7d6471d2fba61774185d6de6562c0a0327) - Add the public API as typed stubs: `createSqlane`, `defineJob`, `getMigrations`, the error classes, and the
  `@sqlane/core/mysql2` and `@sqlane/core/pg` adapters. The methods throw "not implemented" until the implementation lands.

## 0.0.1

### Patch Changes

- [#2](https://github.com/sqlane/sqlane-node/pull/2) [`bd16a88`](https://github.com/sqlane/sqlane-node/commit/bd16a889b6f8c5abe0e8e928adadd32f88af1cca) - First release, published by the release workflow: it checks the release pipeline (changesets, trusted publishing with
  provenance, GitHub release). The package has no API yet; [the design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md)
  describes the planned v0.1.
