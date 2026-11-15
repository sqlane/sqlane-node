---
'@sqlane/core': major
---

Concurrency limits replace mutex keys and concurrency groups. `defineConcurrencyLimit({ name, max })` declares a limit
once; a job definition lists it in `localConcurrencyLimits` (per process, in memory) or returns it, or its keys, from
`globalConcurrencyLimits({ payload })` (per key, in the whole cluster). A key of a global limit runs at most `max` jobs
at once; a job whose key is full is blocked out of the due jobs until a job of the key ends, so a flood on one key no
longer holds back the others. All the options of a job name move to its definition: `handle()` takes none, and
`createSqlane`'s `maxConcurrency` is now `localMaxConcurrency`. The migrations `0005_concurrency_limits` and
`0006_concurrency_slots` convert the mutex keys of existing jobs to limits with max 1. See
[Migrating from 5.x to 6.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/6.md).
