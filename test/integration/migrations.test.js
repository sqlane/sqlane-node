import { afterAll, beforeAll, expect, test } from 'vitest';
import { createSqlane, getMigrations, MigrationLockTimeoutError } from '../../src/index.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @type {Record<'mysql' | 'postgres', (table: string) => string>} */
const INSERT_TWO_PAYLOADS_SQL = {
    mysql: table => `INSERT INTO ${table} (id, payload) VALUES (?, '{}'), (?, '{}')`,
    postgres: table => `INSERT INTO ${table} (id, payload) VALUES ($1, '{}'), ($2, '{}')`,
};

/** @type {Record<'mysql' | 'postgres', { lock: string, unlock: string }>} */
const LOCK_SQL = {
    mysql: { lock: 'SELECT GET_LOCK(?, 0)', unlock: 'SELECT RELEASE_LOCK(?)' },
    postgres: { lock: 'SELECT pg_advisory_lock(hashtext($1))', unlock: 'SELECT pg_advisory_unlock(hashtext($1))' },
};

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * A prefix of its own for each test: it starts with the prefix of the file, so close() drops its tables.
 * @returns {string}
 */
function nextPrefix() {
    prefixCount++;

    return `${database.tablePrefix}${prefixCount}_`;
}

/**
 * @param {string} tablePrefix
 * @returns {import('../../src/types.js').Sqlane<any, never>}
 */
function sqlaneOf(tablePrefix) {
    return createSqlane({ adapter: testAdapter.adapter, tablePrefix });
}

/**
 * @param {string} tablePrefix
 * @returns {Promise<string[]>}
 */
async function listTables(tablePrefix) {
    const rows = database.dialect === 'mysql'
        ? await database.query(`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = DATABASE() AND LEFT(table_name, CHAR_LENGTH(?)) = ? ORDER BY table_name
        `, [tablePrefix, tablePrefix])
        : await database.query(`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = current_schema() AND starts_with(table_name, $1) ORDER BY table_name
        `, [tablePrefix]);

    return rows.map(row => String(row.name));
}

test('applies the migrations once', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await expect(sqlane.migrate()).resolves.toStrictEqual({ applied: ['0001_initial'] });
    await expect(listTables(tablePrefix)).resolves.toStrictEqual(
        ['jobs', 'migrations', 'mutexes', 'payloads'].map(table => `${tablePrefix}${table}`),
    );
    await expect(sqlane.migrate()).resolves.toStrictEqual({ applied: [] });
});

test('concurrent migrations apply each version once', async () => {
    const tablePrefix = nextPrefix();
    const results = await Promise.all([sqlaneOf(tablePrefix).migrate(), sqlaneOf(tablePrefix).migrate()]);

    expect(results.flatMap(result => result.applied)).toStrictEqual(['0001_initial']);
});

test('ids are case-sensitive', async () => {
    const tablePrefix = nextPrefix();
    await sqlaneOf(tablePrefix).migrate();
    await database.query(INSERT_TWO_PAYLOADS_SQL[database.dialect](`${tablePrefix}payloads`), ['job:ABC', 'job:abc']);

    await expect(database.query(`SELECT id FROM ${tablePrefix}payloads ORDER BY id`))
        .resolves.toStrictEqual([{ id: 'job:ABC' }, { id: 'job:abc' }]);
});

test('waits for the migration lock up to lockTimeout', async () => {
    const tablePrefix = nextPrefix();
    const lockName = `${tablePrefix}migrations`;
    const { lock, unlock } = LOCK_SQL[database.dialect];

    await database.query(lock, [lockName]);

    try {
        await expect(sqlaneOf(tablePrefix).migrate({ lockTimeout: '1s' }))
            .rejects.toThrow(MigrationLockTimeoutError);
    } finally {
        await database.query(unlock, [lockName]);
    }

    await expect(sqlaneOf(tablePrefix).migrate({ lockTimeout: '1s' })).resolves.toStrictEqual({ applied: ['0001_initial'] });
});

test('getMigrations gives the statements that migrate() applies', async () => {
    const tablePrefix = nextPrefix();
    const [migration] = getMigrations({ dialect: database.dialect, tablePrefix });

    for (const sql of migration.statements) {
        // oxlint-disable-next-line no-await-in-loop -- DDL in order
        await database.query(sql);
    }

    await expect(listTables(tablePrefix)).resolves.toStrictEqual(
        ['jobs', 'mutexes', 'payloads'].map(table => `${tablePrefix}${table}`),
    );
});
