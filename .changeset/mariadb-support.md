---
'@sqlane/core': minor
---

Support MariaDB 10.11 and later. Over mysql2, tell the adapter: `mysql2Adapter(pool, { dialect: 'mariadb' })`, the same `dialect` option on the Knex, Drizzle and Sequelize adapters, `dialect: 'mariadb'` on the Kysely, Prisma and MikroORM adapters, and `type: 'mariadb'` in a TypeORM DataSource. The mariadb driver works too: the `mariadb` client of Knex, the `mariadb` dialect of Sequelize and `@mikro-orm/mariadb` (MikroORM 6 and 7). `getMigrations({ dialect: 'mariadb' })` gives its schema. MySQL is unchanged.
