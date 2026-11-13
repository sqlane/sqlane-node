import { expect, test } from 'vitest';
import { defineConcurrencyGroup, isConcurrencyGroup } from './define_concurrency_group.js';
import { ConfigError } from './errors.js';

test('a frozen group, known to handle()', () => {
    const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 });

    expect(heavy).toStrictEqual({ name: 'heavy', maxConcurrency: 2 });
    expect(Object.isFrozen(heavy)).toBe(true);
    expect(isConcurrencyGroup(heavy)).toBe(true);
    // Not frozen: not from defineConcurrencyGroup()
    expect(isConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 })).toBe(false);
    expect(isConcurrencyGroup('heavy')).toBe(false);
});

test.each([
    ['an unknown option', { name: 'heavy', maxConcurrency: 2, weight: 1 }, 'defineConcurrencyGroup("heavy"): unknown options: weight'],
    ['a bad name', { name: 'Heavy', maxConcurrency: 2 }, 'defineConcurrencyGroup("Heavy"): "name" must match /^[a-z][a-z0-9_.-]{0,127}$/'],
    ['no name', { maxConcurrency: 2 }, 'defineConcurrencyGroup(""): "name" must match /^[a-z][a-z0-9_.-]{0,127}$/'],
    ['a maxConcurrency of 0', { name: 'heavy', maxConcurrency: 0 }, 'defineConcurrencyGroup("heavy"): "maxConcurrency" must be an integer, at least 1'],
    ['a fractional maxConcurrency', { name: 'heavy', maxConcurrency: 1.5 }, 'defineConcurrencyGroup("heavy"): "maxConcurrency" must be an integer, at least 1'],
])('throws a ConfigError for %s', (_, options, message) => {
    expect(() => defineConcurrencyGroup(/** @type {any} */ (options))).toThrow(ConfigError);
    expect(() => defineConcurrencyGroup(/** @type {any} */ (options))).toThrow(message);
});
