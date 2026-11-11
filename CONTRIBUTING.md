# Contributing

## Layout

```text
src/        the package @sqlane/core: the queue, the SQL of each dialect, migrations, adapters; unit tests next to the code
types/      its declarations: generated from the JSDoc of src/ (`pnpm build:types`), committed
test/       integration tests (MySQL, MariaDB and PostgreSQL in Docker, testcontainers), type tests, test databases
examples/   usage examples; examples/quickstart: runs with the published package (CI: with the packed one)
bench/      the benchmarks
docs/       api, adapters, comparison, design, benchmarks, cpu-cost, releasing
scripts/    CI scripts
```

`test/mikro-orm-6` has its own `package.json` and lockfile, which install MikroORM 6 for the tests. A separate install
is needed because its drivers take `@mikro-orm/core` as a peer, and an npm alias in the root would give them core 7.
`pnpm install` at the root also installs this folder, through `pnpm:devPreinstall`.

## Setup

You need [mise](https://mise.jdx.dev) and Docker to work on sqlane. mise installs the tools that `mise.toml` lists: Node.js, pnpm, hk, betterleaks, typos, actionlint and zizmor.

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
| `pnpm bench:cpu`    | Measure the [CPU cost per job](docs/cpu-cost.md) vs `main` |

## Commits and changesets

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org). A change of what npm publishes
(`src/`, `types/`, `README.md`, `LICENSE`, `package.json` beyond dev dependencies and scripts) adds a changeset
(`pnpm changeset`); see [releasing](docs/releasing.md).

## Pull requests

- For a larger change, open an issue first, so that we can agree on the approach.
- Run `pnpm check` and `pnpm test` before you push.
- The title of the pull request follows Conventional Commits, because a squash merge uses it as the commit message.
- A change of what npm publishes adds a changeset, as described above.
