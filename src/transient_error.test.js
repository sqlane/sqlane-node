import { expect, test } from 'vitest';
import { isTransientDbError } from './transient_error.js';

test.each([
    ['a MySQL deadlock', { code: 'ER_LOCK_DEADLOCK', errno: 1213 }],
    ['a MySQL lock wait timeout', { errno: 1205 }],
    ['a PostgreSQL serialization failure', { code: '40001' }],
    ['a PostgreSQL deadlock', { code: '40P01' }],
    ['a deadlock as the cause', new Error('claim failed', { cause: { code: '40P01' } })],
])('%s is transient', (_, error) => {
    expect(isTransientDbError(error)).toBe(true);
});

test.each([
    ['a duplicate key', { code: 'ER_DUP_ENTRY', errno: 1062 }],
    ['a syntax error', { code: '42601' }],
    ['a plain error', new Error('boom')],
    ['undefined', undefined],
])('%s is not transient', (_, error) => {
    expect(isTransientDbError(error)).toBe(false);
});
