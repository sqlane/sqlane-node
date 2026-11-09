---
'@sqlane/core': minor
---

Faster claims of job names without mutex keys: the due jobs are found, claimed and read at once. On PostgreSQL, one
statement replaces four statements and a transaction; on MySQL, one locking read replaces two queries. Throughput with
an empty handler: +30–90% on PostgreSQL, +10–25% on MySQL (docs/benchmarks.md).

The keys in the rows of a name whose definition (in the claiming process) has no mutex keys are no longer taken: the
definition decides. This matters only while a deploy removes the mutex keys of a definition.
