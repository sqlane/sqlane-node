import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { pinLinks, refOf } from './pin_readme_links.js';

test.each([
    { version: '7.0.1', expected: 'v7.0.1' },
    { version: '7.1.0-next.0', expected: 'abc123' },
    { version: '0.0.0-abc123', expected: 'abc123' },
])('the ref of $version: $expected', ({ version, expected }) => {
    expect(refOf(version, 'abc123')).toBe(expected);
});

test('the links to the files of main point at the ref; the CI badge keeps main', () => {
    const text = [
        '[api](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#start)',
        '[examples](https://github.com/sqlane/sqlane-node/tree/main/examples/)',
        '<img src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf.svg">',
        '[![CI](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml/badge.svg?branch=main)]',
    ].join('\n');

    expect(pinLinks(text, 'v7.0.1').split('\n')).toStrictEqual([
        '[api](https://github.com/sqlane/sqlane-node/blob/v7.0.1/docs/api.md#start)',
        '[examples](https://github.com/sqlane/sqlane-node/tree/v7.0.1/examples/)',
        '<img src="https://raw.githubusercontent.com/sqlane/sqlane-node/v7.0.1/docs/images/perf.svg">',
        '[![CI](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml/badge.svg?branch=main)]',
    ]);
});

test('the README keeps no link to main, but the CI badge', () => {
    const pinned = pinLinks(readFileSync('README.md', 'utf8'), 'v7.0.1');
    const urls = pinned.matchAll(/[^\s"()]*sqlane\/sqlane-node[^\s"()]*\bmain\b[^\s"()]*/gu);
    const toMain = Array.from(urls, ([url]) => url);

    expect(toMain.filter(url => !url.includes('badge.svg?branch=main'))).toStrictEqual([]);
});
