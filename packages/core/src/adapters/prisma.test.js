import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { prismaAdapter } from './prisma.js';

function method() {}

/**
 * @param {object} [extra]
 * @returns {any} A Prisma client, as far as the adapter reads it.
 */
function fakePrisma(extra = {}) {
    return { $queryRawUnsafe: method, $executeRawUnsafe: method, $transaction: method, ...extra };
}

test.each([{ dialect: 'mysql' }, { dialect: 'postgres' }])('dialect $dialect', ({ dialect }) => {
    expect(prismaAdapter(fakePrisma(), /** @type {any} */ ({ dialect }))).toMatchObject({
        dialect,
        transactionalConnection: true,
    });
});

test.each([
    { label: 'no options', options: undefined },
    { label: 'the provider name of Prisma', options: { dialect: 'postgresql' } },
])('$label: a ConfigError', ({ options }) => {
    expect(() => prismaAdapter(fakePrisma(), /** @type {any} */ (options)))
        .toThrow('"dialect" must be "mysql" or "postgres"');
});

test.each([
    { label: 'no client', prisma: undefined },
    { label: 'a pg pool', prisma: { query: method, connect: method } },
])('$label: a ConfigError', ({ prisma }) => {
    expect(() => prismaAdapter(/** @type {any} */ (prisma), { dialect: 'mysql' })).toThrow(ConfigError);
});

test.each([
    { label: 'a client: at once', client: fakePrisma(), hooked: true, calls: 1 },
    {
        label: 'the client of a transaction: no hook',
        client: fakePrisma({ [Symbol.for('prisma.client.transaction.scope_context')]: {} }),
        hooked: false,
        calls: 0,
    },
])('afterCommit, $label', ({ client, hooked, calls }) => {
    const adapter = prismaAdapter(fakePrisma(), { dialect: 'postgres' });
    let called = 0;

    expect(adapter.afterCommit?.(client, () => called++)).toBe(hooked);
    expect(called).toBe(calls);
});
