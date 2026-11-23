/** The longest stack kept with a job error: the error row and the failure job stay small. */
export const MAX_STACK_LENGTH = 8 * 1024;

/**
 * The error of a stall: written by the stall recovery, and by the claim that fails a job past its maxStalls.
 * @type {Readonly<ErrorJson>}
 */
export const STALLED_ERROR = Object.freeze({
    name: 'StalledError',
    message: 'The lease of the job ended: its process stopped or blocked',
});

/**
 * @typedef {object} ErrorJson
 * @property {string} name
 * @property {string} message
 * @property {string} [stack]
 * @property {string} [code]
 */

/**
 * Text that every database stores in JSON: PostgreSQL jsonb refuses a NUL and a lone surrogate, MySQL and MariaDB a
 * lone surrogate. Each becomes U+FFFD.
 * @param {string} text
 * @returns {string}
 */
function storableText(text) {
    return text.toWellFormed().replaceAll('\0', '\uFFFD');
}

/**
 * The stack, cut to MAX_STACK_LENGTH; a surrogate pair at the cut is dropped whole.
 * @param {string} stack
 * @returns {string}
 */
function cutStack(stack) {
    const cut = stack.slice(0, MAX_STACK_LENGTH);

    // A high surrogate last: its low one is past the cut
    return cut.length < stack.length && /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The JSON of an error, for `last_error` and the failure job. A thrown non-Error becomes its string. Its texts are
 * well-formed and without NUL (see storableText).
 * @param {unknown} error
 * @returns {ErrorJson}
 */
export function toErrorJson(error) {
    if (!(error instanceof Error)) {
        return { name: 'Error', message: storableText(String(error)) };
    }

    const { code } = /** @type {{ code?: unknown }} */ (error);

    return {
        name: storableText(String(error.name)),
        message: storableText(String(error.message)),
        ...(error.stack && { stack: storableText(cutStack(String(error.stack))) }),
        ...(typeof code === 'string' && { code: storableText(code) }),
    };
}
