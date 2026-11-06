---
'@sqlane/core': patch
---

Internal: the worker side of the store (probe, candidates, claim with mutex keys). The lock and enqueue tokens are
`varchar(26)` in the schema.
