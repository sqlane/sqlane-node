---
'@sqlane/core': patch
---

TypeScript: the editor shows docs for every method of a sqlane instance, and for each of its parameters. `handle`,
`close` and `getStats` had none, and no parameter had any: hovering `sqlane.handle` now explains it, and the signature
help explains `job` and `handler`. The fields of the public types that had no description have one, such as those of
`JobStats`, `JobDefaults` and `SqlaneOptions`.
