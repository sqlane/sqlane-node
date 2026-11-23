import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { checkApiDocs } from './check_api_docs.js';

/**
 * @param {string} members
 * @returns {string} A file with the Sqlane interface and these members.
 */
const file = members => `import type { X } from './types.js';\n\nexport interface Sqlane<C> {\n${members}\n}\n`;

describe('checkApiDocs', () => {
    test('src/sqlane.ts has no problem', () => {
        expect(checkApiDocs(readFileSync('src/sqlane.ts', 'utf8'))).toStrictEqual([]);
    });

    test('a documented method passes; brackets in its docs and types do not confuse the reader', () => {
        const source = file(`    /**
     * Runs \`{ payload }\` with \`defineLane<{ id: number }>(…)\`.
     * @param job The job.
     * @param handler Gets \`{ payload, signal }\`.
     * @returns The result.
     */
    handle<J extends X | string, P>(job: J, handler: (context: { payload: P }) => unknown): Promise<X[]>;

    /** Wakes it. */
    wake(): void;

    /** Starts it. */
    start(): Promise<void>;`);

        expect(checkApiDocs(source)).toStrictEqual([]);
    });

    test('each gap is a problem', () => {
        const source = file(`    stats(): Promise<X[]>;

    /**
     * @param a The a.
     */
    noText(a: X): void;

    /**
     * Has text.
     * @param a
     */
    bareParam(a: X, b?: { c: number }): void;

    /** Has text. */
    noReturns(): Promise<X>;`);

        expect(checkApiDocs(source)).toStrictEqual([
            'stats: no JSDoc',
            'noText: no description',
            'bareParam: no @param text for "a"',
            'bareParam: no @param text for "b"',
            'noReturns: no @returns text',
        ]);
    });

    test('a group of methods: a documented property of Sqlane, whose interface is checked too', () => {
        const source = `export interface SqlaneJobs {
    /**
     * Reads one job.
     * @param jobId The id.
     * @returns The job.
     */
    get(jobId: string): Promise<X | null>;

    list(filter: X): Promise<X[]>;
}

export interface Sqlane<C> {
    /** The jobs in the database. */
    readonly jobs: SqlaneJobs;

    readonly schedules: X;
}
`;

        expect(checkApiDocs(source)).toStrictEqual(['SqlaneJobs.list: no JSDoc', 'schedules: no JSDoc']);
    });

    test('a file without the interface is a problem', () => {
        expect(checkApiDocs('export type Sqlane = {};')).toStrictEqual(['no `export interface Sqlane<…> {`']);
    });
});
