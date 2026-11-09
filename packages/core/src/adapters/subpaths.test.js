import { expect, test } from 'vitest';
import * as drizzle from '@sqlane/core/adapter-drizzle';
import * as knex from '@sqlane/core/adapter-knex';
import * as kysely from '@sqlane/core/adapter-kysely';
import * as mikroOrm from '@sqlane/core/adapter-mikro-orm';
import * as mysql2 from '@sqlane/core/adapter-mysql2';
import * as pg from '@sqlane/core/adapter-pg';
import * as prisma from '@sqlane/core/adapter-prisma';
import * as sequelize from '@sqlane/core/adapter-sequelize';
import * as typeorm from '@sqlane/core/adapter-typeorm';
// oxlint-disable-next-line import/no-duplicates -- the alias of adapter-knex, imported on purpose
import * as legacyKnex from '@sqlane/core/knex';
import * as legacyMysql2 from '@sqlane/core/mysql2';
import * as legacyPg from '@sqlane/core/pg';

test('each adapter has its subpath', () => {
    const adapters = [
        mysql2.mysql2Adapter,
        pg.pgAdapter,
        knex.knexAdapter,
        kysely.kyselyAdapter,
        drizzle.drizzleAdapter,
        prisma.prismaAdapter,
        sequelize.sequelizeAdapter,
        typeorm.typeOrmAdapter,
        mikroOrm.mikroOrmAdapter,
    ];

    expect(adapters).toStrictEqual(adapters.map(() => expect.any(Function)));
});

test('the paths before 0.4 are the same modules, until 1.0', () => {
    expect([legacyMysql2, legacyPg, legacyKnex]).toStrictEqual([mysql2, pg, knex]);
});
