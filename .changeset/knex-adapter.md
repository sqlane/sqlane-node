---
'@sqlane/knex': minor
---

New package: the knex adapter. `enqueue` takes a knex instance (a transaction of its own) or a knex transaction, also
a nested one. The workers wake at once after the commit of the outermost transaction. knex 3, with `mysql2` or `pg`.
