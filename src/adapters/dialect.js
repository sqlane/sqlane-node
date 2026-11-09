// The dialect of an adapter over a MySQL driver: MySQL and MariaDB speak the same protocol, so the app tells which.
import { ConfigError } from '../errors.js';

/**
 * @typedef {object} MysqlFamilyOptions
 * @property {'mysql' | 'mariadb'} [dialect] Default: `'mysql'`. `'mariadb'` for MariaDB 10.11+.
 */

/**
 * @param {MysqlFamilyOptions | undefined} options
 * @param {string} where The adapter, for the error.
 * @returns {'mysql' | 'mariadb'}
 */
export function mysqlFamilyDialect(options, where) {
    const dialect = options?.dialect ?? 'mysql';

    if (dialect !== 'mysql' && dialect !== 'mariadb') {
        throw new ConfigError(`${where}: "dialect" must be "mysql" or "mariadb"`);
    }

    return dialect;
}
