import { expect, test } from 'vitest';
import { ulid } from './ulid.js';

test('has 26 Crockford base-32 characters and starts with the time', () => {
    const id = ulid(1_700_000_000_000);

    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.slice(0, 10)).toBe('01HF7YAT00');
});

test('is monotonic within one millisecond and when the clock goes back', () => {
    const ids = [ulid(1_800_000_000_000), ulid(1_800_000_000_000), ulid(1_799_999_999_000), ulid(1_800_000_000_001)];

    expect(ids.toSorted()).toStrictEqual(ids);
    expect(new Set(ids).size).toBe(4);
});
