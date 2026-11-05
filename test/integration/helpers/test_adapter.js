import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { inject } from 'vitest';
import { mysql2Adapter } from '../../../src/adapters/mysql2.js';
import { pgAdapter } from '../../../src/adapters/pg.js';

/**
 * @typedef {object} TestAdapter
 * @property {import('../../../src/types.js').Adapter<any>} adapter Over a pool of its own.
 * @property {() => Promise<void>} close Ends the pool.
 */

/**
 * An adapter of the dialect of the current integration project.
 * @returns {TestAdapter}
 */
export function createTestAdapter() {
    const url = inject('databaseUrl');

    if (inject('databaseDialect') === 'mysql') {
        const pool = mysql.createPool({ uri: url, connectionLimit: 4 });

        return { adapter: mysql2Adapter(pool), close: () => pool.end() };
    }

    const pool = new Pool({ connectionString: url, max: 4 });

    return { adapter: pgAdapter(pool), close: () => pool.end() };
}
