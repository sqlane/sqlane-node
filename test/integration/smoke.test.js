import { afterAll, beforeAll, expect, test } from 'vitest';
import { connectTestDatabase } from './helpers/test_database.js';

/** @type {Record<'mysql' | 'postgres', string>} */
const VERSION_SQL = {
    mysql: 'SELECT VERSION() AS version',
    postgres: 'SELECT current_setting(\'server_version\') AS version',
};

/** @type {Record<'mysql' | 'postgres', (table: string) => string[]>} */
const ROUND_TRIP_SQL = {
    mysql: table => [
        `CREATE TABLE ${table} (id INT PRIMARY KEY, label VARCHAR(16) NOT NULL)`,
        `INSERT INTO ${table} (id, label) VALUES (?, ?)`,
        `SELECT id, label FROM ${table}`,
    ],
    postgres: table => [
        `CREATE TABLE ${table} (id INT PRIMARY KEY, label VARCHAR(16) NOT NULL)`,
        `INSERT INTO ${table} (id, label) VALUES ($1, $2)`,
        `SELECT id, label FROM ${table}`,
    ],
};

/** @type {import('./helpers/test_database.js').TestDatabaseConnection} */
let database;

beforeAll(async () => {
    database = await connectTestDatabase();
});

afterAll(async () => {
    await database.close();
});

test('the server has the version of the project', async () => {
    const [{ version }] = await database.query(VERSION_SQL[database.dialect]);
    const expectedVersion = database.name.split('-')[1];

    expect(String(version).startsWith(`${expectedVersion}.`)).toBe(true);
});

test('a table of the prefix stores and returns a row', async () => {
    const [createSql, insertSql, selectSql] = ROUND_TRIP_SQL[database.dialect](`${database.tablePrefix}smoke`);

    await database.query(createSql);
    await database.query(insertSql, [1, 'one']);

    await expect(database.query(selectSql)).resolves.toStrictEqual([{ id: 1, label: 'one' }]);
});
