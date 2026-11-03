// The values that vitest.config.js and global_setup.js give to the integration tests (`inject()`)
// oxlint-disable-next-line import/no-unassigned-import -- the import makes this file augment the module
import 'vitest';

declare module 'vitest' {
    export interface ProvidedContext {
        databaseName: string;
        databaseDialect: 'mysql' | 'postgres';
        databaseUrl: string;
    }
}
