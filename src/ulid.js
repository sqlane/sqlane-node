import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_CHARS = 16;

let lastTime = -1;
/** @type {number[]} The 16 random base-32 digits of the last ULID */
let lastRandom = [];

/**
 * @returns {number[]} 16 random base-32 digits.
 */
function randomDigits() {
    return [...randomBytes(RANDOM_CHARS)].map(byte => byte % 32);
}

/**
 * @param {number[]} digits
 * @returns {number[] | null} digits + 1, or null on overflow.
 */
function increment(digits) {
    const next = [...digits];

    for (let index = next.length - 1; index >= 0; index--) {
        if (next[index] < 31) {
            next[index]++;

            return next;
        }

        next[index] = 0;
    }

    return null;
}

/**
 * A monotonic ULID: 26 characters, sorted by time, and by creation order in a process within one millisecond.
 * @param {number} [now] For tests. Default: `Date.now()`.
 * @returns {string}
 */
export function ulid(now = Date.now()) {
    let time = Math.max(now, lastTime);
    let random = time === lastTime ? increment(lastRandom) : randomDigits();

    if (!random) {
        time++;
        random = randomDigits();
    }

    lastTime = time;
    lastRandom = random;

    let timeChars = '';

    for (let rest = time, index = 0; index < 10; index++, rest = Math.floor(rest / 32)) {
        timeChars = ALPHABET[rest % 32] + timeChars;
    }

    return timeChars + random.map(digit => ALPHABET[digit]).join('');
}
