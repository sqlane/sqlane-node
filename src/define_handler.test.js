import { expect, test } from 'vitest';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineHandler, isLaneHandler } from './define_handler.js';
import { defineLane } from './define_lane.js';
import { defineRateLimit } from './define_rate_limit.js';
import { ConfigError } from './errors.js';

const report = defineLane({ name: 'report' });
const noop = () => {};

test('gives a frozen handler of the lane, with frozen copies of its local limits', () => {
    const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });
    const disk = defineRateLimit({ name: 'disk', max: 50, per: '1s' });
    const options = { localConcurrencyLimits: [heavy], localRateLimits: [disk], fairShareWeight: 3 };
    const handler = defineHandler(report, noop, options);

    expect(handler).toStrictEqual({ lane: report, handler: noop, ...options });
    expect(Object.isFrozen(handler)).toBe(true);
    expect(Object.isFrozen(handler.localConcurrencyLimits)).toBe(true);
    expect(handler.localConcurrencyLimits).not.toBe(options.localConcurrencyLimits);
    expect(Object.isFrozen(handler.localRateLimits)).toBe(true);
    expect(isLaneHandler(handler)).toBe(true);
});

test('without options: the lane and the function only', () => {
    expect(defineHandler(report, noop)).toStrictEqual({ lane: report, handler: noop });
});

test('isLaneHandler: false for a lane, a copy that is not frozen, a schedule-like object', () => {
    const handler = defineHandler(report, noop);

    expect(isLaneHandler(report)).toBe(false);
    expect(isLaneHandler({ ...handler })).toBe(false);
    expect(isLaneHandler(Object.freeze({ lane: report, id: 'report:a', key: 'a' }))).toBe(false);
    expect(isLaneHandler(null)).toBe(false);
});

test.each([
    ['a lane name', () => defineHandler(/** @type {any} */ ('report'), noop), 'the lane must be a lane definition'],
    ['a lane that is not frozen', () => defineHandler(/** @type {any} */ ({ name: 'report' }), noop),
        'the lane must be a lane definition'],
    ['no function', () => defineHandler(report, /** @type {any} */ (null)), 'the handler must be a function'],
    ['an unknown option', () => defineHandler(report, noop, /** @type {any} */ ({ maxAttempts: 3 })),
        'unknown options: maxAttempts'],
    ['options that are not an object', () => defineHandler(report, noop, /** @type {any} */ (3)), 'must be an object'],
    ['fairShareWeight 0', () => defineHandler(report, noop, { fairShareWeight: 0 }),
        '"fairShareWeight" must be an integer from 1 to 1000'],
    ['fairShareWeight 1001', () => defineHandler(report, noop, { fairShareWeight: 1001 }), '"fairShareWeight"'],
    ['a local limit that is not from defineConcurrencyLimit()', () => defineHandler(report, noop, {
        localConcurrencyLimits: /** @type {any} */ ([{ name: 'b', max: 1 }]),
    }), '"localConcurrencyLimits" must be an array of limits from defineConcurrencyLimit()'],
    ['a local limit twice', () => defineHandler(report, noop, {
        localConcurrencyLimits: [defineConcurrencyLimit({ name: 'b', max: 1 }), defineConcurrencyLimit({ name: 'b', max: 2 })],
    }), '"localConcurrencyLimits" names a limit twice'],
    ['a key of a local rate limit', () => defineHandler(report, noop, {
        localRateLimits: /** @type {any} */ ([defineRateLimit({ name: 'b', max: 1, per: '1s' }).key('k')]),
    }), '"localRateLimits" must be an array of limits from defineRateLimit()'],
    ['a local rate limit twice', () => defineHandler(report, noop, {
        localRateLimits: [defineRateLimit({ name: 'b', max: 1, per: '1s' }), defineRateLimit({ name: 'b', max: 2, per: '1s' })],
    }), '"localRateLimits" names a limit twice'],
])('rejects %s with a ConfigError', (_, func, message) => {
    expect(func).toThrow(ConfigError);
    expect(func).toThrow(`defineHandler(`);
    expect(func).toThrow(message);
});
