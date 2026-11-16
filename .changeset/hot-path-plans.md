---
'@sqlane/core': patch
---

PostgreSQL keeps one plan per connection for the statements of the claim, the unblock and the rate keys: their array
parameters no longer make it plan each call again. With `pg` and `postgres.js` (whose adapter now sends named prepared
statements, unless the pool was created with `prepare: false`), a job with global limits costs the database about 40%
fewer instructions. An idle worker of many job names polls with fewer instructions.
