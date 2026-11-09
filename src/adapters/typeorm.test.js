import { expect, test } from 'vitest';
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

test.each([{ type: 'mysql' }, { type: 'mariadb' }, { type: 'postgres' }])('type $type', ({ type }) => {
    expect(typeOrmAdapter(fakeDataSource(type)).dialect).toBe(type);
});

test.each([
    { label: 'no DataSource', dataSource: undefined, message: 'expects a TypeORM DataSource' },
    { label: 'CockroachDB', dataSource: fakeDataSource('cockroachdb'), message: 'not "cockroachdb"' },
])('$label: a ConfigError', ({ dataSource, message }) => {
    expect(() => typeOrmAdapter(dataSource)).toThrow(message);
});

test('afterCommit: the outermost commit wakes; the release of a savepoint does not', () => {
    const dataSource = fakeDataSource('postgres');
    const runner = fakeRunner(dataSource);
    const adapter = typeOrmAdapter(dataSource);
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
    const adapter = typeOrmAdapter(dataSource);
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

    expect(typeOrmAdapter(dataSource).afterCommit?.(dataSource, () => wakes++)).toBe(true);
    expect(wakes).toBe(1);
});
