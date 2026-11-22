import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { baseVersion, compareVersions, installedVersion, majorBase, parseVersion } from './version.js';

test.each(['0.0.0', '7.1.0', '10.20.30'])('parses %o', (text) => {
    expect(parseVersion(text)).toStrictEqual(text.split('.').map(Number));
});

test.each(['v7.1.0', '7.1', '7.1.0-rc.1', '07.1.0', '1e3.0.0', '7.1.0 ', '', 710, null])('rejects %o', (value) => {
    expect(parseVersion(value)).toBeNull();
});

test.each([
    ['7.1.0', '7.1.0', 0],
    ['7.0.4', '7.1.0', -1],
    ['10.0.0', '9.9.9', 1],
    ['6.0.1', '6.0.0', 1],
])('compares %s with %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
});

test.each([
    ['8.0.0-rc.1', '8.0.0'],
    ['8.2.0-beta.0', '8.2.0'],
    ['7.1.0', '7.1.0'],
])('the base version of %s: %s', (version, base) => {
    expect(baseVersion(version)).toBe(base);
});

test('the installed version: the version of package.json', () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

    expect(installedVersion()).toBe(version);
});

test.each([
    ['7.1.0', '7.0.0'],
    ['8.0.0', '8.0.0'],
    ['8.2.1-rc.1', '8.0.0'],
])('the major base of %s: %s', (version, base) => {
    expect(majorBase(version)).toBe(base);
});
