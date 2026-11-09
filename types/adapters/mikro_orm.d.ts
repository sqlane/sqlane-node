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
     * `'postgres'` with `@mikro-orm/postgresql`.
     */
    dialect: import('../types.js').Dialect;
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
