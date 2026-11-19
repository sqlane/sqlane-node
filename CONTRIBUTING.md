# Contributing

## Layout

```text
src/        the package @sqlane/core: the queue, the SQL of each dialect, migrations, adapters; unit tests next to the code
types/      its declarations: generated from the JSDoc of src/ and from src/sqlane.ts (`pnpm build:types`), committed
test/       integration tests (MySQL, MariaDB and PostgreSQL in Docker, testcontainers), type tests, test databases;
            test/package_smoke: the packed package, installed and run as an app would (CI job package_smoke)
examples/   usage examples
bench/      the benchmarks: regression/ (sqlane alone), compare/ (with other queues)
docs/       user docs: api, adapters, design, features and performance vs other libs, performance results, migrations
docs/contributing/  maintainer docs: benchmarks, releasing
scripts/    CI scripts
```

`test/mikro_orm_6` has its own `package.json` and lockfile, which install MikroORM 6 for the tests. A separate install
is needed because its drivers take `@mikro-orm/core` as a peer, and an npm alias in the root would give them core 7.
`pnpm install` at the root also installs this folder, through `pnpm:devPreinstall`.

The public types are what editors show on hover, so each of them says what it is. `src/types.js` holds the typedefs:
lint requires a description for each of their fields. `src/sqlane.ts` holds the interface of an instance, the one
TypeScript file: `scripts/check_api_docs.js` requires a description, `@param` texts and a `@returns` text for each
method. It is type-only, and npm gets its declarations, not the file.

File and folder names are snake_case. ls-lint checks them, with the exceptions in `.ls-lint.yml`: names that tools
or conventions set, such as `README.md` and lockfiles.

## Setup

You need [mise](https://mise.jdx.dev) and Docker to work on sqlane. mise installs the tools that `mise.toml` lists: Node.js, pnpm, hk, betterleaks, typos, actionlint, zizmor and ls-lint.

```sh
mise install
pnpm install
hk install --global --mise   # Git hooks, also for GUI Git clients: lint, format, type check, secrets, typos, file names, Conventional Commits
```

## Commands

| Command                    | Does                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                | Run the tests (Vitest)                                                                                                  |
| `pnpm lint`                | Lint, including formatting (oxlint, @stylistic)                                                                         |
| `pnpm lint:fix`            | Fix lint and formatting                                                                                                 |
| `pnpm format`              | Format the other files: JSON, YAML, Markdown, TOML (oxfmt)                                                              |
| `pnpm lint:package`        | Check the package that npm would publish (publint)                                                                      |
| `pnpm typecheck`           | Type-check the JSDoc (`tsc`, no emit)                                                                                   |
| `pnpm build:types`         | Generate `types/` from the JSDoc of `src/`, and from `src/sqlane.ts`                                                    |
| `pnpm check`               | Run all hook checks on all files (`hk check --all`)                                                                     |
| `pnpm bench:statements`    | Check the statements of the hot paths on each database ([benchmarks](docs/contributing/benchmarks.md))                  |
| `pnpm bench:regression`    | Compare the CPU cost and statements of the working tree with `main`                                                     |
| `pnpm bench:vs-other-libs` | Compare with other queues: [features](docs/features_vs_other_libs.md), [performance](docs/performance_vs_other_libs.md) |
| `pnpm bench:generate-docs` | Generate the performance page's charts and tables from the results                                                      |

## Commits and changesets

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org). A change of what npm publishes
(`src/`, `types/`, `README.md`, `LICENSE`, `package.json` beyond dev dependencies and scripts) adds a changeset
(`pnpm changeset`); see [releasing](docs/contributing/releasing.md).

## Pull requests

- For a larger change, open an issue first, so that we can agree on the approach.
- Run `pnpm check` and `pnpm test` before you push.
- The title of the pull request follows Conventional Commits, because a squash merge uses it as the commit message.
- A change of what npm publishes adds a changeset, as described above.
