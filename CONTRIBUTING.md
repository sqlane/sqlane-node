# Contributing

## Layout

```text
src/        the package @sqlane/core: the queue, the SQL of both dialects, migrations, adapters; unit tests next to the code
types/      its declarations: generated from the JSDoc of src/ (`pnpm build:types`), committed
test/       integration tests (MySQL and PostgreSQL in Docker, testcontainers), type tests, test databases
examples/   usage examples; examples/quickstart: runs with the published package (CI: with the packed one)
bench/      the benchmarks
docs/       design, benchmarks, releasing
scripts/    CI scripts
```

`test/mikro-orm-6` is a package of its own (a pnpm workspace member), as the drivers of MikroORM 7 pin
`@mikro-orm/core` as a peer.

## Setup

Requires [mise](https://mise.jdx.dev) and Docker. mise installs Node.js, pnpm, hk, betterleaks and typos (`mise.toml`).

```sh
mise install
pnpm install
hk install --global --mise   # Git hooks, also for GUI Git clients: lint, format, type check, secrets, typos, Conventional Commits
```

## Commands

| Command             | Does                                                       |
| ------------------- | ---------------------------------------------------------- |
| `pnpm test`         | Run the tests (Vitest)                                     |
| `pnpm lint`         | Lint, including formatting (oxlint, @stylistic)            |
| `pnpm lint:fix`     | Fix lint and formatting                                    |
| `pnpm format`       | Format the other files: JSON, YAML, Markdown, TOML (oxfmt) |
| `pnpm lint:package` | Check the package that npm would publish (publint)         |
| `pnpm typecheck`    | Type-check the JSDoc (`tsc`, no emit)                      |
| `pnpm build:types`  | Generate `types/` from the JSDoc of `src/`                 |
| `pnpm check`        | Run all hook checks on all files (`hk check --all`)        |
| `pnpm bench`        | Run the [benchmarks](docs/benchmarks.md) (Docker)          |

## Commits and changesets

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org). A change of what npm publishes
(`src/`, `types/`, `README.md`, `LICENSE`, `package.json` beyond dev dependencies and scripts) adds a changeset
(`pnpm changeset`); see [releasing](docs/releasing.md).
