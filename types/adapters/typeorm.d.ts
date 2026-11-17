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
export type TypeOrmAdapterOptions = {
    /**
     * The database: `'mysql'` or `'mariadb'` with the type `"mysql"`,
     * `'mariadb'` with the type `"mariadb"`, `'postgres'` with the type `"postgres"`.
     */
    dialect: import('../types.js').Dialect;
    /**
     * Runs on a server below the supported minimum, with a warning. Default:
     * false.
     */
    allowUnsupportedVersion?: boolean;
};
/**
 * The adapter for TypeORM (MySQL or MariaDB with mysql2, or PostgreSQL). `enqueue` then takes a DataSource (a
 * transaction of its own), the EntityManager of a transaction (`dataSource.transaction(manager => …)`), or a
 * QueryRunner in a transaction.
 * @param {any} dataSource The queue's own DataSource, initialized: claims, leases, results.
 * @param {TypeOrmAdapterOptions} options
 * @returns {import('../types.js').Adapter<TypeOrmConnection>}
 */
export declare function typeOrmAdapter(dataSource: any, options: TypeOrmAdapterOptions): import('../types.js').Adapter<TypeOrmConnection>;
