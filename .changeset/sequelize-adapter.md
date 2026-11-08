---
'@sqlane/core': minor
---

The Sequelize adapter: `import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize'`, then
`sequelizeAdapter(sequelize)`. `enqueue` takes a Sequelize instance (a transaction of its own) or a Sequelize
transaction, also nested: the workers wake at once after the commit of the outermost one. Sequelize 6, with MySQL or
PostgreSQL.
