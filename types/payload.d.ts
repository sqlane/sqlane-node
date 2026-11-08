export declare const DEFAULT_MAX_PAYLOAD_BYTES: number;
/**
 * Serializes a payload: JSON, well-formed strings (MySQL refuses a lone surrogate), no NUL character (PostgreSQL
 * refuses it), at most maxBytes.
 * @param {unknown} payload
 * @param {number} maxBytes
 * @param {string} where For the error message.
 * @returns {string} The JSON.
 */
export declare function serializePayload(payload: unknown, maxBytes: number, where: string): string;
