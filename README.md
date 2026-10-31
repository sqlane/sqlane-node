# sqlane

Transactional SQL job queue for Node.js, backed by MySQL or PostgreSQL.

> Work in progress: this version is a name placeholder, with no code yet. See the [design](docs/design.md).

## Goals

- Enqueue a job in your business transaction: no commit, no job.
- Many queues at low cost: idle queues add no load to the database.
- Low latency: a job starts in milliseconds after the commit.
- MySQL and PostgreSQL.
- MIT license.

## Development

Requires [mise](https://mise.jdx.dev). It installs Node.js, pnpm, hk, betterleaks and typos (`mise.toml`).

```sh
mise install
pnpm install
hk install --global --mise   # Git hooks, also for GUI Git clients: lint, format, type check, secrets, typos, Conventional Commits
```

| Command          | Does                                                       |
| ---------------- | ---------------------------------------------------------- |
| `pnpm test`      | Run the tests (Vitest)                                     |
| `pnpm lint`      | Lint, including formatting (oxlint, @stylistic)            |
| `pnpm lint:fix`  | Fix lint and formatting                                    |
| `pnpm format`    | Format the other files: JSON, YAML, Markdown, TOML (oxfmt) |
| `pnpm typecheck` | Type-check the JSDoc (`tsc`, no emit)                      |
| `pnpm check`     | Run all hook checks on all files (`hk check --all`)        |

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).

## License

[MIT](LICENSE)
