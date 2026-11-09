---
'@sqlane/core': minor
---

Support MariaDB 10.11 and later. MariaDB speaks the MySQL protocol, so tell the adapter: `mysql2Adapter(pool, { dialect: 'mariadb' })`, the same `dialect` option on the Knex, Drizzle and Sequelize adapters, `dialect: 'mariadb'` on the Kysely, Prisma and MikroORM adapters, and `type: 'mariadb'` in a TypeORM DataSource. `getMigrations({ dialect: 'mariadb' })` gives its schema. MySQL is unchanged.
