---
'@sqlane/core': minor
---

The Drizzle adapter: `import { drizzleAdapter } from '@sqlane/core/adapter-drizzle'`, then `drizzleAdapter(db)`.
`enqueue` takes a Drizzle database (a transaction of its own) or a Drizzle transaction, also nested. drizzle-orm 0.45
and 1.0 (beta), with mysql2 or node-postgres; with node-postgres, `{ notify: true }` sends the hints by NOTIFY.
