/**
 * An adapter that runs callbacks before or after the statements that match a pattern, or rejects them: for the tests
 * of what happens between two statements of sqlane. It wraps the executors that sqlane gets from the adapter: the
 * queue's pool, the queue's transactions, the caller's connection (`inTransaction`) and a pool given as a connection
 * (`poolTransaction`). The patterns are single-line regexes, tested against the whole statement.
 * @param {import('../../../src/types.js').Adapter<any>} inner
 * @returns {{
 *     adapter: import('../../../src/types.js').Adapter<any>,
 *     afterStatement: (pattern: RegExp, callback: (sql: string) => unknown) => void,
 *     beforeStatement: (pattern: RegExp, callback: (sql: string) => unknown) => void,
 *     rejectOn: (pattern: RegExp, makeError: () => Error) => void,
 * }}
 */
export function hookAdapter(inner) {
    /** @type {{ pattern: RegExp, callback: (sql: string) => unknown }[]} */
    const hooks = [];
    /** @type {{ pattern: RegExp, callback: (sql: string) => unknown }[]} */
    const beforeHooks = [];
    /** @type {{ pattern: RegExp, makeError: () => Error }[]} */
    const rejections = [];

    /**
     * @param {import('../../../src/types.js').Executor} executor
     * @returns {import('../../../src/types.js').Executor}
     */
    function hooked(executor) {
        /**
         * @param {'query' | 'run'} method
         * @returns {(sql: string, params: readonly unknown[]) => Promise<any>}
         */
        const call = method => async (sql, params) => {
            const rejection = rejections.find(({ pattern }) => pattern.test(sql));

            if (rejection) {
                throw rejection.makeError();
            }

            const before = beforeHooks.findIndex(({ pattern }) => pattern.test(sql));

            if (before !== -1) {
                // Armed once
                const [{ callback }] = beforeHooks.splice(before, 1);

                await callback(sql);
            }

            const result = await executor[method](sql, params);
            const at = hooks.findIndex(({ pattern }) => pattern.test(sql));

            if (at !== -1) {
                // Armed once
                const [{ callback }] = hooks.splice(at, 1);

                await callback(sql);
            }

            return result;
        };

        return { query: call('query'), run: call('run') };
    }

    return {
        adapter: {
            ...inner,
            queue: hooked(inner.queue),
            queueTransaction: func => inner.queueTransaction(executor => func(hooked(executor))),
            inTransaction: (connection, func) => inner.inTransaction(connection, executor => func(hooked(executor))),
            poolTransaction: (connection, func) => inner.poolTransaction?.(
                connection,
                executor => func(hooked(executor)),
            ) ?? null,
        },
        afterStatement: (pattern, callback) => {
            hooks.push({ pattern, callback });
        },
        beforeStatement: (pattern, callback) => {
            beforeHooks.push({ pattern, callback });
        },
        rejectOn: (pattern, makeError) => {
            rejections.push({ pattern, makeError });
        },
    };
}
