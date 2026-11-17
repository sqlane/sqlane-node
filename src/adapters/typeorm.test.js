import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { typeOrmAdapter } from './typeorm.js';

function method() {}

/**
 * @param {string} type
 * @returns {any} A TypeORM DataSource, as far as the adapter reads it.
 */
function fakeDataSource(type) {
    return { options: { type }, createQueryRunner: method, initialize: method, transaction: method, subscribers: [] };
}

/**
 * @param {any} dataSource
 * @returns {any} A QueryRunner in a transaction, of TypeORM 1.x.
 */
function fakeRunner(dataSource) {
    return { dataSource, isTransactionActive: true, startTransaction: method, query: method, release: method };
}

test.each([
    { type: 'mysql', dialect: 'mysql' },
    { type: 'mysql', dialect: 'mariadb' },
    { type: 'mariadb', dialect: 'mariadb' },
    { type: 'postgres', dialect: 'postgres' },
])('type $type, dialect $dialect', ({ type, dialect }) => {
    expect(typeOrmAdapter(fakeDataSource(type), /** @type {any} */ ({ dialect })))
        .toMatchObject({ dialect, allowUnsupportedDbVersion: false, allowUnsupportedDbConfiguration: false });
});

test('allowUnsupportedDbVersion: true', () => {
    const adapter = typeOrmAdapter(fakeDataSource('postgres'), { dialect: 'postgres', allowUnsupportedDbVersion: true });

    expect(adapter.allowUnsupportedDbVersion).toBe(true);
});

test('allowUnsupportedDbConfiguration: true', () => {
    const adapter = typeOrmAdapter(fakeDataSource('mysql'), { dialect: 'mysql', allowUnsupportedDbConfiguration: true });

    expect(adapter.allowUnsupportedDbConfiguration).toBe(true);
});

test.each([
    { label: 'no DataSource', dataSource: undefined, message: 'expects a TypeORM DataSource' },
    { label: 'CockroachDB', dataSource: fakeDataSource('cockroachdb'), message: 'not "cockroachdb"' },
])('$label: a ConfigError', ({ dataSource, message }) => {
    expect(() => typeOrmAdapter(dataSource, { dialect: 'postgres' })).toThrow(message);
});

test.each([
    {
        label: 'no options',
        type: 'mysql',
        options: undefined,
        message: 'typeOrmAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'the type name of TypeORM',
        type: 'postgres',
        options: { dialect: 'postgresql' },
        message: 'typeOrmAdapter: "dialect" must be "mysql", "mariadb" or "postgres", not "postgresql"',
    },
    {
        label: '"mysql" on the type "mariadb"',
        type: 'mariadb',
        options: { dialect: 'mysql' },
        message: 'typeOrmAdapter: "dialect" is "mysql", but the type of the DataSource is "mariadb": "mariadb"',
    },
    {
        label: '"postgres" on the type "mysql"',
        type: 'mysql',
        options: { dialect: 'postgres' },
        message: 'typeOrmAdapter: "dialect" is "postgres", but the type of the DataSource is "mysql": "mysql" or '
            + '"mariadb"',
    },
    {
        label: '"mariadb" on the type "postgres"',
        type: 'postgres',
        options: { dialect: 'mariadb' },
        message: 'typeOrmAdapter: "dialect" is "mariadb", but the type of the DataSource is "postgres": "postgres"',
    },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        type: 'mysql',
        options: { dialect: 'mysql', allowUnsupportedDbVersion: 'yes' },
        message: 'typeOrmAdapter: "allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        type: 'mysql',
        options: { dialect: 'mysql', allowUnsupportedDbConfiguration: 'yes' },
        message: 'typeOrmAdapter: "allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ type, options, message }) => {
    expect(() => typeOrmAdapter(fakeDataSource(type), /** @type {any} */ (options))).toThrow(new ConfigError(message));
});

test('afterCommit: the outermost commit wakes; the release of a savepoint does not', () => {
    const dataSource = fakeDataSource('postgres');
    const runner = fakeRunner(dataSource);
    const adapter = typeOrmAdapter(dataSource, { dialect: dataSource.options.type });
    let wakes = 0;

    expect(adapter.afterCommit?.(runner, () => wakes++)).toBe(true);

    const [subscriber] = dataSource.subscribers;

    // The release of a savepoint: still in the transaction
    subscriber.afterTransactionCommit({ queryRunner: runner });
    expect(wakes).toBe(0);
    runner.isTransactionActive = false;
    subscriber.afterTransactionCommit({ queryRunner: runner });
    subscriber.afterTransactionCommit({ queryRunner: runner });
    expect(wakes).toBe(1);
});

test('afterCommit: a rollback drops the wakes; one subscriber for a DataSource', () => {
    const dataSource = fakeDataSource('mysql');
    const runner = fakeRunner(dataSource);
    const adapter = typeOrmAdapter(dataSource, { dialect: dataSource.options.type });
    let wakes = 0;

    adapter.afterCommit?.(runner, () => wakes++);
    adapter.afterCommit?.(runner, () => wakes++);
    runner.isTransactionActive = false;
    dataSource.subscribers[0].afterTransactionRollback({ queryRunner: runner });
    dataSource.subscribers[0].afterTransactionCommit({ queryRunner: runner });

    expect(wakes).toBe(0);
    expect(dataSource.subscribers).toHaveLength(1);
});

test('afterCommit: a DataSource, outside a transaction, wakes at once', () => {
    const dataSource = fakeDataSource('mysql');
    let wakes = 0;

    expect(typeOrmAdapter(dataSource, { dialect: 'mysql' }).afterCommit?.(dataSource, () => wakes++)).toBe(true);
    expect(wakes).toBe(1);
});
