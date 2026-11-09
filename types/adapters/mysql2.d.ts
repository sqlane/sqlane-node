export type Mysql2Connection = import('mysql2/promise').Pool | import('mysql2/promise').PoolConnection | import('mysql2/promise').Connection;
/**
 * The adapter for mysql2 (its promise API). `enqueue` then takes a `Connection`, a `PoolConnection` (in a
 * transaction) or a `Pool`.
 * @param {import('mysql2/promise').Pool} pool The queue's own pool: claims, leases, results.
 * @param {import('./dialect.js').MysqlFamilyOptions} [options] `{ dialect: 'mariadb' }` on MariaDB.
 * @returns {import('../types.js').Adapter<Mysql2Connection>}
 */
export declare function mysql2Adapter(pool: import('mysql2/promise').Pool, options?: import('./dialect.js').MysqlFamilyOptions): import('../types.js').Adapter<Mysql2Connection>;
