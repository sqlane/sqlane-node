import { randomBytes } from 'node:crypto';

// Implements the canonical ULID specification: https://github.com/ulid/spec
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;
const MAX_RANDOM = (1n << 80n) - 1n;

/**
 * @param {bigint} value
 * @param {number} length
 * @returns {string}
 */
function encode(value, length) {
    let remaining = value;
    let result = '';

    for (let i = 0; i < length; i++) {
        result = ALPHABET[Number(remaining & 31n)] + result;
        remaining >>= 5n;
    }

    return result;
}

/**
 * Creates a generator of 26-character ULIDs, increasing within this factory even when the clock moves backward.
 * @param {{ now?: () => number, random?: () => Uint8Array }} [options] Clock and 10-byte entropy source for tests.
 * @returns {() => string}
 */
export function createMonotonicUlid({ now = () => Date.now(), random = () => randomBytes(10) } = {}) {
    let lastTime = -1;
    let suffix = 0n;

    return () => {
        const time = now();

        if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
            throw new RangeError('ULID timestamp must be an integer between 0 and 2^48 - 1');
        }

        if (time > lastTime) {
            const bytes = random();

            if (bytes.length !== 10) {
                throw new RangeError('ULID entropy must contain 10 bytes');
            }

            let nextSuffix = 0n;

            for (const byte of bytes) {
                nextSuffix = (nextSuffix << 8n) | BigInt(byte);
            }

            suffix = nextSuffix;
            lastTime = time;
        } else {
            if (suffix === MAX_RANDOM) {
                throw new RangeError('ULID random suffix overflow');
            }

            suffix++;
        }

        return encode(BigInt(lastTime), 10) + encode(suffix, 16);
    };
}
