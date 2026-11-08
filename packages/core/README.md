# @sqlane/core

Transactional SQL job queue for Node.js, backed by MySQL or PostgreSQL.

> Early version (0.x): the API can still change. See the [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md).

- Enqueue a job in your business transaction: no commit, no job.
- Many job names at low cost: idle names add no load to the database.
- Low latency: a job starts in milliseconds after the commit.
- Mutex keys: jobs with a common key never run at the same time, in the whole cluster.
- MySQL 8.4+ and PostgreSQL 15+, with `mysql2` or `pg`. Node.js 22+. MIT license.

## Usage

```sh
npm install @sqlane/core mysql2   # or pg
```

```js
import mysql from 'mysql2/promise';
import { createSqlane, defineJob } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/mysql2'; // or pgAdapter from '@sqlane/core/pg'

// Shared by producers and workers
export const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h' },
});

const queuePool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 3 });
const sqlane = createSqlane({ adapter: mysql2Adapter(queuePool), jobs: [buildReport] });

await sqlane.migrate(); // or getMigrations({ dialect: 'mysql' }) for your own migration tool

// Producer: with the connection of your transaction
await connection.beginTransaction();
await connection.query('INSERT INTO reports (id) VALUES (?)', [reportId]);
await sqlane.enqueue(connection, buildReport, { reportId }, { jobId: reportId });
await connection.commit();

// Worker
sqlane.handle(buildReport, async ({ payload, signal }) => {
    await build(payload.reportId, { signal });
}, { concurrency: 2, timeout: '5m' });
await sqlane.start();

process.once('SIGTERM', () => sqlane.close({ deadline: '30s' }));
```

In tests, run the due jobs without `start()`: `await sqlane.drain()`. More in [`examples/`](https://github.com/sqlane/sqlane-node/tree/main/packages/core/examples).

## Performance

On a laptop (M1 Pro, Docker, default config), details in [benchmarks](https://github.com/sqlane/sqlane-node/blob/main/docs/benchmarks.md):

- 1000 handled job names, 10 with pending jobs: the probe takes under 1 ms. Idle names cost nothing.
- From commit to handler start: about 25 ms (re-probe or hint), about 5 ms with PostgreSQL NOTIFY.
- `enqueueMany`: 58,000–110,000 jobs/s. Empty jobs, one process: 1,000–1,800 jobs/s at concurrency 10,
  3,800–5,800 at concurrency 50.

## License

[MIT](LICENSE)
