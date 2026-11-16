---
'@sqlane/core': minor
---

Rate limits. `defineRateLimit({ name, max, per, burst })` declares a limit of job starts: `max` per `per`, spread
evenly, with bursts of up to `burst`. A job definition lists it in `localRateLimits` (per process, in memory) or returns
it, its keys or a cost of it from `globalRateLimits({ payload })` (per key, in the whole cluster, with GCRA in one row
per key). A job over the quota of a key is blocked out of the due jobs, without using an attempt, until the key allows
its start, so a flood on one key does not hold back the others. A handler that gets a 429 throws
`new RateLimitedError({ limit, retryAfter })`: the key starts no job before `retryAfter`, and the job waits without
using an attempt; each wait emits a `rate_limited` event. The migration `0007_rate_limits` adds the table
`sqlane_rate_limits` and a column of `sqlane_jobs`.
