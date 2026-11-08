# sqlane

Transactional SQL job queue for Node.js, backed by MySQL or PostgreSQL.

> Early version (0.x): the API can still change. See the [design](docs/design.md).

- Enqueue a job in your business transaction: no commit, no job.
- Many job names at low cost: idle names add no load to the database.
- Low latency: a job starts in milliseconds after the commit.
- Mutex keys: jobs with a common key never run at the same time, in the whole cluster.
- MySQL 8.4+ and PostgreSQL 15+, with `mysql2` or `pg`. Node.js 22+. MIT license.

## Packages

| Package                         | Contains                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------- |
| [`@sqlane/core`](packages/core) | The queue, the SQL of both dialects, migrations; adapters for `mysql2` and `pg` |
| [`@sqlane/knex`](packages/knex) | The adapter for knex: enqueue in knex transactions                              |

Docs: [design](docs/design.md), [benchmarks](docs/benchmarks.md), [releasing](docs/releasing.md).

## Development

```text
packages/   the published packages (pnpm workspace)
test/       the test databases of all packages: Docker containers (testcontainers), connections
bench/      the benchmarks
docs/       design, benchmarks, releasing
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
