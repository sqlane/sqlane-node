import { InvalidOptionsError, PayloadTooLargeError } from './errors.js';

export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Serializes a payload: JSON, well-formed strings (MySQL refuses a lone surrogate), no NUL character (PostgreSQL
 * refuses it), at most maxBytes.
 * @param {unknown} payload
 * @param {number} maxBytes
 * @param {string} where For the error message.
 * @returns {string} The JSON.
 */
export function serializePayload(payload, maxBytes, where) {
    let wellFormed = true;
    let hasNul = false;
    let json;

    try {
        json = JSON.stringify(payload, (key, value) => {
            if (!key.isWellFormed() || (typeof value === 'string' && !value.isWellFormed())) {
                wellFormed = false;
            }

            if (key.includes('\0') || (typeof value === 'string' && value.includes('\0'))) {
                hasNul = true;
            }

            return value;
        });
    } catch (error) {
        throw new InvalidOptionsError(`${where}: the payload is not JSON`, { cause: error });
    }

    if (json === undefined) {
        throw new InvalidOptionsError(`${where}: the payload is not JSON`);
    }

    if (!wellFormed) {
        throw new InvalidOptionsError(`${where}: the payload has a string that is not well-formed UTF-16`);
    }

    if (hasNul) {
        // PostgreSQL jsonb refuses it: refused on both databases, for the same behavior
        throw new InvalidOptionsError(`${where}: the payload has a NUL character (\\u0000)`);
    }

    const bytes = Buffer.byteLength(json);

    if (bytes > maxBytes) {
        throw new PayloadTooLargeError(`${where}: the payload has ${bytes} bytes of JSON, at most ${maxBytes}`);
    }

    return json;
}
