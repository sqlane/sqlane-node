import { describe, expect, test } from 'vitest';
import { InvalidOptionsError } from './errors.js';
import { createJobsApi, decodeCursor, encodeCursor, isPossibleJobId } from './jobs_api.js';

/**
 * @param {unknown} parts
 * @returns {string} A cursor built by hand.
 */
function cursorOf(parts) {
    return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

const CURSOR = { lane: 'build_report', statuses: /** @type {const} */ (['pending', 'failed']), enqueuedAtMs: 1_763_500_000_123, id: 'build_report:r1' };

/**
 * A cursor that decodes to the bytes of a valid one, but that encodeCursor never writes.
 * @param {'extra' | 'bits'} kind `extra`: one more character after a cursor of a length that is a multiple of 4.
 *     `bits`: the unused low bits of the last character of a cursor whose length is not.
 * @returns {string}
 */
function nonCanonical(kind) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

    for (let n = 0; n < 8; n++) {
        const cursor = encodeCursor({ ...CURSOR, id: `build_report:${'r'.repeat(n + 1)}` });

        if (kind === 'extra' && cursor.length % 4 === 0) {
            return `${cursor}A`;
        }

        if (kind === 'bits' && cursor.length % 4 !== 0) {
            const last = alphabet.indexOf(cursor.at(-1) ?? '');

            return cursor.slice(0, -1) + alphabet[last + 1];
        }
    }

    throw new Error('nonCanonical: no cursor of the needed length');
}

describe('cursors', () => {
    test('decode gives back what encode wrote: opaque base64url', () => {
        const cursor = encodeCursor(CURSOR);

        expect(cursor).toMatch(/^[\w-]+$/);
        expect(decodeCursor(cursor)).toStrictEqual(CURSOR);
        expect(decodeCursor(encodeCursor({ ...CURSOR, statuses: null }))).toStrictEqual({ ...CURSOR, statuses: null });
    });

    test.each([
        ['not a string', 42],
        ['not base64 JSON', 'nonsense'],
        ['not an array', cursorOf({ version: 1 })],
        ['another version', cursorOf([2, 'build_report', null, 0, 'build_report:r1'])],
        ['fewer fields', cursorOf([1, 'build_report', null, 0])],
        ['more fields', cursorOf([1, 'build_report', null, 0, 'build_report:r1', 'extra'])],
        ['a bad lane name', cursorOf([1, 'Bad Name', null, 0, 'build_report:r1'])],
        ['an unknown status', cursorOf([1, 'build_report', ['done'], 0, 'build_report:r1'])],
        ['statuses out of order', cursorOf([1, 'build_report', ['failed', 'pending'], 0, 'build_report:r1'])],
        ['an empty set of statuses', cursorOf([1, 'build_report', [], 0, 'build_report:r1'])],
        ['a time before 1970', cursorOf([1, 'build_report', null, -1, 'build_report:r1'])],
        ['a time after 9999', cursorOf([1, 'build_report', null, Date.UTC(10_000, 0), 'build_report:r1'])],
        ['a time that is not an integer', cursorOf([1, 'build_report', null, 1.5, 'build_report:r1'])],
        ['an id that cannot exist', cursorOf([1, 'build_report', null, 0, 'build_report:é'])],
        // Buffer decodes base64url leniently: each of these would decode as the valid cursor
        ['a valid cursor and "!!"', `${encodeCursor(CURSOR)}!!`],
        ['a valid cursor and a space', `${encodeCursor(CURSOR)} `],
        ['a space and a valid cursor', ` ${encodeCursor(CURSOR)}`],
        ['a valid cursor and "="', `${encodeCursor(CURSOR)}=`],
        ['a valid cursor with a newline', `${encodeCursor(CURSOR).slice(0, 8)}\n${encodeCursor(CURSOR).slice(8)}`],
        ['"+" in place of "-"', encodeCursor({ ...CURSOR, id: 'build_report:~~~~~~' }).replaceAll('-', '+')],
        // Not as encodeCursor writes it: the same bytes after a lenient decode
        ['a valid cursor and one more character', nonCanonical('extra')],
        ['a valid cursor with the unused bits of its last character set', nonCanonical('bits')],
        // Valid JSON, padded with spaces: only the length rejects it
        ['more than 1024 characters', Buffer.from(`[1, "build_report", null, 0, "build_report:r1"${' '.repeat(800)}]`)
            .toString('base64url')],
    ])('decode rejects %s', (_, cursor) => {
        expect(() => decodeCursor(cursor)).toThrow(InvalidOptionsError);
    });
});

describe('list: unknown fields', () => {
    test.each([
        ['in the filter', { lane: 'build_report', sort: undefined }, undefined],
        ['in the options', { lane: 'build_report' }, { order: undefined }],
    ])('an unknown field set to undefined rejects %s', async (_, filter, options) => {
        const jobs = createJobsApi(/** @type {any} */ ({}), /** @type {any} */ (null));

        await expect(jobs.list(/** @type {any} */ (filter), /** @type {any} */ (options)))
            .rejects.toBeInstanceOf(InvalidOptionsError);
    });
});

describe('list: arguments whose message cannot be JSON', () => {
    /** @type {any[]} */
    const circular = ['pending'];

    circular.push(circular);

    test.each([
        ['a BigInt limit', { lane: 'build_report' }, { limit: 10n }],
        ['a BigInt status', { lane: 'build_report', status: 1n }, {}],
        ['a circular list of statuses', { lane: 'build_report', status: circular }, {}],
    ])('%s rejects with an InvalidOptionsError', async (_, filter, options) => {
        const jobs = createJobsApi(/** @type {any} */ ({}), /** @type {any} */ (null));

        await expect(jobs.list(/** @type {any} */ (filter), /** @type {any} */ (options)))
            .rejects.toBeInstanceOf(InvalidOptionsError);
    });
});

test.each([
    ['', false],
    ['build_report:r1', true],
    ['build_report:r1 ', false],
    [' build_report:r1', false],
    ['build_report:é', false],
    [`build_report:${'x'.repeat(242)}`, true],
    [`build_report:${'x'.repeat(243)}`, false],
])('isPossibleJobId(%j): %s', (id, expected) => {
    expect(isPossibleJobId(id)).toBe(expected);
});

/**
 * @returns {{ jobs: ReturnType<typeof createJobsApi>, calls: unknown[] }} The API over a store that records the calls
 *     of keyStats.
 */
function withStore() {
    /** @type {unknown[]} */
    const calls = [];
    const store = {
        keyStats: async (/** @type {unknown} */ params) => {
            calls.push(params);

            return { keys: [], truncated: false };
        },
    };

    return { jobs: createJobsApi(/** @type {any} */ (store), /** @type {any} */ (null)), calls };
}

describe('keyStats: options', () => {
    test('the defaults: 100 keys, every type, ordered by the blocked jobs', async () => {
        const { jobs, calls } = withStore();

        await jobs.keyStats();
        await jobs.keyStats({ limit: undefined, type: undefined, orderBy: undefined });
        await jobs.keyStats({ limit: 3, type: 'concurrency', orderBy: 'held' });
        expect(calls).toStrictEqual([
            { limit: 100, type: null, orderBy: 'blocked' },
            { limit: 100, type: null, orderBy: 'blocked' },
            { limit: 3, type: 'concurrency', orderBy: 'held' },
        ]);
    });

    test.each([
        ['an unknown option', { unknown: 1 }],
        ['an unknown option set to undefined', { unknown: undefined }],
        ['a limit of 0', { limit: 0 }],
        ['a limit of 1001', { limit: 1001 }],
        ['a fractional limit', { limit: 1.5 }],
        ['a string limit', { limit: '5' }],
        ['a BigInt limit', { limit: 10n }],
        ['an unknown type', { type: 'mutex' }],
        ['a type of null', { type: null }],
        ['an unknown order', { orderBy: 'age' }],
        ['the held order of rate keys', { type: 'rate', orderBy: 'held' }],
        ['null', null],
        ['a string', 'x'],
    ])('%s rejects with an InvalidOptionsError', async (_, options) => {
        const { jobs, calls } = withStore();

        await expect(jobs.keyStats(/** @type {any} */ (options))).rejects.toBeInstanceOf(InvalidOptionsError);
        expect(calls).toStrictEqual([]);
    });
});
