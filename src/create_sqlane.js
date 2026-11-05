import { ConfigError } from './errors.js';

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

    return {
        enqueue: () => notImplemented('enqueue'),
        enqueueMany: () => notImplemented('enqueueMany'),
        handle: () => notImplemented('handle'),
        start: () => notImplemented('start'),
        drain: () => notImplemented('drain'),
        close: () => notImplemented('close'),
        migrate: () => notImplemented('migrate'),
        getStats: () => notImplemented('getStats'),
        wake: () => notImplemented('wake'),
    };
}
