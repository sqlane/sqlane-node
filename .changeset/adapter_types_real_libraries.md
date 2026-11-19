---
'@sqlane/core': patch
---

TypeScript: the Drizzle, postgres.js and Sequelize adapters accept the objects of their libraries without a cast. A
Drizzle database or transaction no longer fails on a `session` property that Drizzle's types don't declare; a
postgres.js `sql` or transaction no longer fails on the parameters of `unsafe`; a Sequelize instance or transaction no
longer fails on `connectionManager.getConnection`, `connection` or `afterCommit`. A new type test checks every adapter,
except Prisma, against its library's own types.
