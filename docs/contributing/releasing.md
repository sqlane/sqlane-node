# Releasing

1. Each pull request that changes what the package publishes (`src/` without the tests, `types/`, `package.json`
   without `devDependencies` and `scripts`, `README.md`, `LICENSE`) adds a changeset: `pnpm changeset`. Its text is
   the release note.
2. A merge to `main` creates or updates the pull request `chore(release): version packages`.
3. To release: review and merge that pull request.
4. Run the `Release` workflow: `gh workflow run release.yml --ref main` (or Actions → Release → Run workflow).
5. Approve the `npm` deployment in the run. npm shows the version a few minutes later.

A merge to `main` requires the CI checks: Checks, Changeset, Quickstart, Conventional Commits and the tests on each
Node.js version. GitHub runs no workflow on a pull request that the default `GITHUB_TOKEN` opens, so the release
workflow opens it with the token of a GitHub App:

- The app has the repository permissions Contents and Pull requests (read and write), and is installed on this
  repository only.
- The repository variable `RELEASE_APP_CLIENT_ID` holds its client ID, and the secret `RELEASE_APP_PRIVATE_KEY` a
  private key of it.

Pre-releases: `pnpm changeset pre enter next` (versions `x.y.z-next.N`, npm tag `next`), `pnpm changeset pre exit`.

Test a build in an app without publishing: `pnpm pack` at the root, then `pnpm add /path/to/sqlane-core-<version>.tgz`.
Or the preview of a pull request on pkg.pr.new (its comment has the install command).
