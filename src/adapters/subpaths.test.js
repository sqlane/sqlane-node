import { expect, test } from 'vitest';
import * as drizzle from '@sqlane/core/adapter-drizzle';
import * as knex from '@sqlane/core/adapter-knex';
import * as kysely from '@sqlane/core/adapter-kysely';
import * as mikroOrm from '@sqlane/core/adapter-mikro-orm';
import * as mysql2 from '@sqlane/core/adapter-mysql2';
import * as pg from '@sqlane/core/adapter-pg';
import * as postgresJs from '@sqlane/core/adapter-postgres-js';
import * as prisma from '@sqlane/core/adapter-prisma';
import * as sequelize from '@sqlane/core/adapter-sequelize';
import * as typeorm from '@sqlane/core/adapter-typeorm';

test('each adapter has its subpath', () => {
    const adapters = [
        mysql2.mysql2Adapter,
        pg.pgAdapter,
        postgresJs.postgresJsAdapter,
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
