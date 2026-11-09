---
'@sqlane/core': minor
---

The MikroORM adapter: `import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm'`, then
`mikroOrmAdapter(orm.em, { dialect })`. `enqueue` takes an EntityManager: of a transaction (also the global one inside
`em.transactional()`), or outside one (a transaction of its own). The workers wake at once after the commit of the
outermost transaction. MikroORM 6 and 7, with `@mikro-orm/mysql` or `@mikro-orm/postgresql`.
