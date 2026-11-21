export type JobStatus = import('./types.js').JobStatus;
export type ListCursor = {
    jobName: string;
    /**
     * Sorted; null: every status.
     */
    statuses: readonly JobStatus[] | null;
    enqueuedAtMs: number;
    id: string;
};
/**
 * @typedef {object} ListCursor The filter of a list and the last job of its page: the next page starts after it.
 * @property {string} jobName
 * @property {readonly JobStatus[] | null} statuses Sorted; null: every status.
 * @property {number} enqueuedAtMs
 * @property {string} id
 */
/**
 * @param {unknown} id
 * @returns {boolean} A string that can be the id of a job: printable ASCII, no space at the ends, at most 255
 *     characters. Other strings have no job, on every database.
 */
export declare function isPossibleJobId(id: unknown): boolean;
/**
 * @param {ListCursor} cursor
 * @returns {string} Opaque: base64url of a JSON array. A later field of the filter goes at its end, only when it is
 *     not its default, so that older versions of the major read the cursors of the default filters.
 */
export declare function encodeCursor({ jobName, statuses, enqueuedAtMs, id }: ListCursor): string;
/**
 * @param {unknown} value
 * @returns {ListCursor}
 * @throws {InvalidOptionsError} The value is not a cursor of `list`.
 */
export declare function decodeCursor(value: unknown): ListCursor;
/**
 * @param {unknown} value
 * @returns {string} The value for an error message, whatever it is: JSON.stringify throws on a BigInt or a cycle.
 */
export declare function shown(value: unknown): string;
/**
 * @param {unknown} status
 * @param {string} where The method, for the message.
 * @returns {readonly JobStatus[] | null} The set, sorted. Null: every status.
 */
export declare function statusesOf(status: unknown, where: string): readonly JobStatus[] | null;
/**
 * @param {import('./store/store.js').Store} store
 * @param {(operation: 'retry' | 'cancel' | 'remove', selector: unknown, options: unknown)
 *     => Promise<import('./types.js').BulkResult>} bulk The bulk methods (jobs_bulk.js).
 * @returns {import('./sqlane.js').SqlaneJobs}
 */
export declare function createJobsApi(store: import('./store/store.js').Store, bulk: (operation: 'retry' | 'cancel' | 'remove', selector: unknown, options: unknown) => Promise<import('./types.js').BulkResult>): import('./sqlane.js').SqlaneJobs;
