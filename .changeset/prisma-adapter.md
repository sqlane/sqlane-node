---
'@sqlane/core': minor
---

The Prisma adapter: `import { prismaAdapter } from '@sqlane/core/adapter-prisma'`, then
`prismaAdapter(prisma, { dialect })`. `enqueue` takes a Prisma client (a transaction of its own) or the client of an
interactive transaction. `sqlane.migrate()` works through Prisma too. Prisma 7, with MySQL or PostgreSQL.

On MySQL, the failure job of a failed job is inserted without a savepoint: some drivers (Prisma) cannot run
`SAVEPOINT`. A partial insert is undone; the job still fails without it, as before.
