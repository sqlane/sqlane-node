/**
 * Creates a generator of 26-character ULIDs, increasing within this factory even when the clock moves backward.
 * @param {{ now?: () => number, random?: () => Uint8Array }} [options] Clock and 10-byte entropy source for tests.
 * @returns {() => string}
 */
export declare function createMonotonicUlid({ now, random }?: {
    now?: () => number;
    random?: () => Uint8Array;
}): () => string;
