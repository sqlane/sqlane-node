import { expect, test } from 'vitest';
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
    { label: 'no dialect', em: fakeEntityManager(), options: undefined, message: '"dialect" must be' },
    { label: 'SQLite', em: fakeEntityManager(), options: { dialect: 'sqlite' }, message: '"dialect" must be' },
])('$label: a ConfigError', ({ em, options, message }) => {
    expect(() => mikroOrmAdapter(em, /** @type {any} */ (options))).toThrow(message);
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
