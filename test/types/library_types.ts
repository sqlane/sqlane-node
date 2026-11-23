// Type tests of each adapter with the real objects of its library, as a TypeScript app passes them: checked by tsc
// (pnpm typecheck), never run. public_api_types.js casts `{}` to each adapter's parameter type, so it can't see a
// parameter type that the library's own types don't satisfy. Prisma: its client is generated, so it isn't here.
import { MikroORM } from '@mikro-orm/postgresql';
import { drizzle as drizzle1 } from 'drizzle-orm-1/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import knex from 'knex';
import { Kysely, PostgresDialect } from 'kysely';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import postgres from 'postgres';
import { Sequelize } from 'sequelize';
import { DataSource } from 'typeorm';
import { createSqlane, defineLane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';
import { knexAdapter } from '@sqlane/core/adapter-knex';
import { kyselyAdapter } from '@sqlane/core/adapter-kysely';
import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';
import { pgAdapter } from '@sqlane/core/adapter-pg';
import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js';
import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize';
import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm';

const job = defineLane<{ orderId: number }>({ name: 'send_receipt' });

/** The type tests: never called. */
export async function libraryTypes() {
    const pgPool = new Pool();
    const pg = createSqlane({ adapter: pgAdapter(pgPool, { dialect: 'postgres' }), lanes: [job] });
    const client = await pgPool.connect();

    await pg.enqueue(client, job, { orderId: 1 });
    await pg.enqueue(pgPool, job, { orderId: 1 });

    const mysqlPool = mysql.createPool({});
    const my = createSqlane({ adapter: mysql2Adapter(mysqlPool, { dialect: 'mysql' }), lanes: [job] });
    const connection = await mysqlPool.getConnection();

    await my.enqueue(connection, job, { orderId: 1 });

    const sql = postgres();
    const pj = createSqlane({ adapter: postgresJsAdapter(sql, { dialect: 'postgres' }), lanes: [job] });

    await sql.begin(async (tx) => {
        await pj.enqueue(tx, job, { orderId: 1 });
    });
    await pj.enqueue(sql, job, { orderId: 1 });

    const db = drizzle({ client: pgPool });
    const dz = createSqlane({ adapter: drizzleAdapter(db, { dialect: 'postgres', notify: true }), lanes: [job] });

    await db.transaction(async (tx) => {
        await dz.enqueue(tx, job, { orderId: 1 });
    });
    await dz.enqueue(db, job, { orderId: 1 });
    drizzleAdapter(drizzle1({ client: pgPool }), { dialect: 'postgres' });
    drizzleAdapter(drizzlePostgresJs(sql), { dialect: 'postgres' });
    drizzleAdapter(drizzleMysql({ client: mysqlPool }), { dialect: 'mysql' });

    const kx = knex({ client: 'pg' });
    const kn = createSqlane({ adapter: knexAdapter(kx, { dialect: 'postgres' }), lanes: [job] });

    await kx.transaction(async (trx) => {
        await kn.enqueue(trx, job, { orderId: 1 });
    });

    const ky = new Kysely<object>({ dialect: new PostgresDialect({ pool: pgPool }) });
    const ks = createSqlane({ adapter: kyselyAdapter(ky, { dialect: 'postgres' }), lanes: [job] });

    await ky.transaction().execute(async (trx) => {
        await ks.enqueue(trx, job, { orderId: 1 });
    });

    const sequelize = new Sequelize('postgres://localhost/app');
    const sq = createSqlane({ adapter: sequelizeAdapter(sequelize, { dialect: 'postgres' }), lanes: [job] });

    await sequelize.transaction(async (t) => {
        await sq.enqueue(t, job, { orderId: 1 });
    });
    await sq.enqueue(sequelize, job, { orderId: 1 });

    const dataSource = new DataSource({ type: 'postgres' });
    const to = createSqlane({ adapter: typeOrmAdapter(dataSource, { dialect: 'postgres' }), lanes: [job] });

    await dataSource.transaction(async (manager) => {
        await to.enqueue(manager, job, { orderId: 1 });
    });

    const orm = await MikroORM.init({ dbName: 'app' });
    const mo = createSqlane({ adapter: mikroOrmAdapter(orm.em, { dialect: 'postgres' }), lanes: [job] });

    await orm.em.transactional(async (em) => {
        await mo.enqueue(em, job, { orderId: 1 });
    });
}
