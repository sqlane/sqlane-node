// The options that every adapter takes: the database (`dialect`), which the app always names, and
// `allowUnsupportedVersion`. The worker and `migrate()` check both against the server (server_check.js).
import { ConfigError } from '../errors.js';

/**
 * The checked options of an adapter.
 * @template {import('../types.js').Dialect} D
 * @typedef {object} AdapterDialect
 * @property {D} dialect
 * @property {boolean} allowUnsupportedVersion
 */

/**
 * @param {readonly string[]} values
 * @returns {string} `"mysql" or "mariadb"`.
 */
function listOf(values) {
    const quoted = values.map(value => JSON.stringify(value));

    return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}` : quoted.join('');
}

/**
 * Checks `dialect` and `allowUnsupportedVersion` of the options of an adapter.
 * @template {import('../types.js').Dialect} D
 * @param {unknown} options
 * @param {string} where The adapter, for the error.
 * @param {readonly D[]} allowed The dialects of the adapter.
 * @returns {AdapterDialect<D>}
 */
export function checkAdapterDialect(options, where, allowed) {
    const given = /** @type {{ dialect?: unknown, allowUnsupportedVersion?: unknown } | null | undefined} */ (options);
    const dialect = given?.dialect;

    if (dialect === undefined) {
        throw new ConfigError(`${where}: "dialect" is required: ${listOf(allowed)}`);
    }

    if (!allowed.includes(/** @type {D} */ (dialect))) {
        throw new ConfigError(`${where}: "dialect" must be ${listOf(allowed)}, not ${JSON.stringify(dialect)}`);
    }

    const allowUnsupportedVersion = given?.allowUnsupportedVersion ?? false;

    if (typeof allowUnsupportedVersion !== 'boolean') {
        throw new ConfigError(`${where}: "allowUnsupportedVersion" must be a boolean`);
    }

    return { dialect: /** @type {D} */ (dialect), allowUnsupportedVersion };
}

/**
 * Checks the dialect against the database that the library tells.
 * @template {import('../types.js').Dialect} D
 * @param {D} dialect Checked.
 * @param {readonly import('../types.js').Dialect[]} possible The dialects of the library's database.
 * @param {string} where The adapter, for the error.
 * @param {string} library What tells the database, for the error: `the client of knex is "mariadb"`.
 * @returns {D}
 */
export function matchLibraryDialect(dialect, possible, where, library) {
    if (!possible.includes(dialect)) {
        throw new ConfigError(`${where}: "dialect" is ${JSON.stringify(dialect)}, but ${library}: ${listOf(possible)}`);
    }

    return dialect;
}
