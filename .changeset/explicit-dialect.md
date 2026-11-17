---
'@sqlane/core': major
---

Every adapter requires `dialect`: `'mysql'`, `'mariadb'` or `'postgres'`. There is no default any more, so a MariaDB
server can no longer run the SQL of MySQL by mistake. Where the library tells its database (Knex, Drizzle, Sequelize,
TypeORM, MikroORM), a mismatch throws a `ConfigError`. The first `start()` or `migrate()` of an instance checks the
server: another database, or a version below MySQL 8.4, MariaDB 10.11 or PostgreSQL 15, rejects with a `ConfigError`.
On MySQL and MariaDB, it also reads the `sql_mode` of the session. A mode without strict mode or another flag of the
database's default mode, or with `ALLOW_INVALID_DATES` or `NO_BACKSLASH_ESCAPES`, rejects with a `ConfigError`. The
default mode of each database passes; the default parameter group of Amazon RDS MySQL does not.

To migrate, add `dialect` to your adapter call, for example `pgAdapter(pool, { dialect: 'postgres' })`,
`mysql2Adapter(pool, { dialect: 'mysql' })` or `typeOrmAdapter(dataSource, { dialect: 'mariadb' })`. The options
argument is now required on every adapter. To run on an older server, pass `allowUnsupportedDbVersion: true` to the
adapter: sqlane then logs a warning through the `logger` of `createSqlane` instead of throwing. On MySQL and MariaDB,
make `sql_mode` strict (on RDS and Aurora, in the DB parameter group), or pass `allowUnsupportedDbConfiguration: true`
for a warning instead. `NO_BACKSLASH_ESCAPES` has no option: remove it.
