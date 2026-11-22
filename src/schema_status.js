// sqlane.schema.getMigrationStatus() and findSchemaProblems(): reads only, on the queue's connections, outside any
// transaction. They never throw on a mismatch: they report it.
import { migrationsOf, unknownIds } from './migrations.js';
import { EXPECTED_SCHEMA } from './schema/expected.js';
import { readColumns, readIndexes, recordedIds } from './store/schema_reads.js';
import { compareVersions, installedVersion, majorBase } from './version.js';

/**
 * @param {import('./types.js').Dialect} dialect
 * @param {string} p
 * @param {string} installed The installed version.
 * @returns {(id: string) => boolean} A migration is required: tagged at or below the base of the installed major.
 */
function requiredBy(dialect, p, installed) {
    const base = majorBase(installed);
    const versions = new Map(migrationsOf(dialect, p).map(({ id, version }) => [id, version]));

    return id => compareVersions(/** @type {string} */ (versions.get(id)), base) <= 0;
}

/**
 * What `schema.migrate()` would do, by the records of `<p>migrations`.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} p
 * @param {import('./migrations.js').SchemaContext} [context]
 * @returns {Promise<import('./types.js').MigrationStatus>}
 */
export async function getMigrationStatus(adapter, p, context = {}) {
    const known = migrationsOf(adapter.dialect, p);
    const recorded = await recordedIds(adapter.queue, p, await readColumns(adapter.queue, adapter.dialect, p));
    const isRequired = requiredBy(adapter.dialect, p, context.installedVersion ?? installedVersion());
    const missing = known.map(({ id }) => id).filter(id => !recorded.has(id));
    const missingRequired = missing.filter(isRequired);

    return {
        ok: missingRequired.length === 0,
        missingRequired,
        missingOptional: missing.filter(id => !isRequired(id)),
        unknownApplied: unknownIds(recorded, known),
    };
}

/**
 * Whether the queries of this version find what they need, by the catalog: the tables, columns and indexes that its
 * migrations create, by name. Anything extra is ignored.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} p
 * @param {import('./migrations.js').SchemaContext} [context]
 * @returns {Promise<import('./types.js').SchemaProblems>}
 */
export async function findSchemaProblems(adapter, p, context = {}) {
    const { dialect } = adapter;
    const isRequired = requiredBy(dialect, p, context.installedVersion ?? installedVersion());
    const [columns, indexes] = await Promise.all([
        readColumns(adapter.queue, dialect, p),
        readIndexes(adapter.queue, dialect, p),
    ]);
    /** @type {import('./types.js').SchemaProblem[]} */
    const problems = [];

    for (const [name, expected] of Object.entries(EXPECTED_SCHEMA[dialect])) {
        const table = `${p}${name}`;
        const found = new Map(columns.filter(column => column.table === table).map(column => [column.column, column]));

        if (found.size === 0) {
            problems.push({ table, issue: 'missing_table', required: isRequired(expected.migration) });
            continue;
        }

        for (const [column, type, notNull, migration = expected.migration] of expected.columns) {
            const actual = found.get(column);
            const required = isRequired(migration);

            if (!actual) {
                problems.push({ table, column, issue: 'missing_column', required });
                continue;
            }

            const foundType = type.includes(' collate ') ? `${actual.type} collate ${actual.collation}` : actual.type;

            if (foundType !== type) {
                problems.push({ table, column, issue: 'wrong_type', expected: type, found: foundType, required });
            }

            if (actual.notNull !== notNull) {
                problems.push({
                    table,
                    column,
                    issue: 'wrong_nullability',
                    expected: notNull ? 'not null' : 'null',
                    found: actual.notNull ? 'not null' : 'null',
                    required,
                });
            }
        }

        for (const [index, definition, migration = expected.migration] of expected.indexes) {
            const indexName = index === 'PRIMARY' ? index : `${p}${index}`;
            const actual = indexes.get(`${table}.${indexName}`);
            const required = isRequired(migration);

            if (actual === undefined) {
                problems.push({ table, index: indexName, issue: 'missing_index', required });
            } else if (actual !== definition) {
                problems.push({
                    table, index: indexName, issue: 'wrong_index', expected: definition, found: actual, required,
                });
            }
        }
    }

    return { ok: !problems.some(problem => problem.required), problems };
}
