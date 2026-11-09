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
export type SequelizeConnection = SequelizeLike | SequelizeTransactionLike;
/**
 * The adapter for Sequelize 6 (MySQL or PostgreSQL). `enqueue` then takes a Sequelize instance (a transaction of its
 * own) or a Sequelize transaction, also nested (the caller's: the job commits with it).
 * @param {SequelizeLike} sequelize The queue's own Sequelize instance: claims, leases, results. A small pool of its
 *     own is best.
 * @returns {import('../types.js').Adapter<SequelizeConnection>}
 */
export declare function sequelizeAdapter(sequelize: SequelizeLike): import('../types.js').Adapter<SequelizeConnection>;
