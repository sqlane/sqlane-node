# Releasing

1. Each pull request that changes what a package publishes (its `src/` without the tests, `package.json` without
   `devDependencies`, `README.md`, `LICENSE`) adds a changeset: `pnpm changeset`. Its text is the release note. The
   packages are in one fixed group: they release together, with one version.
2. A merge to `main` creates or updates the pull request `chore(release): version packages`.
3. To release: review and merge that pull request.
4. Run the `Release` workflow: `gh workflow run release.yml --ref main` (or Actions → Release → Run workflow).
5. Approve the `npm` deployment in the run. npm shows the version a few minutes later.

Pre-releases: `pnpm changeset pre enter next` (versions `x.y.z-next.N`, npm tag `next`), `pnpm changeset pre exit`.

Test a build in an app without publishing: `pnpm pack` in `packages/<name>`, then
`pnpm add /path/to/sqlane-<name>-<version>.tgz`.

A new package: publish a placeholder version by hand once (`0.0.0-stage`, `npm publish --tag stage`), then add the
trusted publisher on npmjs.com (repository `sqlane/sqlane-node`, workflow `release.yml`, environment `npm`), and add the
package to the `fixed` group of `.changeset/config.json`.
