# sqlane

Transactional SQL job queue for Node.js, backed by MySQL or PostgreSQL.

> Work in progress. Not published yet.

## Goals

- Enqueue a job in your business transaction: no commit, no job.
- Many queues at low cost: idle queues add no load to the database.
- Low latency: a job starts in milliseconds after the commit.
- MySQL and PostgreSQL.
- MIT license.

## License

[MIT](LICENSE)
