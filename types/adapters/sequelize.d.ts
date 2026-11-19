export type SequelizeLike = {
    getDialect: () => string;
    transaction: (options: object, func: (t: SequelizeTransactionLike) => Promise<any>) => Promise<any>;
    connectionManager: {
        getConnection: (options?: any) => Promise<any>;
        releaseConnection: (connection: any) => unknown;
    };
};
export type SequelizeTransactionLike = {
    /**
     * The driver connection: mysql2 (callback API) or a pg client. Optional here because
     * Sequelize's types don't declare it; a running transaction always has it.
     */
    connection?: any;
    /**
     * Of a nested transaction (a savepoint).
     */
    parent?: SequelizeTransactionLike | undefined;
    afterCommit: (func: () => void) => void;
};
export type SequelizeAdapterOptions = {
    /**
     * The database: `'mysql'` or `'mariadb'` with the "mysql" dialect of
     * Sequelize (mysql2), `'mariadb'` with its "mariadb" dialect, `'postgres'` with its "postgres" dialect.
     */
    dialect: import('../types.js').Dialect;
    /**
     * Runs on a server below the supported minimum, with a warning.
     * Default: false.
     */
    allowUnsupportedDbVersion?: boolean;
    /**
     * MySQL and MariaDB: runs with a `sql_mode` that lacks a required
     * flag, or has `ALLOW_INVALID_DATES`, with a warning. Never with `NO_BACKSLASH_ESCAPES`. Default: false.
     */
    allowUnsupportedDbConfiguration?: boolean;
    /**
     * The "postgres" dialect: named prepared statements, each SQL text parsed and planned
     * once per connection. Opt-in: not behind a pooler in transaction mode without prepared statement support
     * (PgBouncer before 1.21). Default: false.
     */
    prepare?: boolean;
};
export type SequelizeConnection = SequelizeLike | SequelizeTransactionLike;
/**
 * The adapter for Sequelize 6 (MySQL, MariaDB or PostgreSQL). `enqueue` then takes a Sequelize instance (a transaction
 * of its own) or a Sequelize transaction, also nested (the caller's: the job commits with it).
 * @param {SequelizeLike} sequelize The queue's own Sequelize instance: claims, leases, results. A small pool of its
 *     own is best.
 * @param {SequelizeAdapterOptions} options `{ dialect }`. The "postgres" dialect: `{ prepare: true }`, named prepared
 *     statements.
 * @returns {import('../types.js').Adapter<SequelizeConnection>}
 */
export declare function sequelizeAdapter(sequelize: SequelizeLike, options: SequelizeAdapterOptions): import('../types.js').Adapter<SequelizeConnection>;
