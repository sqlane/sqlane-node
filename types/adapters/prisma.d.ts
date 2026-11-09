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
};
/**
 * The adapter for Prisma 7 (MySQL or PostgreSQL). `enqueue` then takes a Prisma client (a transaction of its own) or
 * the client of an interactive transaction (the caller's: the job commits with it).
 * @param {PrismaClientLike} prisma The queue's own Prisma client: claims, leases, results.
 * @param {PrismaAdapterOptions} options
 * @returns {import('../types.js').Adapter<PrismaClientLike>}
 */
export declare function prismaAdapter(prisma: PrismaClientLike, options: PrismaAdapterOptions): import('../types.js').Adapter<PrismaClientLike>;
