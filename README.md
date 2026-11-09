# sqlane

Transactional SQL job queue for Node.js, backed by MySQL or PostgreSQL.

> [!WARNING]
> **Not ready for production.** sqlane is in active development (0.x) and not stable yet: the API and the database
> schema can still change in any minor version, and no production deployment has proven it yet. Try it, give feedback,
> but do not run production workloads on it yet. See the [design](docs/design.md).

- Enqueue a job in your business transaction: no commit, no job.
- Many job names at low cost: idle names add no load to the database.
- Low latency: a job starts milliseconds after the commit in the same process, and in other processes with PostgreSQL
  NOTIFY or a `hint` transport. Without them, other processes see it at their next poll (default 5 s). See
  [wake after commit](docs/design.md#wake-after-commit).
- Mutex keys: jobs with a common key do not run at the same time, in the whole cluster, as long as handlers stop on
  their `signal` (lease lost, shutdown). See [guarantees](docs/design.md#guarantees).
- MySQL 8.4+ and PostgreSQL 15+, with mysql2, pg, postgres.js, Knex, Kysely, Drizzle, Prisma, Sequelize, TypeORM or
  MikroORM. Node.js 22+. MIT license.

## Quickstart

Needs Docker and Node.js 22+. On MySQL:

```sh
git clone https://github.com/sqlane/sqlane-node.git
cd sqlane-node/examples/quickstart
npm install
docker compose up --detach --wait mysql
npm run mysql
```

On PostgreSQL: `docker compose up --detach --wait postgres`, then `npm run postgres`. The output (MySQL):

```text
1. Commit: order 1 and its job
   send_receipt of order 1 ran 26 ms after the commit
2. Rollback: order 2 and its job
   rolled back: payment declined
   order 2: 0 rows in orders, 0 jobs
3. Mutex keys: 3 syncs of order 1, 1 sync of order 3
     0 ms  sync of order 1 starts
     0 ms  sync of order 3 starts
   201 ms  sync of order 1 ends
   201 ms  sync of order 3 ends
   227 ms  sync of order 1 starts
   427 ms  sync of order 1 ends
   451 ms  sync of order 1 starts
   653 ms  sync of order 1 ends
   order 1: at most 1 sync at a time; order 3 ran alongside: yes
```

What happened, in [`mysql.js`](examples/quickstart/mysql.js):

1. The order and its `send_receipt` job were inserted in one transaction. The worker, in the same process here, ran
   the job right after the commit.
2. The second transaction threw after its enqueue: the rollback removed the order and the job. No job runs for data
   that does not exist.
3. `sync_order` has the mutex key `order:<id>`: the three syncs of order 1 ran one after another, the sync of order 3
   alongside the first.

Down: `docker compose down --volumes`.

## Install

```sh
npm install @sqlane/core mysql2   # or pg, postgres (postgres.js); or the adapter of your ORM
```

The [package README](packages/core/README.md) has the usage in an app, the adapters (mysql2, pg, postgres.js, Knex,
Kysely, Drizzle, Prisma, Sequelize, TypeORM, MikroORM) and the performance.

## Guarantees and limits

- **At least once.** A committed job runs at least once, also after a crash; it can run twice. Handlers must be
  idempotent.
- **Mutex keys** hold while handlers stop on their `signal` (timeout, lease lost, shutdown).
- **Not included:** cron, priorities, a dashboard, workflows, a cluster-wide concurrency limit per job name. MariaDB
  and SQLite.
- **Supported:** Node.js 22.12+, MySQL 8.4+, PostgreSQL 15+.

The details: [design](docs/design.md) (guarantees, leases, wake-up, schema), [benchmarks](docs/benchmarks.md).

## Development

```text
packages/   the published packages (pnpm workspace)
test/       the test databases of all packages: Docker containers (testcontainers), connections
bench/      the benchmarks
docs/       design, benchmarks, releasing
examples/   the quickstart: runs with the published package (CI: with the packed one)
```

Requires [mise](https://mise.jdx.dev). It installs Node.js, pnpm, hk, betterleaks and typos (`mise.toml`).

```sh
mise install
pnpm install
hk install --global --mise   # Git hooks, also for GUI Git clients: lint, format, type check, secrets, typos, Conventional Commits
```

| Command             | Does                                                       |
| ------------------- | ---------------------------------------------------------- |
| `pnpm test`         | Run the tests (Vitest)                                     |
| `pnpm lint`         | Lint, including formatting (oxlint, @stylistic)            |
| `pnpm lint:fix`     | Fix lint and formatting                                    |
| `pnpm format`       | Format the other files: JSON, YAML, Markdown, TOML (oxfmt) |
| `pnpm lint:package` | Check the packages that npm would publish (publint)        |
| `pnpm typecheck`    | Type-check the JSDoc (`tsc`, no emit)                      |
| `pnpm check`        | Run all hook checks on all files (`hk check --all`)        |
| `pnpm bench`        | Run the [benchmarks](docs/benchmarks.md) (Docker)          |

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org). A change of a package adds a
changeset (`pnpm changeset`); see [releasing](docs/releasing.md).

## License

[MIT](LICENSE)
