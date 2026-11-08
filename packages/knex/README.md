# @sqlane/knex

The [knex](https://knexjs.org) adapter of [`@sqlane/core`](https://www.npmjs.com/package/@sqlane/core): enqueue jobs
in your knex transactions. knex 3 with `mysql2` (MySQL 8.4+) or `pg` (PostgreSQL 15+).

```sh
npm install @sqlane/core @sqlane/knex knex mysql2   # or pg
```

```js
import knexLib from 'knex';
import { createSqlane, defineJob } from '@sqlane/core';
import { knexAdapter } from '@sqlane/knex';

const buildReport = defineJob({ name: 'build_report' });

const knex = knexLib({ client: 'mysql2', connection: process.env.DATABASE_URL });
// The queue's own knex: claims, leases, results. A small pool of its own.
const queueKnex = knexLib({ client: 'mysql2', connection: process.env.DATABASE_URL, pool: { min: 0, max: 3 } });
const sqlane = createSqlane({ adapter: knexAdapter(queueKnex), jobs: [buildReport] });

await sqlane.migrate();

// Producer: the job commits with the transaction, or not at all
await knex.transaction(async (trx) => {
    await trx('reports').insert({ id: reportId });
    await sqlane.enqueue(trx, buildReport, { reportId }, { jobId: reportId });
});

// Or in a transaction of its own
await sqlane.enqueue(knex, buildReport, { reportId });
```

`enqueue` takes a knex instance or a knex transaction, also a nested one (a savepoint): the workers wake after the
commit of the outermost transaction, at once. The SQL of sqlane runs on the driver connection under knex: knex does not
log it, and its query events do not see it.

The worker side is the same as with `@sqlane/core`: see its [README](https://github.com/sqlane/sqlane-node/tree/main/packages/core#readme).

## License

[MIT](LICENSE)
