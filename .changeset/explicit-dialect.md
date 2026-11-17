---
'@sqlane/core': major
---

Every adapter requires `dialect`: `'mysql'`, `'mariadb'` or `'postgres'`. There is no default any more, so a MariaDB
server can no longer run the SQL of MySQL by mistake. Where the library tells its database (Knex, Drizzle, Sequelize,
TypeORM, MikroORM), a mismatch throws a `ConfigError`. The first `start()` or `migrate()` of an instance checks the
server, in one statement: another database, or a version below MySQL 8.4, MariaDB 10.11 or PostgreSQL 15, rejects with
a `ConfigError`.

To migrate, add `dialect` to your adapter call, for example `pgAdapter(pool, { dialect: 'postgres' })`,
`mysql2Adapter(pool, { dialect: 'mysql' })` or `typeOrmAdapter(dataSource, { dialect: 'mariadb' })`. The options
argument is now required on every adapter. To run on an older server, pass `allowUnsupportedVersion: true` to the
adapter: sqlane then logs a warning through the `logger` of `createSqlane` instead of throwing.
