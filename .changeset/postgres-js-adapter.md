---
'@sqlane/core': minor
---

The postgres.js adapter: `import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js'`, then
`postgresJsAdapter(sql)`. `enqueue` takes the `sql` of postgres.js (a transaction of its own) or the `sql` of a
transaction (`sql.begin`, also a savepoint). `{ notify: true }` sends the hints by NOTIFY. postgres.js 3.4 and 4.

The Drizzle adapter takes Drizzle over postgres.js too (`drizzle-orm/postgres-js`). Kysely over postgres.js
(`kysely-postgres-js`) works with the Kysely adapter.

On PostgreSQL, the JSON parameters of sqlane's SQL are sent as text (`$1::text::jsonb`): a driver that serializes a
`jsonb` parameter itself (postgres.js) gets the JSON string as it is.
