import { ConfigError } from './errors.js';
import { runMigrations } from './migrations.js';
import { checkTablePrefix } from './validate.js';

/**
 * @param {string} method
 * @returns {never}
 */
function notImplemented(method) {
    throw new Error(`sqlane: ${method}() is not implemented yet`);
}

/**
 * Creates a sqlane instance. It connects, migrates and starts nothing.
 * @template C The connections that `enqueue` accepts, from the adapter.
 * @template {string} [L=never] The lane names, from `lanes`.
 * @param {import('./types.js').SqlaneOptions<C, L>} options
 * @returns {import('./types.js').Sqlane<C, L>}
 */
export function createSqlane(options) {
    if (!options?.adapter) {
        throw new ConfigError('createSqlane: "adapter" is required');
    }

    const tablePrefix = options.tablePrefix ?? 'sqlane_';

    checkTablePrefix(tablePrefix, { where: 'createSqlane', ErrorClass: ConfigError });

    return {
        enqueue: () => notImplemented('enqueue'),
        enqueueMany: () => notImplemented('enqueueMany'),
        handle: () => notImplemented('handle'),
        start: () => notImplemented('start'),
        drain: () => notImplemented('drain'),
        close: () => notImplemented('close'),
        migrate: async migrateOptions => ({
            applied: await runMigrations(options.adapter, tablePrefix, migrateOptions),
        }),
        getStats: () => notImplemented('getStats'),
        wake: () => notImplemented('wake'),
    };
}
