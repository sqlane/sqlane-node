// The versions of sqlane: the installed one, and those that tag the migrations.
import { createRequire } from 'node:module';

/** 'X.Y.Z' only: no 'v', no pre-release */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** @type {string | null} */
let installed = null;

/**
 * The version of this package. Read from its package.json on the first call, never at import.
 * @returns {string}
 */
export function installedVersion() {
    installed ??= String(createRequire(import.meta.url)('../package.json').version);

    return installed;
}

/**
 * @param {unknown} value
 * @returns {number[] | null} The major, minor and patch. Null: not 'X.Y.Z'.
 */
export function parseVersion(value) {
    const match = typeof value === 'string' ? VERSION.exec(value) : null;

    return match ? match.slice(1).map(Number) : null;
}

/**
 * @param {string} a 'X.Y.Z'.
 * @param {string} b 'X.Y.Z'.
 * @returns {number} Negative: a is below b; 0: equal; positive: a is above b.
 */
export function compareVersions(a, b) {
    const [left, right] = [a, b].map(version => /** @type {number[]} */ (parseVersion(version)));

    return left.map((part, index) => part - right[index]).find(difference => difference !== 0) ?? 0;
}

/**
 * An installed pre-release counts as its base version: `8.0.0-rc.1` is `8.0.0`.
 * @param {string} version
 * @returns {string}
 */
export function baseVersion(version) {
    return version.replace(/-.*$/su, '');
}

/**
 * The schema that every release of a major runs on: `X.0.0`.
 * @param {string} version A pre-release counts as its base version.
 * @returns {string}
 */
export function majorBase(version) {
    return `${baseVersion(version).split('.')[0]}.0.0`;
}
