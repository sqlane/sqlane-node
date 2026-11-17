export type SequelizeLike = {
    getDialect: () => string;
    transaction: (options: object, func: (t: SequelizeTransactionLike) => Promise<any>) => Promise<any>;
    connectionManager: {
        getConnection: () => Promise<any>;
        releaseConnection: (connection: any) => unknown;
    };
};
export type SequelizeTransactionLike = {
    /**
     * The driver connection: mysql2 (callback API) or a pg client.
     */
    connection: any;
    /**
     * Of a nested transaction (a savepoint).
     */
    parent?: SequelizeTransactionLike | undefined;
    afterCommit: (func: () => unknown) => void;
};
export type SequelizeAdapterOptions = {
    /**
     * The "mysql" dialect of Sequelize (mysql2): `'mariadb'` on MariaDB. Default:
     * `'mysql'`. The "mariadb" dialect of Sequelize is MariaDB without it.
     */
    dialect?: 'mysql' | 'mariadb';
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
 * @param {SequelizeAdapterOptions} [options] The "mysql" dialect of Sequelize (mysql2): `{ dialect: 'mariadb' }` on
 *     MariaDB. The "postgres" dialect: `{ prepare: true }`, named prepared statements.
 * @returns {import('../types.js').Adapter<SequelizeConnection>}
 */
export declare function sequelizeAdapter(sequelize: SequelizeLike, options?: SequelizeAdapterOptions): import('../types.js').Adapter<SequelizeConnection>;
