---
'@sqlane/core': minor
---

PostgreSQL: the Knex, Sequelize and MikroORM adapters take `{ prepare: true }`, to run sqlane's SQL as named prepared
statements, as the pg adapter does by default: each connection parses and plans a statement once. It is off by default,
for poolers in transaction mode without prepared statement support. In MikroORM 7 (7.2 and later), it covers the
queue's own SQL; an enqueue still runs through Kysely, unnamed. On MySQL and MariaDB, `prepare` throws a `ConfigError`.
