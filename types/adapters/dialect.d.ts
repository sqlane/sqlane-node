export type MysqlFamilyOptions = {
    /**
     * Default: `'mysql'`. `'mariadb'` for MariaDB 10.11+.
     */
    dialect?: 'mysql' | 'mariadb';
};
/**
 * @typedef {object} MysqlFamilyOptions
 * @property {'mysql' | 'mariadb'} [dialect] Default: `'mysql'`. `'mariadb'` for MariaDB 10.11+.
 */
/**
 * @param {MysqlFamilyOptions | undefined} options
 * @param {string} where The adapter, for the error.
 * @returns {'mysql' | 'mariadb'}
 */
export declare function mysqlFamilyDialect(options: MysqlFamilyOptions | undefined, where: string): 'mysql' | 'mariadb';
