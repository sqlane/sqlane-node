import { expect, test } from 'vitest';
import { MAX_STACK_LENGTH, toErrorJson } from './error_json.js';
import { FatalJobError } from './errors.js';

test('keeps the name, the message, the stack and a string code', () => {
    const error = new FatalJobError('gone');

    expect(toErrorJson(error)).toStrictEqual({
        name: 'FatalJobError',
        message: 'gone',
        stack: error.stack,
        code: 'FATAL_JOB',
    });
});

test('cuts the stack', () => {
    const error = new Error('long');

    error.stack = 'x'.repeat(MAX_STACK_LENGTH + 10);

    expect(toErrorJson(error).stack).toHaveLength(MAX_STACK_LENGTH);
});

test('a thrown non-Error becomes its string', () => {
    expect(toErrorJson('boom')).toStrictEqual({ name: 'Error', message: 'boom' });
    expect(toErrorJson(undefined)).toStrictEqual({ name: 'Error', message: 'undefined' });
});
