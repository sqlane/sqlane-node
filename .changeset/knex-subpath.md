---
'@sqlane/core': minor
---

The knex adapter is now part of the core: `import { knexAdapter } from '@sqlane/core/knex'`. It replaces
`@sqlane/adapter-knex` (deprecated): same API, and no other package to install. No ORM is a peer dependency of the
core: the adapter checks the knex instance that it gets.
