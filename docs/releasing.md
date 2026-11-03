# Releasing

1. Each pull request that changes the package (`src/`, `package.json`, `README.md`, `LICENSE`) adds a changeset:
   `pnpm changeset`. Its text is the release note.
2. A merge to `main` creates or updates the pull request `chore(release): version packages`.
3. To release: review and merge that pull request.
4. Run the `Release` workflow: `gh workflow run release.yml --ref main` (or Actions → Release → Run workflow).
5. Approve the `npm` deployment in the run. npm shows the version a few minutes later.

Pre-releases: `pnpm changeset pre enter next` (versions `x.y.z-next.N`, npm tag `next`), `pnpm changeset pre exit`.

Test a build in an app without publishing: `pnpm pack`, then `pnpm add /path/to/sqlane-core-<version>.tgz`.
