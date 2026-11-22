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

test('a NUL and a lone surrogate become U+FFFD, in every text', () => {
    const error = new Error('a\0b\uD800');

    error.name = 'Bad\uDC00';
    error.stack = 'at \0';
    Object.assign(error, { code: 'C\0' });

    expect(toErrorJson(error)).toStrictEqual({
        name: 'Bad�',
        message: 'a�b�',
        stack: 'at �',
        code: 'C�',
    });
    expect(toErrorJson('x\0')).toStrictEqual({ name: 'Error', message: 'x�' });
});

test('a surrogate pair at the cut of the stack is dropped whole', () => {
    const error = new Error('long');

    error.stack = `${'x'.repeat(MAX_STACK_LENGTH - 1)}\u{1F600}`;
    expect(toErrorJson(error).stack).toBe('x'.repeat(MAX_STACK_LENGTH - 1));

    error.stack = `${'x'.repeat(MAX_STACK_LENGTH - 2)}\u{1F600}yy`;
    expect(toErrorJson(error).stack).toBe(`${'x'.repeat(MAX_STACK_LENGTH - 2)}\u{1F600}`);
});
