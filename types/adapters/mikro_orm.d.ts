export type EntityManagerLike = {
    /**
     * A knex transaction (MikroORM 6), a Kysely controlled transaction
     * (MikroORM 7), or undefined.
     */
    getTransactionContext: () => any;
    getConnection: (type: 'write') => any;
    /**
     * The EntityManager of the current context: of
     * `em.transactional()`, when called on the global one.
     */
    getContext: (validate: false) => EntityManagerLike;
    getEventManager: () => {
        registerSubscriber: (subscriber: object) => void;
    };
};
export type MikroOrmAdapterOptions = {
    /**
     * The database: `'mysql'` or `'mariadb'` with `@mikro-orm/mysql`,
     * `'mariadb'` with `@mikro-orm/mariadb`, `'postgres'` with `@mikro-orm/postgresql`.
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
     * PostgreSQL: named prepared statements, each SQL text parsed and planned once per
     * connection. MikroORM 6: all of sqlane's SQL. MikroORM 7.2+: the queue's own SQL, on the pg pool under Kysely
     * (an enqueue runs through Kysely, unnamed). Opt-in: not behind a pooler in transaction mode without prepared
     * statement support (PgBouncer before 1.21). Default: false.
     */
    prepare?: boolean;
};
/**
 * The adapter for MikroORM 6 or 7 (MySQL or PostgreSQL). `enqueue` then takes an EntityManager: of a transaction (the
 * caller's: the job commits with it), the global one inside `em.transactional()` (its transaction), or one outside a
 * transaction (a transaction of its own).
 * @param {EntityManagerLike} em The EntityManager of the queue's own MikroORM: claims, leases, results
 *     (`MikroORM.init()`). A small pool of its own is best.
 * @param {MikroOrmAdapterOptions} options
 * @returns {import('../types.js').Adapter<EntityManagerLike>}
 */
export declare function mikroOrmAdapter(em: EntityManagerLike, options: MikroOrmAdapterOptions): import('../types.js').Adapter<EntityManagerLike>;
