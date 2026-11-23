export type ExpectedTable = {
    /**
     * The id of the migration that gives it this name and definition: also that of its
     * columns and indexes, unless they name one.
     */
    migration: string;
    /**
     * The type as the catalog
     * reports it (MySQL `COLUMN_TYPE` without display widths, PostgreSQL `format_type`), with ` collate <name>` where
     * the migration sets one.
     */
    columns: [name: string, type: string, notNull: boolean, migration?: string][];
    /**
     * The name without the prefix (MySQL's
     * primary key: `PRIMARY`); the definition as `readIndexes` writes it.
     */
    indexes: [name: string, definition: string, migration?: string][];
};
/** @type {Record<import('../types.js').Dialect, Record<string, ExpectedTable>>} By table name without the prefix */
export declare const EXPECTED_SCHEMA: Record<import('../types.js').Dialect, Record<string, ExpectedTable>>;
