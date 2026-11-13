---
'@sqlane/core': major
---

Fair sharing of slots across job names, and concurrency groups. See the
[migration guide](https://github.com/sqlane/sqlane-node/blob/main/docs/migrating-to-5.md).

Breaking:

- `createSqlane({ concurrency })` and `handle()`'s `concurrency` are now `maxConcurrency`.
- `lanes` and `lane` are removed: define a group with `defineConcurrencyGroup({ name, maxConcurrency })`, and pass it
  to `handle()` as `concurrencyGroup`.
- A free slot goes to the due job name with the lowest `running / fairShareWeight` (new `handle()` option, 1–1000,
  default 1), no longer to the oldest due job across names. FIFO within a name and per mutex key is kept.
- A handler or group `maxConcurrency` above the instance's throws a `ConfigError` at `start()` and `drain()`. 4.x
  capped it silently.
- Types: `Sqlane`, `SqlaneOptions` and `HandleOptions` lose their lane parameter, and `LaneOptions` is removed.
- The errors of `drain()` begin with `drain():`.
