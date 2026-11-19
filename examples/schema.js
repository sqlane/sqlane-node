// The app's tables, as Drizzle declares them.
import { pgTable, text } from 'drizzle-orm/pg-core';

export const reports = pgTable('reports', {
    id: text('id').primaryKey(),
    status: text('status').notNull(),
});
