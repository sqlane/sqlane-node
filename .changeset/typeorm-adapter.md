---
'@sqlane/core': minor
---

The TypeORM adapter: `import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm'`, then
`typeOrmAdapter(dataSource)`. `enqueue` takes a DataSource (a transaction of its own), or the EntityManager or
QueryRunner of a transaction, also with savepoints: the workers wake at once after the commit of the outermost one.
TypeORM 0.3 and 1.x, with MySQL (mysql2) or PostgreSQL.
