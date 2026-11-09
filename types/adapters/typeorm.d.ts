export type StructuredResult = {
    records: any[];
    affected?: number;
};
export type ManagerLike = {
    queryRunner: QueryRunnerLike;
};
export type QueryRunnerLike = {
    query: (sql: string, params: unknown[], structured: true) => Promise<StructuredResult>;
    isTransactionActive: boolean;
    startTransaction: () => Promise<void>;
    release: () => Promise<void>;
    /**
     * TypeORM 1.x.
     */
    dataSource?: any;
    /**
     * TypeORM 0.3.
     */
    connection?: any;
};
export type TypeOrmConnection = any;
/**
 * The adapter for TypeORM (MySQL or MariaDB with mysql2, or PostgreSQL). The type of the DataSource tells the database:
 * `"mariadb"` for MariaDB. `enqueue` then takes a DataSource (a transaction of its own), the EntityManager of a
 * transaction (`dataSource.transaction(manager => …)`), or a QueryRunner in a transaction.
 * @param {any} dataSource The queue's own DataSource, initialized: claims, leases, results.
 * @returns {import('../types.js').Adapter<TypeOrmConnection>}
 */
export declare function typeOrmAdapter(dataSource: any): import('../types.js').Adapter<TypeOrmConnection>;
