# @sqlane/core

## 0.1.1

### Patch Changes

- [#24](https://github.com/sqlane/sqlane-node/pull/24) [`cc72758`](https://github.com/sqlane/sqlane-node/commit/cc7275887261b61ff817d70ecda94f56c2748704) - TypeScript declarations: the package ships `types/*.d.ts`, generated from its JSDoc, with a `types` condition for `.`,
  `./mysql2` and `./pg`. A strict TypeScript project no longer needs `allowJs`. The `pg` adapter types come from
  `@types/pg`.

## 0.1.0

The first usable version: jobs are enqueued in the caller's transaction and run by the workers, on MySQL 8.4+ and
PostgreSQL 15+. It includes the versions 0.0.3 and 0.0.4, which were not published.

### Minor Changes

- [#19](https://github.com/sqlane/sqlane-node/pull/19) [`5a71cf7`](https://github.com/sqlane/sqlane-node/commit/5a71cf7bd81bb0db0ed171a4f2e83f60f3962a8b) - `getStats()` gives the pending, due, running, stuck and failed counts and the oldest due age of each job name. Hints wake
  the other processes: a `hint: { publish, subscribe }` over any pub/sub, or `pgAdapter(pool, { notify: true })` for
  PostgreSQL LISTEN/NOTIFY (delivered on commit). The README shows the usage.

### Patch Changes

- [#22](https://github.com/sqlane/sqlane-node/pull/22) - `drain()` retries a round after a deadlock or a lock wait timeout instead of rejecting, and
  `drain({ includeDelayed })` updates the due times in a `READ COMMITTED` transaction (no gap locks on MySQL).

- [#15](https://github.com/sqlane/sqlane-node/pull/15) [`37221b6`](https://github.com/sqlane/sqlane-node/commit/37221b61d2bb6d6e47a515fe75d1f17aac8111be) - Internal: the worker side of the store (probe, candidates, claim with mutex keys). The lock and enqueue tokens are
  `varchar(26)` in the schema.

- [#17](https://github.com/sqlane/sqlane-node/pull/17) [`2946241`](https://github.com/sqlane/sqlane-node/commit/2946241dbac858276663a4c9c309f79d799e2e38) - Internal: the final writes of the store (lease renewal, complete, retry, fail with the failure job, release, stall
  recovery, mutex sweeps, cleanup).

- [#18](https://github.com/sqlane/sqlane-node/pull/18) [`f290097`](https://github.com/sqlane/sqlane-node/commit/f29009721aa7da35bae23220ad0094a404ba5e7e) - Jobs run: `handle()`, `start()`, `drain()`, `close()` and `wake()` work. Handlers get `{ payload, job, signal }`; jobs
  retry by their backoff, fail into their failure job, respect the lanes, the process `concurrency` and the mutex keys,
  and time out with an aborted `signal`. `close()` releases or abandons the unfinished jobs; `drain()` runs the due jobs
  for tests.

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
