import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { mikroOrmAdapter } from './mikro_orm.js';

function method() {}

/**
 * An EntityManager of MikroORM 7, as far as the adapter reads it.
 * @param {any} [transaction] Its transaction context.
 * @returns {any}
 */
function fakeEntityManager(transaction) {
    /** @type {object[]} */
    const subscribers = [];
    const em = {
        subscribers,
        getTransactionContext: () => transaction,
        getConnection: () => ({ getClient: method, ensureConnection: method }),
        getContext: () => em,
        getEventManager: () => ({
            registerSubscriber: (/** @type {object} */ subscriber) => subscribers.push(subscriber),
        }),
    };

    return em;
}

test.each([
    { label: 'no EntityManager', em: undefined, options: { dialect: 'mysql' }, message: 'expects an EntityManager' },
    {
        label: 'a driver without SQL',
        em: { ...fakeEntityManager(), getConnection: () => ({}) },
        options: { dialect: 'mysql' },
        message: 'with a SQL driver',
    },
    {
        label: 'no options',
        em: fakeEntityManager(),
        options: undefined,
        message: 'mikroOrmAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'no dialect',
        em: fakeEntityManager(),
        options: { prepare: false },
        message: 'mikroOrmAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'SQLite',
        em: fakeEntityManager(),
        options: { dialect: 'sqlite' },
        message: 'mikroOrmAdapter: "dialect" must be "mysql", "mariadb" or "postgres", not "sqlite"',
    },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        em: fakeEntityManager(),
        options: { dialect: 'mysql', allowUnsupportedDbVersion: 'yes' },
        message: 'mikroOrmAdapter: "allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        em: fakeEntityManager(),
        options: { dialect: 'mysql', allowUnsupportedDbConfiguration: 'yes' },
        message: 'mikroOrmAdapter: "allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ em, options, message }) => {
    expect(() => mikroOrmAdapter(em, /** @type {any} */ (options))).toThrow(message);
});

test.each([
    { options: { dialect: /** @type {const} */ ('mysql') }, expected: false },
    { options: { dialect: /** @type {const} */ ('mysql'), allowUnsupportedDbVersion: true }, expected: true },
])('allowUnsupportedDbVersion: $expected', ({ options, expected }) => {
    expect(mikroOrmAdapter(fakeEntityManager(), options)).toMatchObject({ dialect: 'mysql', allowUnsupportedDbVersion: expected });
});

test.each([
    { options: { dialect: /** @type {const} */ ('mysql') }, expected: false },
    { options: { dialect: /** @type {const} */ ('mysql'), allowUnsupportedDbConfiguration: true }, expected: true },
])('allowUnsupportedDbConfiguration: $expected', ({ options, expected }) => {
    expect(mikroOrmAdapter(fakeEntityManager(), options).allowUnsupportedDbConfiguration).toBe(expected);
});

/**
 * An EntityManager of MikroORM 6, over a knex instance of a client.
 * @param {string} dialect The dialect of the knex client.
 * @param {string} driverName
 * @returns {any}
 */
function fakeEntityManager6(dialect, driverName) {
    const client = { dialect, driverName, acquireConnection: async () => ({}), releaseConnection: async () => {} };
    const knex = { transaction: method, client };

    return {
        ...fakeEntityManager(),
        getConnection: () => ({ getKnex: () => knex, ensureConnection: method }),
    };
}

test.each([
    {
        label: '"postgres" on mysql2',
        em: fakeEntityManager6('mysql', 'mysql2'),
        dialect: 'postgres',
        message: 'mikroOrmAdapter: "dialect" is "postgres", but the driver of MikroORM is "mysql2": "mysql" or "mariadb"',
    },
    {
        label: '"mysql" on the mariadb driver',
        em: fakeEntityManager6('mysql', 'mariadb'),
        dialect: 'mysql',
        message: 'mikroOrmAdapter: "dialect" is "mysql", but the driver of MikroORM is "mariadb": "mariadb"',
    },
    {
        label: '"mariadb" on pg',
        em: fakeEntityManager6('postgresql', 'pg'),
        dialect: 'mariadb',
        message: 'mikroOrmAdapter: "dialect" is "mariadb", but the driver of MikroORM is "pg": "postgres"',
    },
])('MikroORM 6, $label: a ConfigError at the first use', async ({ em, dialect, message }) => {
    const adapter = mikroOrmAdapter(em, /** @type {any} */ ({ dialect }));

    await expect(adapter.queue.query('SELECT 1', [])).rejects.toThrow(new ConfigError(message));
});

test.each([
    { em: fakeEntityManager6('mysql', 'mysql2'), dialect: 'mariadb' },
    { em: fakeEntityManager6('mysql', 'mariadb'), dialect: 'mariadb' },
    { em: fakeEntityManager6('postgresql', 'pg'), dialect: 'postgres' },
])('MikroORM 6, $dialect on its driver: accepted', async ({ em, dialect }) => {
    const adapter = mikroOrmAdapter(em, /** @type {any} */ ({ dialect }));

    await expect(adapter.withConnection(async () => 'ran')).resolves.toBe('ran');
});

test('afterCommit, MikroORM 7: the commit of the transaction wakes; not the release of a savepoint', () => {
    const transaction = {};
    const em = fakeEntityManager(transaction);
    const adapter = mikroOrmAdapter(fakeEntityManager(), { dialect: 'postgres' });
    let wakes = 0;

    expect(adapter.afterCommit?.(em, () => wakes++)).toBe(true);
    expect(adapter.afterCommit?.(em, () => wakes++)).toBe(true);

    const [subscriber] = em.subscribers;

    subscriber.afterTransactionCommit({ transaction: { savepointName: 'trx1' } });
    expect(wakes).toBe(0);
    subscriber.afterTransactionCommit({ transaction });
    subscriber.afterTransactionCommit({ transaction });
    expect(wakes).toBe(2);
});

test('afterCommit, MikroORM 7: a rollback drops the wakes', () => {
    const transaction = {};
    const em = fakeEntityManager(transaction);
    const adapter = mikroOrmAdapter(fakeEntityManager(), { dialect: 'mysql' });
    let wakes = 0;

    adapter.afterCommit?.(em, () => wakes++);
    em.subscribers[0].afterTransactionRollback({ transaction });
    em.subscribers[0].afterTransactionCommit({ transaction });

    expect(wakes).toBe(0);
});

test('afterCommit, MikroORM 7: in a savepoint, no hook (sqlane re-probes); outside a transaction, at once', () => {
    const adapter = mikroOrmAdapter(fakeEntityManager(), { dialect: 'mysql' });
    let wakes = 0;

    expect(adapter.afterCommit?.(fakeEntityManager({ savepointName: 'trx1' }), () => wakes++)).toBe(false);
    expect(adapter.afterCommit?.(fakeEntityManager(), () => wakes++)).toBe(true);
    expect(wakes).toBe(1);
});

test.each(['mysql', 'mariadb'])('{ prepare: true } on %s: a ConfigError', (dialect) => {
    expect(() => mikroOrmAdapter(fakeEntityManager(), /** @type {any} */ ({ dialect, prepare: true })))
        .toThrow('"prepare" is for PostgreSQL');
});

test('{ prepare: true } on MikroORM 7.0 or 7.1 (no getNativeClient): a ConfigError', () => {
    expect(() => mikroOrmAdapter(fakeEntityManager(), { dialect: 'postgres', prepare: true }))
        .toThrow('"prepare" needs MikroORM 6, or 7.2 and later');
});

test('{ prepare: true } on MikroORM 7.2: accepted', () => {
    const em = { ...fakeEntityManager(), getConnection: () => ({ getClient: method, getNativeClient: method }) };

    expect(mikroOrmAdapter(em, { dialect: 'postgres', prepare: true }).dialect).toBe('postgres');
});
