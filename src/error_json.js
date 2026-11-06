/** The longest stack kept with a job error: the error row and the failure job stay small. */
export const MAX_STACK_LENGTH = 8 * 1024;

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
export function toErrorJson(error) {
    if (!(error instanceof Error)) {
        return { name: 'Error', message: String(error) };
    }

    const { code } = /** @type {{ code?: unknown }} */ (error);

    return {
        name: error.name,
        message: error.message,
        ...(error.stack && { stack: error.stack.slice(0, MAX_STACK_LENGTH) }),
        ...(typeof code === 'string' && { code }),
    };
}
