export type PrismaClientLike = {
    $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
    $transaction: (func: (tx: any) => Promise<any>, options?: object) => Promise<any>;
};
export type PrismaAdapterOptions = {
    /**
     * The database of the client: Prisma tells it in no public API.
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
};
/**
 * The adapter for Prisma 7 (MySQL or PostgreSQL). `enqueue` then takes a Prisma client (a transaction of its own) or
 * the client of an interactive transaction (the caller's: the job commits with it).
 * @param {PrismaClientLike} prisma The queue's own Prisma client: claims, leases, results.
 * @param {PrismaAdapterOptions} options
 * @returns {import('../types.js').Adapter<PrismaClientLike>}
 */
export declare function prismaAdapter(prisma: PrismaClientLike, options: PrismaAdapterOptions): import('../types.js').Adapter<PrismaClientLike>;
