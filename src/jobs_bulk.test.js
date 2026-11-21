import { describe, expect, test } from 'vitest';
import { InvalidOptionsError } from './errors.js';
import { checkBulk } from './jobs_bulk.js';

describe('checkBulk', () => {
    test('ids: distinct, in the order of their first appearance; impossible ids apart', () => {
        expect(checkBulk('cancel', { jobIds: ['b', 'a', 'b', ' bad', 'é'] }, undefined)).toMatchObject({
            ids: ['b', 'a', ' bad', 'é'],
            filter: null,
            mode: 'atomic',
            strict: false,
            includeAffectedJobIds: false,
            budget: 'reset',
            connection: undefined,
        });
    });

    test('1000 distinct ids, with duplicates: accepted; 1001 distinct: rejected', () => {
        const ids = Array.from({ length: 1000 }, (_, n) => `j:${n}`);

        expect(checkBulk('remove', { jobIds: [...ids, ...ids] }, {}).ids).toHaveLength(1000);
        expect(() => checkBulk('remove', { jobIds: [...ids, 'j:x'] }, {})).toThrow(InvalidOptionsError);
    });

    test('a filter: the definition or the name; the statuses that the operation accepts, its default without', () => {
        expect(checkBulk('retry', { jobName: 'ping' }, {}).filter).toStrictEqual({ jobName: 'ping', statuses: ['failed'] });
        expect(checkBulk('cancel', { jobName: { name: 'ping' } }, {}).filter)
            .toStrictEqual({ jobName: 'ping', statuses: ['pending', 'blocked'] });
        expect(checkBulk('remove', { jobName: 'ping' }, {}).filter)
            .toStrictEqual({ jobName: 'ping', statuses: ['pending', 'blocked', 'completed', 'failed'] });
        expect(checkBulk('remove', { jobName: 'ping', status: ['failed', 'pending'] }, {}).filter)
            .toStrictEqual({ jobName: 'ping', statuses: ['pending', 'failed'] });
        expect(checkBulk('cancel', { jobName: 'ping', status: 'blocked', jobIds: undefined }, {}).filter)
            .toStrictEqual({ jobName: 'ping', statuses: ['blocked'] });
    });

    test('options: budget, mode, strict, includeAffectedJobIds; undefined counts as absent', () => {
        expect(checkBulk('retry', { jobIds: ['a'] }, {
            budget: 'one_more',
            strict: true,
            includeAffectedJobIds: true,
            connection: undefined,
            mode: undefined,
        })).toMatchObject({ budget: 'one_more', strict: true, includeAffectedJobIds: true, mode: 'atomic' });
        expect(checkBulk('cancel', { jobName: 'ping' }, { mode: 'batches', strict: false, connection: undefined }))
            .toMatchObject({ mode: 'batches', strict: false });
    });

    test.each([
        ['neither kind', 'cancel', {}, {}],
        ['both kinds', 'cancel', { jobIds: ['a'], jobName: 'ping' }, {}],
        ['jobIds with status', 'cancel', { jobIds: ['a'], status: 'pending' }, {}],
        ['a selector that is not an object', 'cancel', null, {}],
        ['an unknown selector field', 'cancel', { jobName: 'ping', order: undefined }, {}],
        ['empty jobIds', 'cancel', { jobIds: [] }, {}],
        ['jobIds that is not an array', 'cancel', { jobIds: 'a' }, {}],
        ['a non-string id', 'cancel', { jobIds: ['a', 1] }, {}],
        // oxlint-disable-next-line no-sparse-arrays -- a hole: Array#some skips it
        ['a hole in the ids', 'cancel', { jobIds: [, 'a'] }, {}],
        ['a bad job name', 'cancel', { jobName: 'Bad Name' }, {}],
        ['an unknown status', 'cancel', { jobName: 'ping', status: 'done' }, {}],
        ['a BigInt status', 'cancel', { jobName: 'ping', status: 1n }, {}],
        ['duplicate statuses', 'remove', { jobName: 'ping', status: ['failed', 'failed'] }, {}],
        ['running for cancel', 'cancel', { jobName: 'ping', status: 'running' }, {}],
        ['completed for retry', 'retry', { jobName: 'ping', status: 'completed' }, {}],
        ['pending for retry', 'retry', { jobName: 'ping', status: ['failed', 'pending'] }, {}],
        ['running for remove', 'remove', { jobName: 'ping', status: 'running' }, {}],
        ['options that are not an object', 'cancel', { jobIds: ['a'] }, 'atomic'],
        ['an unknown option', 'cancel', { jobIds: ['a'] }, { sort: undefined }],
        ['budget on cancel', 'cancel', { jobIds: ['a'] }, { budget: 'reset' }],
        ['a bad budget', 'retry', { jobIds: ['a'] }, { budget: 'all' }],
        ['a bad mode', 'cancel', { jobIds: ['a'] }, { mode: 'fast' }],
        ['a BigInt mode', 'cancel', { jobIds: ['a'] }, { mode: 1n }],
        ['a bad strict', 'cancel', { jobIds: ['a'] }, { strict: 'yes' }],
        ['a bad includeAffectedJobIds', 'cancel', { jobIds: ['a'] }, { includeAffectedJobIds: 1 }],
        ['batches with jobIds', 'cancel', { jobIds: ['a'] }, { mode: 'batches' }],
        ['batches with a connection', 'cancel', { jobName: 'ping' }, { mode: 'batches', connection: {} }],
        ['batches with strict', 'cancel', { jobName: 'ping' }, { mode: 'batches', strict: true }],
        ['strict with a filter', 'cancel', { jobName: 'ping' }, { strict: true }],
    ])('rejects %s', (_, operation, selector, options) => {
        const call = /** @type {any} */ (checkBulk);

        expect(() => call(operation, selector, options))
            .toThrow(InvalidOptionsError);
    });

    test('the messages name the method', () => {
        expect(() => checkBulk('retry', { jobName: 'ping', status: 'pending' }, {})).toThrow(/^jobs\.retry: /);
        expect(() => checkBulk('remove', { jobIds: [] }, {})).toThrow(/^jobs\.remove: /);
    });
});
