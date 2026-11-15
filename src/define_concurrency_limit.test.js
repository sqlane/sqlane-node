import { expect, test } from 'vitest';
import { defineConcurrencyLimit, isConcurrencyLimit } from './define_concurrency_limit.js';
import { ConfigError } from './errors.js';

test('a frozen limit, known to defineJob()', () => {
    const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });

    expect(heavy).toMatchObject({ name: 'heavy', max: 2 });
    expect(Object.isFrozen(heavy)).toBe(true);
    expect(isConcurrencyLimit(heavy)).toBe(true);
    // Not frozen: not from defineConcurrencyLimit()
    expect(isConcurrencyLimit({ name: 'heavy', max: 2, key: heavy.key })).toBe(false);
    expect(isConcurrencyLimit('heavy')).toBe(false);
});

test('max from 1 to 1000', () => {
    expect(defineConcurrencyLimit({ name: 'one', max: 1 }).max).toBe(1);
    expect(defineConcurrencyLimit({ name: 'many', max: 1000 }).max).toBe(1000);
});

test.each([
    ['an unknown option', { name: 'heavy', max: 2, weight: 1 }, 'defineConcurrencyLimit("heavy"): unknown options: weight'],
    ['a bad name', { name: 'Heavy', max: 2 }, 'defineConcurrencyLimit("Heavy"): "name" must match /^[a-z][a-z0-9_.-]{0,127}$/'],
    ['no name', { max: 2 }, 'defineConcurrencyLimit(""): "name" must match /^[a-z][a-z0-9_.-]{0,127}$/'],
    ['a max of 0', { name: 'heavy', max: 0 }, 'defineConcurrencyLimit("heavy"): "max" must be an integer from 1 to 1000'],
    ['a max above 1000', { name: 'heavy', max: 1001 }, 'defineConcurrencyLimit("heavy"): "max" must be an integer from 1 to 1000'],
    ['a fractional max', { name: 'heavy', max: 1.5 }, 'defineConcurrencyLimit("heavy"): "max" must be an integer from 1 to 1000'],
    ['the option of the group', { name: 'heavy', maxConcurrency: 2 }, 'defineConcurrencyLimit("heavy"): unknown options: maxConcurrency'],
])('throws a ConfigError for %s', (_, options, message) => {
    expect(() => defineConcurrencyLimit(/** @type {any} */ (options))).toThrow(ConfigError);
    expect(() => defineConcurrencyLimit(/** @type {any} */ (options))).toThrow(message);
});
