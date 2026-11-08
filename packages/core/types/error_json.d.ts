/** The longest stack kept with a job error: the error row and the failure job stay small. */
export declare const MAX_STACK_LENGTH: number;
export type ErrorJson = {
    name: string;
    message: string;
    stack?: string;
    code?: string;
};
/**
 * @typedef {object} ErrorJson
 * @property {string} name
 * @property {string} message
 * @property {string} [stack]
 * @property {string} [code]
 */
/**
 * The JSON of an error, for `last_error` and the failure job. A thrown non-Error becomes its string.
 * @param {unknown} error
 * @returns {ErrorJson}
 */
export declare function toErrorJson(error: unknown): ErrorJson;
