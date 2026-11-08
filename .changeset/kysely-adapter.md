---
'@sqlane/core': minor
---

The Kysely adapter: `import { kyselyAdapter } from '@sqlane/core/kysely'`, then `kyselyAdapter(db, { dialect })`.
`enqueue` takes a Kysely instance (a transaction of its own) or a Kysely transaction, also a controlled one. The SQL of
sqlane runs without the plugins of the instance (a `CamelCasePlugin` does not rename its columns). Kysely 0.28 and
0.29, with its MySQL or PostgreSQL dialect.
